// Media end to end (SPEC "Media"): optchat-server as a process with a fake `claude`. A photo is
// PUT to /api/assets behind the same guard as every route, then sent in a message over /ws as an
// AG-UI image part naming "asset:<sha>". The caption call and the turn's claude both get the
// picture as a stream-json image block; the log gets the text and a marker with the caption; zoom
// on the message answers with the picture over MCP, over HTTP and over a WebSocket alike.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { type Inbound, parseInbound } from "../cli/repl.ts";
import { Asset, MessagesPage, shortSha } from "../src/wire.ts";

const ROOT = `${import.meta.dir}/../`;
const dir = mkdtempSync(`${tmpdir()}/odj-media-`);
const port = 20_000 + Math.floor(Math.random() * 20_000);
const base = `http://127.0.0.1:${port}`;
const env = {
  ...Bun.env,
  FAKE_CLAUDE_LOG: `${dir}/fake.jsonl`,
  FAKE_CLAUDE_SCRIPT: `${dir}/plan.json`,
  OPTCHAT_CLAUDE: `${ROOT}test/fake-claude.ts`,
  OPTCHAT_CONFIG: `${dir}/optchat.config.ts`,
  OPTCHAT_HOME: `${dir}/home`,
};
let server: Bun.Subprocess<"ignore", "pipe", "pipe">;

beforeAll(async () => {
  writeFileSync(env.FAKE_CLAUDE_SCRIPT, JSON.stringify({ caption: [[{ text: "a [red] square on white" }]], turn: [[{ text: "I see a red square." }]] }));
  const settings = {
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    compactor: { byLevel: [{ from: 0, chain: ["claude-code:sonnet"] }], effort: "medium" },
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    devices: { mini: { url: "http://127.0.0.1:1", folders: [dir] } },
    defaultDevice: "mini",
    allowedLogins: [],
    server: { host: "127.0.0.1", port },
  };
  writeFileSync(env.OPTCHAT_CONFIG, `export default ${JSON.stringify(settings)};\n`);
  server = Bun.spawn(["bun", `${ROOT}server/main.ts`], { env, stderr: "pipe", stdout: "pipe" });
  for (let k = 0; k < 100; k++) {
    const up = await fetch(`${base}/api/state`).then(
      (r) => r.ok,
      () => false,
    );
    if (up) return;
    await Bun.sleep(100);
  }
  throw new Error(`the server did not start: ${await new Response(server.stderr).text()}`);
});

afterAll(async () => {
  server.kill("SIGTERM");
  await server.exited;
  rmSync(dir, { force: true, recursive: true });
});

// what the fake claude recorded: each start with its role, each message it read
const Record = Schema.Struct({ type: Schema.String, pid: Schema.Number, role: Schema.optional(Schema.String), argv: Schema.optional(Schema.Array(Schema.String)), content: Schema.optional(Schema.Json) });
const records = () =>
  readFileSync(env.FAKE_CLAUDE_LOG, "utf8")
    .split("\n")
    .flatMap((line) => Option.toArray(Schema.decodeUnknownOption(Schema.fromJsonString(Record))(line)));
const inputsOf = (role: string) => {
  const all = records();
  const pids = new Set(all.filter((r) => r.type === "start" && r.role === role).map((r) => r.pid));
  return all.filter((r) => r.type === "in" && pids.has(r.pid)).map((r) => r.content);
};
const Blocks = Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String), source: Schema.optional(Schema.Struct({ type: Schema.String, media_type: Schema.String, data: Schema.String })) }));
const blocksOf = Schema.decodeUnknownSync(Blocks);

const put = async (body: Uint8Array | string, headers: Record<string, string> = {}) => fetch(`${base}/api/assets`, { body, headers, method: "PUT" });

const until = async (what: string, ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

test("a photo PUT, sent as an image part: caption and turn see it, the log keeps a marker, zoom shows it again over HTTP and WS", async () => {
  // a 2000x1000 photo with a camera name in its EXIF
  const photo = await sharp({ create: { background: "#e33", channels: 3, height: 1000, width: 2000 } })
    .jpeg()
    .withExif({ IFD0: { Make: "PhoneCo" } })
    .toBuffer();
  // the guard: another site's page can't upload
  const foreign = await put(new Uint8Array(photo), { origin: "https://evil.example" });
  expect(foreign.status).toBe(403);
  // a script named like a photo is refused for what it is
  const script = await put("#!/bin/sh\necho hi\n", { "content-type": "image/png" });
  expect(script.status).toBe(415);

  const res = await put(new Uint8Array(photo), { "content-type": "image/jpeg" });
  expect(res.status).toBe(200);
  const asset = Schema.decodeUnknownSync(Asset)(await res.json());
  expect(asset).toMatchObject({ height: 784, kind: "image", mime: "image/jpeg", width: 1568 });
  const got = await fetch(`${base}/api/assets/${asset.sha}`);
  const stored = new Uint8Array(await got.arrayBuffer());
  expect(Buffer.from(stored).includes("PhoneCo")).toBe(false);
  const thumb = await fetch(`${base}/api/assets/${shortSha(asset.sha)}/thumb`);
  expect(thumb.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await thumb.arrayBuffer())).toEqual(stored);
  // a path that climbs (encoded, so it stays one segment), a prefix of nothing, not hex
  for (const path of ["..%2F..%2Fetc%2Fpasswd", "abcdefabcdef", "zzzzzzzzzzzz"]) {
    const missing = await fetch(`${base}/api/assets/${path}`);
    expect(missing.status).toBe(404);
  }

  // the message: text and the picture, by digest only
  const events: Inbound[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.addEventListener("message", (m) => {
    for (const e of Option.toArray(parseInbound(String(m.data)))) events.push(e);
  });
  await new Promise((resolve) => {
    ws.addEventListener("open", resolve);
  });
  const content = [
    { text: "what is this?", type: "text" },
    { source: { mimeType: "image/jpeg", type: "url", value: `asset:${asset.sha}` }, type: "image" },
    { source: { type: "url", value: `asset:${"0".repeat(64)}` }, type: "image" },
  ];
  ws.send(JSON.stringify({ messages: [{ content, id: "m1", role: "user" }], runId: "r1", threadId: "t" }));
  await until("the run's end", () => events.some((e) => e.type === "RUN_FINISHED"));
  ws.close();
  expect(events.some((e) => e.type === "CUSTOM" && e.name === "info" && e.value === "image 000000000000 is not on the server: left out of the message")).toBe(true);

  const messages = await fetch(`${base}/api/messages`);
  const page = Schema.decodeUnknownSync(MessagesPage)(await messages.json());
  const marker = `[image ${shortSha(asset.sha)} 1568x784 ${Math.round(asset.bytes / 1024)}KB: a (red) square on white]`;
  expect(page.entries.map((e) => [e.kind, e.text])).toEqual([
    ["user", `what is this?\n${marker}`],
    ["talk", "I see a red square."],
  ]);

  // the caption call and the turn got the picture as an image block
  const picture = { data: Buffer.from(stored).toString("base64"), media_type: "image/jpeg", type: "base64" };
  const [captioned] = inputsOf("caption").map((c) => blocksOf(c));
  expect(captioned?.[0]).toEqual({ source: picture, type: "image" });
  const [opening] = inputsOf("turn").map((c) => blocksOf(c));
  const image = opening?.findIndex((b) => b.type === "image") ?? -1;
  expect(opening?.[image]).toEqual({ source: picture, type: "image" });
  // after the view, before the message's text with its marker
  expect(opening?.[image + 1]?.text).toBe(`what is this?\n${marker}`);

  // zoom(0, 1): the message's text, then its picture, over HTTP and over a WebSocket
  const turn = records().find((r) => r.type === "start" && r.role === "turn");
  const config = turn?.argv?.[turn.argv.indexOf("--mcp-config") + 1] ?? "";
  const { url } = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Struct({ mcpServers: Schema.Struct({ optchat: Schema.Struct({ url: Schema.String }) }) })))(config).mcpServers.optchat;
  const call = JSON.stringify({ id: 7, jsonrpc: "2.0", method: "tools/call", params: { arguments: { id: 0, n: 1 }, name: "zoom" } });
  const Reply = Schema.fromJsonString(Schema.Struct({ result: Schema.Struct({ content: Schema.Array(Schema.Record(Schema.String, Schema.String)) }) }));
  const expected: readonly Record<string, string>[] = [
    { text: `0+0|user: what is this?\n${marker}`, type: "text" },
    { data: picture.data, mimeType: "image/jpeg", type: "image" },
  ];
  const overHttp = await fetch(url.replace(/^ws/, "http"), { body: call, headers: { "content-type": "application/json" }, method: "POST" });
  expect(Schema.decodeUnknownSync(Reply)(await overHttp.text()).result.content).toEqual(expected);
  const mcp = new WebSocket(url, "mcp");
  const answered = new Promise<string>((resolve) => {
    mcp.addEventListener("message", (m) => {
      resolve(String(m.data));
    });
  });
  await new Promise((resolve) => {
    mcp.addEventListener("open", resolve);
  });
  mcp.send(call);
  expect(Schema.decodeUnknownSync(Reply)(await answered).result.content).toEqual(expected);
  mcp.close();
  // a reply has no pictures
  const talk = JSON.stringify({ id: 8, jsonrpc: "2.0", method: "tools/call", params: { arguments: { id: 1, n: 1 }, name: "zoom" } });
  const plain = await fetch(url.replace(/^ws/, "http"), { body: talk, method: "POST" });
  const only: readonly Record<string, string>[] = [{ text: "1+0|talk: I see a red square.", type: "text" }];
  expect(Schema.decodeUnknownSync(Reply)(await plain.text()).result.content).toEqual(only);
});

// the guard is the same one every route has (server/auth.ts): a page on another site, a rebound
// hostname, or a login that is not on the list can neither store an asset nor read one
test("PUT and GET /api/assets are refused for a foreign Origin, a Host that is not ours and a login not on the list", async () => {
  const mine = await sharp({ create: { background: "#3a3", channels: 3, height: 40, width: 60 } }).png().toBuffer();
  const theirs = await sharp({ create: { background: "#a33", channels: 3, height: 41, width: 61 } }).png().toBuffer();
  const first = await put(new Uint8Array(mine));
  const stored = Schema.decodeUnknownSync(Asset)(await first.json());
  const before = held();
  const refusals: [string, Record<string, string>][] = [
    ["a foreign Origin", { origin: "https://evil.example" }],
    ["an Origin of null", { origin: "null" }],
    ["a Host that is not ours", { host: `rebound.example:${port}` }],
    ["a login not on the list", { "tailscale-user-login": "stranger@example.com" }],
  ];
  for (const [what, headers] of refusals) {
    const upload = await put(new Uint8Array(theirs), headers);
    expect([what, upload.status]).toEqual([what, 403]);
    for (const path of [stored.sha, `${shortSha(stored.sha)}/thumb`]) {
      const read = await fetch(`${base}/api/assets/${path}`, { headers });
      expect([what, path, read.status]).toEqual([what, path, 403]);
    }
  }
  // none of the refused uploads stored anything; the same one from a caller let in does
  expect(held()).toBe(before);
  const allowed = await put(new Uint8Array(theirs));
  expect(allowed.status).toBe(200);
  expect(held()).toBeGreaterThan(before);
});

// how many files the asset store holds
const held = () => readdirSync(`${env.OPTCHAT_HOME}/assets`, { recursive: true }).length;

test("a video is served in ranges: 206 with its Content-Range, 416 past its end, the whole file for a range it does not answer", async () => {
  const clip = `${dir}/range.mp4`;
  const made = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x240:rate=10", "-an", "-c:v", "mpeg4", clip]);
  expect(made.exitCode).toBe(0);
  const res = await put(new Uint8Array(readFileSync(clip)));
  expect(res.status).toBe(200);
  const video = Schema.decodeUnknownSync(Asset)(await res.json());
  const url = `${base}/api/assets/${video.sha}`;
  const whole = await fetch(url);
  const all = new Uint8Array(await whole.arrayBuffer());
  expect(whole.status).toBe(200);
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  expect(whole.headers.get("content-type")).toBe("video/mp4");
  expect(all.length).toBe(video.bytes);

  const ranged = async (range: string) => {
    const r = await fetch(url, { headers: { range } });
    return { body: new Uint8Array(await r.arrayBuffer()), length: r.headers.get("content-length"), range: r.headers.get("content-range"), status: r.status, type: r.headers.get("content-type") };
  };
  // Safari asks for the first two bytes, then the rest, then the tail
  const first = await ranged("bytes=0-1");
  expect(first).toMatchObject({ length: "2", range: `bytes 0-1/${all.length}`, status: 206, type: "video/mp4" });
  expect(first.body).toEqual(all.slice(0, 2));
  const rest = await ranged("bytes=2-");
  expect(rest).toMatchObject({ range: `bytes 2-${all.length - 1}/${all.length}`, status: 206 });
  expect(rest.body).toEqual(all.slice(2));
  const tail = await ranged("bytes=-100");
  expect(tail).toMatchObject({ length: "100", range: `bytes ${all.length - 100}-${all.length - 1}/${all.length}`, status: 206 });
  expect(tail.body).toEqual(all.slice(-100));
  // an end past the file is cut to it
  const cut = await ranged(`bytes=${all.length - 10}-${all.length + 500}`);
  expect(cut.body).toEqual(all.slice(-10));
  // past the end, nothing to give
  const past = await ranged(`bytes=${all.length}-`);
  expect(past).toMatchObject({ range: `bytes */${all.length}`, status: 416 });
  // several ranges, another unit, or nonsense: the whole file, as the standard allows
  for (const odd of ["bytes=0-1,5-6", "items=0-1", "bytes=9-3", "bytes=-"]) {
    const r = await ranged(odd);
    expect([odd, r.status, r.body.length]).toEqual([odd, 200, all.length]);
  }
  // the thumbnail of a video is its sheet: an image, in ranges as well
  const sheet = await fetch(`${url}/thumb`, { headers: { range: "bytes=0-9" } });
  expect(sheet.status).toBe(206);
  expect(sheet.headers.get("content-type")).toBe("image/jpeg");
});
