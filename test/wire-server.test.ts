// /ws end to end, for what this branch added to it: optchat-server as a process with the fake
// `claude`. A page from another build is closed with WIRE_STALE (E44), while one of this build, or
// one that names no version (the REPL, a page from before the check), is served; and an Edit's
// input reaches a client as it streams, as its tool call, before its entry is logged (E45).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { WIRE, WIRE_STALE } from "../src/wire.ts";
import { freePort } from "./ports.ts";

const ROOT = `${import.meta.dir}/../`;
const dir = mkdtempSync(`${tmpdir()}/odj-wire-`);
const port = freePort();
const base = `http://127.0.0.1:${port}`;
const env = {
  ...Bun.env,
  FAKE_CLAUDE_LOG: `${dir}/fake.jsonl`,
  FAKE_CLAUDE_SCRIPT: `${dir}/plan.json`,
  OPTCHAT_CLAUDE: `${ROOT}test/fake-claude.ts`,
  OPTCHAT_CONFIG: `${dir}/optchat.config.ts`,
  OPTCHAT_HOME: `${dir}/home`,
  OPTCHAT_URL: base,
};
let server: Bun.Subprocess<"ignore", "pipe", "pipe">;

// an Edit whose input streams in 64-character pieces, 30 ms apart
const EDIT = { file_path: `${dir}/notes.md`, new_string: "line one\nline 2\nline three\n", old_string: "line one\nline two\nline three\n" };

beforeAll(async () => {
  writeFileSync(env.FAKE_CLAUDE_SCRIPT, JSON.stringify({ turn: { "*": [{ text: "Fixing it." }, { pace: 30, tool: { input: EDIT, name: "Edit" } }, { toolResult: "edited" }, { text: "done" }] } }));
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

const until = async (what: string, ok: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};

// a socket on /ws with this query: every frame it got, and how it closed
const open = (query: string) => {
  const frames: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws${query}`);
  ws.addEventListener("message", (m) => {
    frames.push(String(m.data));
  });
  const closed = new Promise<{ readonly code: number; readonly reason: string }>((resolve) => {
    ws.addEventListener("close", (e) => {
      resolve({ code: e.code, reason: e.reason });
    });
  });
  return { closed, frames, ws };
};

const Frame = Schema.Struct({
  type: Schema.String,
  delta: Schema.optional(Schema.Unknown), // a STATE_DELTA's is its patch
  toolCallId: Schema.optional(Schema.String),
  toolCallName: Schema.optional(Schema.String),
  parentMessageId: Schema.optional(Schema.String),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Frame));

test("a page from another build is closed with WIRE_STALE before anything is sent; this build's, or one naming none, is served (E44)", async () => {
  const stale = open(`?wire=${WIRE + 1}`);
  const why = await stale.closed;
  expect(why.code).toBe(WIRE_STALE);
  expect(why.reason).toContain("reload");
  expect(stale.frames).toEqual([]);

  for (const query of [`?wire=${WIRE}`, ""]) {
    const fresh = open(query);
    await until(`the snapshot for "${query}"`, () => fresh.frames.some((f) => decode(f).type === "STATE_SNAPSHOT"));
    fresh.ws.close();
  }
}, 20_000);

test("an Edit's input reaches the client as its tool call while it streams, before its entry; then the entry is the call whole (E45)", async () => {
  const web = open(`?wire=${WIRE}`);
  await until("the snapshot", () => web.frames.length > 0);
  web.ws.send(JSON.stringify({ messages: [{ content: "fix the second line", id: "m1", role: "user" }], runId: "r1", threadId: "t" }));
  await until("the run's end", () => web.frames.some((f) => decode(f).type === "RUN_FINISHED"));
  web.ws.close();
  const events = web.frames.map((f) => decode(f));
  const starts = events.flatMap((e, k) => (e.type === "TOOL_CALL_START" ? [k] : []));
  // one start while it streams, at the index its entry gets, and one for the entry
  expect(starts).toHaveLength(2);
  const [live = -1, logged = -1] = starts;
  expect(events[live]).toMatchObject({ parentMessageId: "2", toolCallId: "t2", toolCallName: "Edit" });
  const pieces = events.slice(live + 1, logged).flatMap((e) => (e.type === "TOOL_CALL_ARGS" ? [String(e.delta)] : []));
  expect(pieces.length).toBeGreaterThan(1); // in pieces, as they came
  expect(pieces.join("")).toBe(JSON.stringify(EDIT));
  expect(events.slice(live + 1, logged).some((e) => e.type === "TOOL_CALL_END")).toBe(false);
  expect(events.slice(logged, logged + 3).map((e) => e.type)).toEqual(["TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END"]);
  expect(events[logged + 1]?.delta).toBe(JSON.stringify(EDIT));
}, 30_000);
