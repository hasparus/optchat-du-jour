// End to end: optchat-server as a process with a fake `claude`, two clients on its /ws (a raw
// socket and the REPL with piped stdin), the master's MCP endpoint over a WebSocket and over HTTP,
// the data dir's git commits, who the server lets in, and the warm processes it leaves behind (none).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { type Inbound, parseInbound } from "../cli/repl.ts";
import { OUT_OF_DATE } from "../server/routes/ws.ts";

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
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    devices: { mini: { url: "http://127.0.0.1:1", folders: [dir] } },
    defaultDevice: "mini",
    allowedLogins: [],
    server: { host: "127.0.0.1", port, publicUrl: PUBLIC },
  };
  writeFileSync(env.OPTCHAT_CONFIG, `export default ${JSON.stringify(settings)};\n`);
  server = Bun.spawn(["bun", `${ROOT}cli/optchat.ts`, "server"], { env, stderr: "pipe", stdout: "pipe" }); // as `optchat server`
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
const running = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// the URL in the master's --mcp-config
const mcpUrl = () => {
  const turn = fakeStarts().find((s) => s.role === "turn");
  const config = turn?.argv[turn.argv.indexOf("--mcp-config") + 1] ?? "";
  return Schema.decodeUnknownSync(McpConfig)(config).mcpServers.optchat.url;
};

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
// a RunAgentInput frame
const run = (messages: readonly object[]) => JSON.stringify({ messages, runId: crypto.randomUUID(), threadId: "t" });

test("a turn over /ws streams to every client; the REPL is one of them; the master reaches /mcp", async () => {
  const web = client();
  await web.opened;
  web.ws.send(JSON.stringify({ messages: [{ content: "hello", id: "m1", role: "user" }], runId: "r1", threadId: "t" }));
  await web.until((es) => finished(es) === 1);
  expect(texts(web.events)).toEqual(["hello", REPLY]);

  // the master got an --mcp-config whose server answers zoom with the logged message; over HTTP here
  const url = mcpUrl().replace(/^ws/, "http");
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

// whether a WebSocket to /mcp opens, as claude dials it
const mcpOpens = async (target: string, headers: Record<string, string> = {}) => {
  const socket = new WebSocket(target, { headers, protocols: ["mcp"] });
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

test("/mcp over a WebSocket: one JSON-RPC message per frame each way; a wrong key, a foreign Origin or no upgrade is refused", async () => {
  const url = mcpUrl();
  expect(url).toStartWith(`ws://127.0.0.1:${port}/mcp?key=`);
  // as claude dials it: subprotocol "mcp", no Origin
  const ws = new WebSocket(url, { protocols: ["mcp"] });
  const replies: unknown[] = [];
  ws.addEventListener("message", (m) => {
    replies.push(JSON.parse(String(m.data)));
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  expect(ws.protocol).toBe("mcp");
  const rpc = (body: Record<string, Schema.Json>) => {
    ws.send(JSON.stringify({ jsonrpc: "2.0", ...body }));
  };
  rpc({ id: 1, method: "initialize", params: { capabilities: {}, clientInfo: { name: "claude-code" }, protocolVersion: "2025-06-18" } });
  rpc({ method: "notifications/initialized" }); // no reply
  rpc({ id: 2, method: "tools/list" });
  rpc({ id: 3, method: "tools/call", params: { arguments: { id: 0, n: 1 }, name: "zoom" } });
  const end = Date.now() + 5000;
  while (replies.length < 3 && Date.now() < end) await Bun.sleep(10);
  ws.close();
  expect(replies).toMatchObject([
    { id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "optchat" } } },
    { id: 2, result: { tools: [{ name: "zoom" }, { name: "date" }] } },
    { id: 3, result: { content: [{ text: "0+0|user: hello", type: "text" }] } },
  ]);

  expect(await mcpOpens(url.replace(/key=[^&]+/, "key=wrong"))).toBe(false);
  expect(await mcpOpens(url, { origin: "https://evil.example" })).toBe(false);
  expect(await mcpOpens(url, { origin: base })).toBe(true);
  const plain = await fetch(url.replace(/^ws/, "http")); // a GET that does not upgrade
  expect(plain.status).toBe(405);
});

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

test("a client that resends the whole history has only its new messages answered, each acked with its log index", async () => {
  const web = client();
  await web.opened;
  await web.until((es) => es.some((e) => e.type === "STATE_SNAPSHOT"));
  // ids "0"–"3" are log indexes, the entries the server sent; only h1, then only h2, are new
  const history = [
    { content: "hello", id: "0", role: "user" },
    { content: REPLY, id: "1", role: "assistant" },
    { content: "second", id: "2", role: "user" },
    { content: REPLY, id: "3", role: "assistant" },
    { content: "third", id: "h1", role: "user" },
  ];
  web.ws.send(run(history));
  await web.until((es) => finished(es) === 1);
  web.ws.send(run([...history, { content: REPLY, id: "5", role: "assistant" }, { content: "fourth", id: "h2", role: "user" }]));
  await web.until((es) => finished(es) === 2);
  // a client's own id may look like a log index: it names an old message only when that entry is
  // a user message with the same text ("3" is the server's reply)
  web.ws.send(run([{ content: "fifth", id: "3", role: "user" }]));
  await web.until((es) => finished(es) === 3);
  web.ws.close();
  expect(texts(web.events)).toEqual(["third", REPLY, "fourth", REPLY, "fifth", REPLY]);
  const acks = web.events.flatMap((e) => (e.type === "CUSTOM" && e.name === "ack" ? [[e.value.clientId, e.value.messageId]] : []));
  expect(acks).toEqual([
    ["h1", "4"],
    ["h2", "6"],
    ["3", "8"],
  ]);
}, 20_000);

test("/api/node takes a level and an index that are non-negative integers, and knows which nodes exist", async () => {
  const status = async (query: string) => {
    const response = await fetch(`${base}/api/node?${query}`);
    return response.status;
  };
  for (const bad of ["l=-1&i=0", "l=0&i=1.5", "l=NaN&i=0", "l=0&i=-1", "l=1000&i=0", "l=0", "l=x&i=0"]) expect([bad, await status(bad)]).toEqual([bad, 400]);
  expect(await status("l=0&i=0")).toBe(200);
  expect(await status("l=0&i=999")).toBe(404);
  expect(await status("l=52&i=1")).toBe(404);
  const node = await fetch(`${base}/api/node?l=1&i=0`).then(async (r) => r.json());
  expect(node).toMatchObject({ children: [{ i: 0, l: 0 }, { i: 1, l: 0 }], i: 0, id: 0, l: 1, n: 2 });
});

// each follow-up behavior a STATE_DELTA sets
const followUps = (es: readonly Inbound[]) => es.flatMap((e) => (e.type === "STATE_DELTA" ? e.delta.flatMap((op) => (op.path === "/followUp" ? [op.value] : [])) : []));

// SPEC "Protocol": the settings, resume and take-back frames are decoded by their schema; a
// malformed one is dropped like any frame the server can't read, and a well-formed one that names
// nothing it has, or comes when nothing waits for it, is answered, never acted on
test("settings, resume and take-back frames over /ws: checked by their schema, shared through the state, saved in the data dir", async () => {
  const web = client();
  await web.opened;
  await web.until((es) => es.some((e) => e.type === "STATE_SNAPSHOT"));
  web.ws.send(JSON.stringify({ followUp: "sideways", type: "settings" })); // not a behavior: dropped
  web.ws.send(JSON.stringify({ type: "take-back" })); // no client id: dropped
  web.ws.send(JSON.stringify({ type: "resume" })); // no engine: dropped
  web.ws.send(JSON.stringify({ engine: "nope:x", type: "resume" }));
  web.ws.send(JSON.stringify({ engine: "claude-code:opus", type: "resume" })); // no turn waits for one
  web.ws.send(JSON.stringify({ clientId: "never-sent", type: "take-back" }));
  web.ws.send(JSON.stringify({ followUp: "queue", type: "settings" }));
  await web.until((es) => followUps(es).length === 1);
  expect(followUps(web.events)).toEqual(["queue"]);
  const infos = web.events.flatMap((e) => (e.type === "CUSTOM" && e.name === "info" ? [e.value] : []));
  expect(infos).toContain("nope:x is not an engine of the master's chain (claude-code:opus)");
  expect(infos).toContain("not resumed on Claude Opus (Claude Code): no turn waits for a model (another client may have resumed it)");
  // a client from before the per-message model still sends a pick: it alone is told to reload
  const old = client();
  await old.opened;
  await old.until((es) => es.some((e) => e.type === "STATE_SNAPSHOT"));
  old.ws.send(JSON.stringify({ lead: "claude-code:opus", type: "settings" }));
  await old.until((es) => es.some((e) => e.type === "CUSTOM" && e.name === "info" && e.value === OUT_OF_DATE));
  await Bun.sleep(50);
  expect(web.events.some((e) => e.type === "CUSTOM" && e.name === "info" && e.value === OUT_OF_DATE)).toBe(false);
  old.ws.close();
  const back = web.events.flatMap((e) => (e.type === "CUSTOM" && e.name === "taken-back" ? [e.value] : []));
  expect(back).toEqual([{ clientId: "never-sent", error: "the server holds no such message", text: null }]);
  expect(readFileSync(`${env.OPTCHAT_HOME}/session.json`, "utf8")).toBe('{"followUp":"queue"}\n');
  // the other tests here expect steer
  web.ws.send(JSON.stringify({ followUp: "steer", type: "settings" }));
  await web.until((es) => followUps(es).length === 2);
  web.ws.close();
});

test("the server stops at once with a client still connected, and leaves no claude behind", async () => {
  const web = client(); // a web page left open: its socket must not hold the shutdown
  await web.opened;
  // the next turn's and priming's claude wait, started ahead (E18)
  const end = Date.now() + 5000;
  while (fakeStarts().filter((s) => running(s.pid)).length < 2 && Date.now() < end) await Bun.sleep(20);
  expect(new Set(fakeStarts().flatMap((s) => (running(s.pid) ? [s.role] : [])))).toEqual(new Set(["turn", "prime"]));
  const asked = Date.now();
  server.kill("SIGTERM");
  expect(await server.exited).toBeDefined();
  expect(Date.now() - asked).toBeLessThan(5000);
  await Bun.sleep(200);
  expect(fakeStarts().filter((s) => running(s.pid))).toEqual([]);
});

