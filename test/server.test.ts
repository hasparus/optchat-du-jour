// End to end: optchat-server as a process with a fake `claude`, two clients on its /ws (a raw
// socket and the REPL with piped stdin), the master's MCP endpoint, and the data dir's git commits.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type Inbound, parseInbound } from "../cli/repl.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const FAKE = `${ROOT}test/fake-claude.ts`;
const REPLY = "hi from the fake";

const dir = mkdtempSync(`${tmpdir()}/optchat-e2e-`);
const port = 20_000 + Math.floor(Math.random() * 20_000);
const base = `http://127.0.0.1:${port}`;
const env = {
  ...Bun.env,
  FAKE_CLAUDE_LOG: `${dir}/fake.jsonl`,
  FAKE_CLAUDE_SCRIPT: `${dir}/script.json`,
  OPTCHAT_CLAUDE: FAKE,
  OPTCHAT_CONFIG: `${dir}/optchat.config.ts`,
  OPTCHAT_HOME: `${dir}/home`,
  OPTCHAT_URL: base,
};
let server: Bun.Subprocess<"ignore", "pipe", "pipe">;

beforeAll(async () => {
  writeFileSync(env.FAKE_CLAUDE_SCRIPT, JSON.stringify({ turn: [[{ text: REPLY }]] }));
  const settings = {
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    compactor: { byLevel: [{ from: 0, chain: ["claude-code:sonnet"] }], effort: "medium" },
    cache: { claudeCodeTtl: "1h", primeTtl: "1h", apiKeyTtls: ["1h"] },
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

  // the REPL, piped: one message per line, echoed, answered, and it exits once the turn is done
  const repl = Bun.spawn(["bun", `${ROOT}cli/optchat.ts`], { env, stdin: new TextEncoder().encode("second\n"), stdout: "pipe" });
  const out = await new Response(repl.stdout).text();
  expect(await repl.exited).toBe(0);
  expect(out).toContain("> second\n");
  expect(out).toContain(`${REPLY}\n`);

  // the first client watched the REPL's turn too
  await web.until((es) => finished(es) === 2);
  expect(texts(web.events)).toEqual(["hello", REPLY, "second", REPLY]);
  web.ws.close();

  const state = await fetch(`${base}/api/state`);
  expect(Schema.decodeUnknownSync(State)(await state.json()).messages).toBe(4);
  const log = spawnSync("git", ["-C", env.OPTCHAT_HOME, "log", "--format=%s"], { encoding: "utf8" });
  expect(log.stdout).toContain("chore(chat): 4 messages");
}, 30_000);

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
