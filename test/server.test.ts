// End to end: optchat-server as a process with a fake `claude`, two clients on its /ws (a raw
// socket and the REPL with piped stdin), the master's MCP endpoint, the data dir's git commits,
// and who the server lets in.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type Inbound, parseInbound } from "../cli/repl.ts";

const ROOT = `${import.meta.dir}/../`;
const FAKE = `${ROOT}test/fake-claude.ts`;
const REPLY = "hi from the fake";
const PUBLIC = "https://mini.example.ts.net";

const dir = mkdtempSync(`${tmpdir()}/odj-e2e-`);
const port = 20_000 + Math.floor(Math.random() * 20_000);
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

beforeAll(async () => {
  // the second turn (the REPL's) is slow: the REPL must wait for its answer, not for an idle state
  writeFileSync(env.FAKE_CLAUDE_SCRIPT, JSON.stringify({ turn: [[{ text: REPLY }], [{ sleep: 1500 }, { text: REPLY }]] }));
  const settings = {
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    compactor: { byLevel: [{ from: 0, chain: ["claude-code:sonnet"] }], effort: "medium" },
    cache: { claudeCodeTtl: "1h", primeTtl: "1h", apiKeyTtls: ["1h"] },
    devices: { mini: { url: "http://127.0.0.1:1", folders: [dir] } },
    defaultDevice: "mini",
    allowedLogins: [],
    server: { host: "127.0.0.1", port, publicUrl: PUBLIC },
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

const Start = Schema.Struct({ type: Schema.Literal("start"), pid: Schema.Number, role: Schema.String, argv: Schema.Array(Schema.String) });
const decodeStart = Schema.decodeUnknownOption(Schema.fromJsonString(Start));
const McpConfig = Schema.fromJsonString(Schema.Struct({ mcpServers: Schema.Struct({ optchat: Schema.Struct({ url: Schema.String }) }) }));
const State = Schema.Struct({ messages: Schema.Number });
const fakeStarts = () =>
  readFileSync(env.FAKE_CLAUDE_LOG, "utf8")
    .split("\n")
    .flatMap((line) => Option.toArray(decodeStart(line)));

// a /ws client that keeps every event it gets
function client() {
  const events: Inbound[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.addEventListener("message", (m) => {
    for (const e of Option.toArray(parseInbound(String(m.data)))) events.push(e);
  });
  const opened = new Promise((resolve) => {
    ws.addEventListener("open", resolve);
  });
  const until = async (done: (es: readonly Inbound[]) => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!done(events)) {
      if (Date.now() > end) throw new Error(`timed out; got ${events.map((e) => e.type).join(" ")}`);
      await Bun.sleep(20);
    }
  };
  return { events, opened, until, ws };
}
const texts = (es: readonly Inbound[]) => es.flatMap((e) => (e.type === "TEXT_MESSAGE_CONTENT" ? [e.delta] : []));
const finished = (es: readonly Inbound[]) => es.filter((e) => e.type === "RUN_FINISHED").length;

test("a turn over /ws streams to every client; the REPL is one of them; the master reaches /mcp", async () => {
  const web = client();
  await web.opened;
  web.ws.send(JSON.stringify({ messages: [{ content: "hello", id: "m1", role: "user" }], runId: "r1", threadId: "t" }));
  await web.until((es) => finished(es) === 1);
  expect(texts(web.events)).toEqual(["hello", REPLY]);

  // the master got an --mcp-config whose server answers zoom over HTTP with the logged message
  const turn = fakeStarts().find((s) => s.role === "turn");
  const config = turn?.argv[turn.argv.indexOf("--mcp-config") + 1] ?? "";
  const { url } = Schema.decodeUnknownSync(McpConfig)(config).mcpServers.optchat;
  const call = { id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: { id: 0, n: 1 }, name: "zoom" } };
  const zoom = await fetch(url, { body: JSON.stringify(call), headers: { "content-type": "application/json" }, method: "POST" });
  expect(await zoom.text()).toContain("0+0|user: hello");
  const stranger = await fetch(`${base}/mcp?key=wrong`, { body: JSON.stringify(call), method: "POST" });
  expect(stranger.status).toBe(403);

  // the REPL, piped: one message per line, echoed, answered, and it exits once its turn is done,
  // even though stdin ends at once and the turn takes a while
  const repl = Bun.spawn(["bun", `${ROOT}cli/optchat.ts`], { env, stdin: new TextEncoder().encode("second\n"), stdout: "pipe" });
  const out = await new Response(repl.stdout).text();
  expect(await repl.exited).toBe(0);
  const after = out.slice(out.indexOf("> second\n")); // the intro above it shows the first reply already
  expect(after).toContain("> second\n");
  expect(after).toContain(`${REPLY}\n`);

  // the first client watched the REPL's turn too
  await web.until((es) => finished(es) === 2);
  expect(texts(web.events)).toEqual(["hello", REPLY, "second", REPLY]);
  web.ws.close();

  const state = await fetch(`${base}/api/state`);
  expect(Schema.decodeUnknownSync(State)(await state.json()).messages).toBe(4);
  // the commit lands after the run's end; the session turns idle only once it has
  const commits = () => spawnSync("git", ["-C", env.OPTCHAT_HOME, "log", "--format=%s"], { encoding: "utf8" }).stdout;
  const deadline = Date.now() + 10_000;
  while (!commits().includes("chore(chat): 4 messages")) {
    if (Date.now() > deadline) throw new Error(`no commit of 4 messages; the log has: ${commits()}`);
    await Bun.sleep(50);
  }
}, 30_000);

test("a piped REPL that cannot reach the server says so and exits non-zero", async () => {
  const nowhere = `http://127.0.0.1:${port + 1}`;
  const repl = Bun.spawn(["bun", `${ROOT}cli/optchat.ts`], {
    env: { ...env, OPTCHAT_URL: nowhere },
    stderr: "pipe",
    stdin: new TextEncoder().encode("anyone there?\n"),
    stdout: "pipe",
  });
  expect(await repl.exited).toBe(1);
  expect(await new Response(repl.stderr).text()).toContain(`cannot reach the server at ${nowhere}`);
});

// Host and Origin: a web page in some browser must not be able to drive the server (server/auth.ts)
test("only our own Host names and Origins get in; a client without an Origin does too", async () => {
  const status = async (path: string, headers: Record<string, string>) => {
    const response = await fetch(`${base}${path}`, { headers });
    return response.status;
  };
  expect(await status("/api/state", {})).toBe(200);
  expect(await status("/api/state", { host: `localhost:${port}` })).toBe(200);
  expect(await status("/api/state", { host: new URL(PUBLIC).host })).toBe(200);
  expect(await status("/api/state", { host: `rebound.example:${port}` })).toBe(403); // DNS rebinding
  expect(await status("/api/state", { host: "127.0.0.1:1" })).toBe(403);
  expect(await status("/api/state", { origin: "https://evil.example" })).toBe(403);

  const upgrade = { connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13", upgrade: "websocket" };
  expect(await status("/ws", { ...upgrade, origin: "https://evil.example" })).toBe(403);
  expect(await status("/ws", { ...upgrade, origin: "null" })).toBe(403);
  expect(await status("/mcp?key=x", { origin: "https://evil.example" })).toBe(403);

  // same-origin pages, and the CLI with no Origin at all, open the socket
  const opens = async (headers: Record<string, string>) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const { promise, resolve } = Promise.withResolvers<boolean>();
    socket.addEventListener("open", () => {
      resolve(true);
    });
    socket.addEventListener("error", () => {
      resolve(false);
    });
    const ok = await promise;
    socket.close();
    return ok;
  };
  expect(await opens({})).toBe(true);
  expect(await opens({ origin: base })).toBe(true);
  expect(await opens({ origin: `http://localhost:${port}` })).toBe(true);
  expect(await opens({ origin: PUBLIC })).toBe(true);
  expect(await opens({ origin: "https://evil.example" })).toBe(false);
});

test("the server leaves no claude behind when it stops", async () => {
  server.kill("SIGTERM");
  expect(await server.exited).toBeDefined();
  await Bun.sleep(200);
  const alive = fakeStarts().filter((s) => {
    try {
      process.kill(s.pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  expect(alive).toEqual([]);
});
