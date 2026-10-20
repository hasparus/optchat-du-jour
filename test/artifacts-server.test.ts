// From fx0 tests/route-security.test.mjs, the artifact routes' part (Apache-2.0, © Vercel, modified).
// Artifacts end to end (SPEC "Artifacts", E31): optchat-server as a process with the fake `claude`,
// whose master publishes, edits and reads an artifact over /mcp as a real one would. The log keeps
// stubs, never the HTML; /api/artifacts lists the versions with the calls that made them; the
// routes send exactly their headers, answer only past the guard, 404 an unknown or malformed name
// or version, and never reach outside the artifacts; a subagent publishes, edits and reads over its own key, as the master does (E36).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ARTIFACT_EMBEDDED_CSP } from "../src/artifacts/html.ts";
import { ArtifactList, kb, savedVersion, SubagentLog } from "../src/wire.ts";
import { freePort } from "./ports.ts";

const ROOT = `${import.meta.dir}/../`;
const FAKE = `${ROOT}test/fake-claude.ts`;

const dir = mkdtempSync(`${tmpdir()}/odj-art-`);
const port = freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  ...Bun.env,
  FAKE_CLAUDE_LOG: `${dir}/fake.jsonl`,
  FAKE_CLAUDE_SCRIPT: `${dir}/plan.json`,
  OPTCHAT_CLAUDE: FAKE,
  OPTCHAT_CONFIG: `${dir}/optchat.config.ts`,
  OPTCHAT_HOME: `${dir}/home`,
  OPTCHAT_URL: base,
};
let server: Bun.Subprocess<"ignore", "pipe", "pipe">;

const V1 = `<!doctype html><html><head><title>Landing</title></head><body><h1>Hello</h1><p>${"MARKUP-NOT-IN-LOG ".repeat(200)}</p></body></html>`;

const SIZE = kb(Buffer.byteLength(V1));
const NOTES = `<!doctype html><html><head><title>Notes</title></head><body><h1>Notes</h1><p>${"SUBAGENT-MARKUP ".repeat(100)}</p></body></html>`;

beforeAll(async () => {
  const script = {
    // the subagent publishes a page of its own, edits it and reads the master's, over its own key
    subagent: {
      maker: [
        { mcp: { input: { html: NOTES, name: "notes" }, name: "publish_artifact" } },
        { mcp: { input: { edits: [{ new: "<h1>Trip notes</h1>", old: "<h1>Notes</h1>" }], name: "notes" }, name: "edit_artifact" } },
        { mcp: { input: { name: "landing", version: 2 }, name: "read_artifact" } },
        { text: "made it" },
      ],
    },
    // keyed by a word of the message each test sends, not by the order claude processes start in:
    // a warm process starts ahead of its turn (E18), so that order is not the order of the turns
    turn: {
      "landing page": [{ mcp: { input: { html: V1, name: "landing" }, name: "publish_artifact" } }, { text: "published" }],
      "hi there": [{ mcp: { input: { edits: [{ new: "<h1>Hi there</h1>", old: "<h1>Hello</h1>" }], name: "landing" }, name: "edit_artifact" } }, { text: "edited" }],
      "first version": [{ mcp: { input: { name: "landing", version: 1 }, name: "read_artifact" } }, { text: "read" }],
      "break it": [{ mcp: { input: { html: "<p>not a page</p>", name: "landing" }, name: "publish_artifact" } }, { text: "rejected" }],
      "spawn a maker": [{ mcp: { input: { name: "maker", task: "Make a page of trip notes." }, name: "spawn" } }, { text: "spawned" }],
      "*": [{ text: "ok" }],
    },
  };
  writeFileSync(env.FAKE_CLAUDE_SCRIPT, JSON.stringify(script));
  const settings = {
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    compactor: { byLevel: [{ from: 0, chain: ["claude-code:sonnet"] }], effort: "medium" },
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    devices: { mini: { url: "http://127.0.0.1:1", folders: [dir] } },
    defaultDevice: "mini",
    allowedLogins: ["me@example.com"],
    server: { host: "127.0.0.1", port, mcpTransport: "http" },
  };
  writeFileSync(env.OPTCHAT_CONFIG, `export default ${JSON.stringify(settings)};\n`);
  server = Bun.spawn(["bun", `${ROOT}cli/optchat.ts`, "server"], { env, stderr: "pipe", stdout: "pipe" });
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

const eventually = async (what: string, ok: () => Promise<boolean> | boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};
const Entries = Schema.Struct({ entries: Schema.Array(Schema.Struct({ i: Schema.Number, kind: Schema.String, text: Schema.String, error: Schema.optional(Schema.Boolean) })) });
const State = Schema.Struct({ phase: Schema.String });
// a JSON body from the server, decoded
const json = async <A>(schema: Schema.Decoder<A>, path: string) => {
  const res = await fetch(`${base}${path}`);
  const body: unknown = await res.json();
  return Schema.decodeUnknownSync(schema)(body);
};
const messages = async () => {
  const { entries } = await json(Entries, "/api/messages?limit=500");
  return entries;
};
const list = async () => {
  const { artifacts } = await json(ArtifactList, "/api/artifacts");
  return artifacts;
};
const idle = async () => {
  const { phase } = await json(State, "/api/state");
  return phase === "idle";
};
const status = async (path: string, headers: Readonly<Record<string, string>> = {}) => {
  const res = await fetch(`${base}${path}`, { headers });
  return res.status;
};
// what a browser says when it loads a frame (Fetch Metadata)
const FRAME = { "sec-fetch-dest": "iframe" } as const;
// every file of a folder, as one text
const all = (folder: string) => readdirSync(folder).map((f) => readFileSync(`${folder}/${f}`, "utf8")).join("");

let socket: WebSocket | null = null;
const frames: string[] = [];
const say = async (text: string, id: string) => {
  if (socket === null) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.addEventListener("message", (m) => {
      frames.push(String(m.data));
    });
    await new Promise((resolve) => {
      ws.addEventListener("open", resolve);
    });
    socket = ws;
  }
  const { length: before } = await messages();
  socket.send(JSON.stringify({ messages: [{ content: text, id, role: "user" }], runId: id, threadId: "t" }));
  await eventually(`the turn for ${id}`, async () => {
    const now = await messages();
    return now.length >= before + 4 && (await idle());
  });
};

const Start = Schema.Struct({ type: Schema.Literal("start"), role: Schema.String, argv: Schema.Array(Schema.String) });
const decodeStart = Schema.decodeUnknownOption(Schema.fromJsonString(Start));
const flag = (argv: readonly string[], name: string) => argv[argv.indexOf(name) + 1];

test("the master publishes, edits and reads by version over /mcp; the log keeps stubs only; drafts stream", async () => {
  await say("make me a landing page", "m1");
  let chat = await messages();
  expect(chat.map((e) => e.kind)).toEqual(["user", "tool", "echo", "talk"]);
  expect(chat[1]?.text).toBe(`mcp__optchat__publish_artifact {"html":"<${SIZE} of HTML, not kept in the log: read_artifact>","name":"landing"}`);
  expect(chat[2]?.text).toBe(`Published landing (${SIZE}) [v1]`);
  // the draft went out as the input streamed, as CUSTOM artifact-draft frames, and the version
  const drafts = frames.filter((f) => f.includes('"name":"artifact-draft"'));
  expect(drafts.length).toBeGreaterThan(0);
  expect(drafts.at(-1)).toContain('"closed":true');
  expect(frames.some((f) => f.includes('"name":"artifact"') && f.includes('"v":1'))).toBe(true);

  await say("say hi there instead", "m2");
  await say("show me the first version", "m3");
  chat = await messages();
  const echoes = chat.filter((e) => e.kind === "echo").map((e) => e.text);
  expect(echoes[1]).toBe(`Edited landing (${kb(Buffer.byteLength(V1) + 5)}) [v2]`);
  expect(echoes[2]).toMatch(new RegExp(`^landing v1 of 2 \\(${SIZE}, [\\d-]+ [\\d:]+\\):\\n<${SIZE} not kept in the log: read_artifact again>$`));

  // a page the validator refuses comes back as a tool error the model can fix
  await say("break it", "m4");
  chat = await messages();
  expect(chat.at(-2)).toMatchObject({ error: true, kind: "echo", text: "publish_artifact: artifact must start with <!doctype html>" });

  // the versions, and each call's echo naming the one it saved (the only record of it)
  const [landing] = await list();
  expect(landing?.name).toBe("landing");
  expect(landing?.versions.map((v) => [v.v, v.by])).toEqual([
    [1, "publish"],
    [2, "edit"],
  ]);
  expect(echoes.slice(0, 2).map(savedVersion)).toEqual([1, 2]);
  // the main log and the tree hold none of the HTML; the artifact's folder holds all of it
  const stream = `${env.OPTCHAT_HOME}/streams/mini`;
  expect(all(`${stream}/chat/main`)).not.toContain("MARKUP-NOT-IN-LOG");
  expect(all(`${stream}/chat/tree`)).not.toContain("MARKUP-NOT-IN-LOG");
  expect(readFileSync(`${stream}/artifacts/landing/v1.html`, "utf8")).toBe(V1);
  expect(readFileSync(`${stream}/artifacts/landing/v2.html`, "utf8")).toBe(V1.replace("<h1>Hello</h1>", "<h1>Hi there</h1>"));
}, 60_000);

test("a subagent publishes and edits a page of its own and reads the master's, over its own key (E36)", async () => {
  await say("spawn a maker", "m5");
  await eventually("the maker's report", async () => {
    const now = await messages();
    return now.some((e) => e.text.startsWith("[maker] "));
  });
  const sub = readFileSync(env.FAKE_CLAUDE_LOG, "utf8")
    .split("\n")
    .flatMap((line) => Option.toArray(decodeStart(line)))
    .find((s) => s.role === "subagent");
  // the master's permission level, no read-only allowlist
  expect(sub?.argv).not.toContain("--allowedTools");
  expect(flag(sub?.argv ?? [], "--permission-mode")).toBe("bypassPermissions");
  const made = await list();
  const notes = made.find((a) => a.name === "notes");
  expect(notes?.versions.map((v) => [v.v, v.by])).toEqual([
    [1, "publish"],
    [2, "edit"],
  ]);
  expect(readFileSync(`${env.OPTCHAT_HOME}/streams/mini/artifacts/notes/v2.html`, "utf8")).toBe(NOTES.replace("<h1>Notes</h1>", "<h1>Trip notes</h1>"));
  // its side log keeps the stubs too: no page in it, either its own or the one it read
  const { entries } = await json(SubagentLog, "/api/subagent?name=maker");
  const echoes = entries.filter((e) => e.kind === "echo").map((e) => e.text);
  expect(echoes[0]).toBe(`Published notes (${kb(Buffer.byteLength(NOTES))}) [v1]`);
  expect(echoes[1]).toMatch(/^Edited notes \(.+\) \[v2\]$/);
  expect(echoes[2]).toMatch(/^landing v2 of 2 /);
  const side = entries.map((e) => e.text).join("\n");
  expect(side).not.toContain("SUBAGENT-MARKUP");
  expect(side).not.toContain("MARKUP-NOT-IN-LOG");
  // the master's page is as it was
  const landing = made.find((a) => a.name === "landing");
  expect(landing?.versions.length).toBe(2);
}, 30_000);

test("the routes send exactly their headers", async () => {
  const raw = await fetch(`${base}/api/artifact?name=landing&v=1`);
  expect(raw.status).toBe(200);
  expect(await raw.text()).toBe(V1);
  expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(raw.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
  expect(raw.headers.get("content-disposition")).toBe('attachment; filename="landing-v1.html"');
  expect(raw.headers.get("cache-control")).toBe("private, no-store");

  const frame = await fetch(`${base}/artifact/frame?name=landing`);
  expect(frame.status).toBe(200);
  const wrapper = await frame.text();
  expect(frame.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(frame.headers.get("content-security-policy")).toBe(
    `default-src 'none'; frame-src 127.0.0.1:${port}/artifact/page; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
  );
  expect(frame.headers.get("x-content-type-options")).toBe("nosniff");
  expect(frame.headers.get("referrer-policy")).toBe("no-referrer");
  expect(frame.headers.get("permissions-policy")).toContain("camera=()");
  // fx0's wrapper: an opaque, credentialless, script-only frame; links opened only during a click
  expect(wrapper).toMatch(/setAttribute\('sandbox','allow-scripts'\)/);
  expect(wrapper).toMatch(/setAttribute\('credentialless',''\)/);
  expect(wrapper).toMatch(/url\.protocol==='https:'&&!url\.username&&!url\.password\)window\.open\(url\.href,'_blank','noopener,noreferrer'\)/);
  expect(wrapper).toMatch(/navigator\.userActivation\?\.isActive!==false/);
  expect(wrapper).not.toMatch(/allow-same-origin|allow-popups|MARKUP-NOT-IN-LOG/);
  expect(wrapper).toContain("/artifact/page?name=landing&token=");
  expect(wrapper).toContain("&v=2"); // the latest

  const token = /token=([0-9a-f-]{36})/.exec(wrapper)?.[1] ?? "";
  const inner = await fetch(`${base}/artifact/page?name=landing&v=1&token=${token}`, { headers: FRAME });
  expect(inner.status).toBe(200);
  expect(inner.headers.get("content-security-policy")).toBe(`sandbox allow-scripts; ${ARTIFACT_EMBEDDED_CSP}; frame-ancestors 'self'`);
  expect(inner.headers.get("x-content-type-options")).toBe("nosniff");
  expect(inner.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(inner.headers.get("x-dns-prefetch-control")).toBe("off");
  const prepared = await inner.text();
  expect(prepared).toStartWith('<!doctype html><meta http-equiv="Content-Security-Policy"');
  expect(prepared).toContain(token);
  expect(prepared).toContain("RTCPeerConnection");
  expect(prepared.endsWith(V1.slice("<!doctype html>".length))).toBe(true);

  const draft = await fetch(`${base}/artifact/draft`, { headers: FRAME });
  expect(draft.headers.get("content-security-policy")).toBe(
    "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  );
});

test("an unknown or malformed name or version is a 404, and nothing outside the artifacts is reached", async () => {
  const token = "00000000-0000-0000-0000-000000000000";
  for (const query of [
    "name=nope",
    "name=landing&v=3",
    "name=landing&v=0",
    "name=landing&v=1.5",
    "name=landing&v=-1",
    "name=landing&v=x",
    "name=",
    "",
    "name=..%2F..%2Fchat",
    "name=..",
    "name=landing%2F..%2F..%2Fchat",
    "name=landing%00",
    "name=%2Fetc%2Fpasswd",
  ]) {
    expect([query, await status(`/api/artifact?${query}`)]).toEqual([query, 404]);
    expect([query, await status(`/artifact/frame?${query}`)]).toEqual([query, 404]);
    expect([query, await status(`/artifact/page?${query}&token=${token}`, FRAME)]).toEqual([query, 404]);
  }
  // the page wants a version and a token
  expect(await status(`/artifact/page?name=landing&token=${token}`, FRAME)).toBe(404);
  expect(await status("/artifact/page?name=landing&v=1", FRAME)).toBe(404);
  expect(await status("/artifact/page?name=landing&v=1&token=%3C%2Fscript%3E", FRAME)).toBe(404);
  // the page and the draft document answer only a frame's load: opened as a tab (or by a client
  // that doesn't say), a page would have no wrapper's frame-src to keep its navigations in
  const tabs: readonly Readonly<Record<string, string>>[] = [{}, { "sec-fetch-dest": "document" }, { "sec-fetch-dest": "empty" }];
  for (const dest of tabs) {
    expect(await status(`/artifact/page?name=landing&v=1&token=${token}`, dest)).toBe(404);
    expect(await status("/artifact/draft", dest)).toBe(404);
  }
  expect(await status(`/artifact/page?name=landing&v=1&token=${token}`, FRAME)).toBe(200);
});

test("every artifact route answers only past the guard", async () => {
  const paths = ["/api/artifacts", "/api/artifact?name=landing&v=1", "/artifact/frame?name=landing", "/artifact/draft", `/artifact/page?name=landing&v=1&token=${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`];
  // another site's page, a rebinding name, a login not allowed, a forwarded request
  const outsiders: readonly Readonly<Record<string, string>>[] = [{ origin: "https://evil.example" }, { host: "evil.example" }, { "tailscale-user-login": "intruder@example.com" }, { "x-forwarded-for": "10.0.0.9" }];
  for (const path of paths) {
    expect(await status(path, FRAME)).toBe(200);
    for (const headers of outsiders) expect([path, headers, await status(path, { ...FRAME, ...headers })]).toEqual([path, headers, 403]);
  }
  // the opaque frame's own requests say Origin: null, which is no origin of ours
  expect(await status("/api/artifacts", { origin: "null" })).toBe(403);
});
