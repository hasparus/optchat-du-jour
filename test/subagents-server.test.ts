// Subagents end to end (SPEC M7a): optchat-server as a process with the fake `claude`, whose
// master calls spawn over /mcp as a real one would. The subagent's claude is read-only (a write
// tool and a nested spawn are refused by its permission mode, a direct spawn on its key by the
// server), its side log is written and committed, its usage recorded as a subagent's, its report
// reaches the chat, and a /ws client tells one, and stops another, from their cards.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { UsageRecord } from "../src/wire.ts";
import { freePort } from "./ports.ts";

const ROOT = `${import.meta.dir}/../`;
const FAKE = `${ROOT}test/fake-claude.ts`;

const dir = mkdtempSync(`${tmpdir()}/odj-sub-`);
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

beforeAll(async () => {
  writeFileSync(`${dir}/notes.md`, "trip: Oct 3\n");
  // turns: the first spawns scout, the second sleeper and idler; the third and later answer "ok"
  const script = {
    subagent: [
      [
        { tool: { input: { command: "touch /tmp/should-not-exist" }, name: "Bash" } },
        { toolResult: "ran" }, // never reached: the permission mode refused the call
        { mcp: { input: { name: "nested", task: "t" }, name: "spawn" } },
        { tool: { input: { file_path: `${dir}/notes.md` }, name: "Read" } },
        { toolResult: "trip: Oct 3" },
        { mcp: { input: { id: 0, n: 1 }, name: "zoom" } },
        { text: "The trip is on Oct 3." },
      ],
      // sleeper: waits for a message, then answers it
      [{ take: true }, { text: "got your message" }],
      // idler: never answers
      [{ hang: true }],
    ],
    turn: [
      [{ mcp: { input: { name: "scout", task: "Find when the trip is." }, name: "spawn" } }, { text: "scout is on it" }],
      [
        { mcp: { input: { model: "claude-code:opus@low", name: "sleeper", task: "Wait for word." }, name: "spawn" } },
        { mcp: { input: { name: "idler", task: "Idle." }, name: "spawn" } },
        { text: "two more running" },
      ],
    ],
  };
  writeFileSync(env.FAKE_CLAUDE_SCRIPT, JSON.stringify(script));
  const settings = {
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    compactor: { byLevel: [{ from: 0, chain: ["claude-code:sonnet"] }], effort: "medium" },
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    devices: { mini: { url: "http://127.0.0.1:1", folders: [dir] } },
    defaultDevice: "mini",
    allowedLogins: [],
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

const Start = Schema.Struct({ type: Schema.Literal("start"), pid: Schema.Number, role: Schema.String, argv: Schema.Array(Schema.String) });
const decodeStart = Schema.decodeUnknownOption(Schema.fromJsonString(Start));
const starts = (role: string) =>
  readFileSync(env.FAKE_CLAUDE_LOG, "utf8")
    .split("\n")
    .flatMap((line) => Option.toArray(decodeStart(line)))
    .filter((s) => s.role === role);
const decodeUsage = Schema.decodeUnknownSync(Schema.fromJsonString(UsageRecord));
const flag = (argv: readonly string[], name: string) => argv[argv.indexOf(name) + 1];
const McpConfig = Schema.fromJsonString(Schema.Struct({ mcpServers: Schema.Struct({ optchat: Schema.Struct({ url: Schema.String }) }) }));
const mcpUrlOf = (argv: readonly string[]) => Schema.decodeUnknownSync(McpConfig)(flag(argv, "--mcp-config") ?? "").mcpServers.optchat.url;

const Entries = Schema.Struct({ entries: Schema.Array(Schema.Struct({ i: Schema.Number, kind: Schema.String, text: Schema.String, error: Schema.optional(Schema.Boolean) })) });
// a JSON body from the server, decoded
const json = async <A>(schema: Schema.Decoder<A>, path: string) => {
  const res = await fetch(`${base}${path}`);
  const body: unknown = await res.json();
  return Schema.decodeUnknownSync(schema)(body);
};
const messages = async () => {
  const page = await json(Entries, "/api/messages?limit=500");
  return page.entries;
};
const sideLog = async (name: string) => {
  const log = await json(Entries, `/api/subagent?name=${name}`);
  return log.entries;
};
const Agents = Schema.Struct({ subagents: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, state: Schema.String, ref: Schema.String, effort: Schema.NullOr(Schema.String) }))) });
const agents = async () => {
  const state = await json(Agents, "/api/state");
  return state.subagents ?? [];
};

// whether the chat has an entry like this, and a subagent as the state lists it
const chatHas = async (ok: (e: { readonly text: string }) => boolean) => {
  const all = await messages();
  return all.some(ok);
};
const agent = async (name: string) => {
  const all = await agents();
  return all.find((a) => a.name === name);
};

const eventually = async (what: string, ok: () => Promise<boolean> | boolean, ms = 15_000) => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
};

const mcpCall = async (url: string, name: string, args: Readonly<Record<string, Schema.Json>>) => {
  const body = JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name } });
  const res = await fetch(url, { body, headers: { "content-type": "application/json" }, method: "POST" });
  return res.text();
};
const send = (ws: WebSocket, text: string, id: string) => {
  ws.send(JSON.stringify({ messages: [{ content: text, id, role: "user" }], runId: id, threadId: "t" }));
};
// a /ws client keeping every frame it gets, once open
const client = async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: string[] = [];
  ws.addEventListener("message", (m) => {
    frames.push(String(m.data));
  });
  await new Promise((resolve) => {
    ws.addEventListener("open", resolve);
  });
  return { frames, ws };
};

test("the master spawns a read-only subagent over /mcp; its report reaches the chat, its steps only its side log", async () => {
  const { frames, ws } = await client();
  send(ws, "when is the trip? ask a subagent", "m1");
  await eventually("the report", async () => chatHas((e) => e.text.startsWith("[scout] ")));
  const chat = await messages();
  const report = chat.find((e) => e.text.startsWith("[scout] "));
  expect(report).toMatchObject({ kind: "user", text: "[scout] The trip is on Oct 3." });
  // the chat has the turn (its spawn call and answer) and the report; nothing of what scout did
  expect(chat.map((e) => e.kind)).toEqual(["user", "tool", "echo", "talk", "user"]);
  expect(chat[1]?.text).toStartWith('mcp__optchat__spawn {"name":"scout"');
  expect(chat[2]?.text).toContain("Started scout on Claude Opus (Claude Code)");
  expect(chat.some((e) => e.text.includes("touch /tmp/should-not-exist") || e.text.includes("trip: Oct 3"))).toBe(false);

  // its claude: the master's tools and system prompt, but permission mode default with only the
  // read tools let through, a key of its own, and never warm
  const [master] = starts("turn");
  const [scout] = starts("subagent");
  expect(scout).toBeDefined();
  expect(flag(scout?.argv ?? [], "--permission-mode")).toBe("default");
  expect(flag(scout?.argv ?? [], "--allowedTools")).toBe("Read,Glob,Grep,mcp__optchat__zoom,mcp__optchat__date");
  expect(flag(scout?.argv ?? [], "--tools")).toBe(flag(master?.argv ?? [], "--tools"));
  expect(flag(scout?.argv ?? [], "--system-prompt")).toBe(flag(master?.argv ?? [], "--system-prompt"));
  expect(flag(scout?.argv ?? [], "--effort")).toBe("high");
  expect(mcpUrlOf(scout?.argv ?? [])).not.toBe(mcpUrlOf(master?.argv ?? []));

  // its side log: Bash and the nested spawn refused, the Read and zoom answered, then its reply
  const side = await sideLog("scout");
  expect(side.map((e) => `${e.kind}${e.error ? "!" : ""}: ${e.text.slice(0, 60)}`)).toEqual([
    "user: Find when the trip is.",
    'tool: Bash {"command":"touch /tmp/should-not-exist"}',
    "echo!: Claude requested permissions to use Bash, but you haven't gr",
    'tool: mcp__optchat__spawn {"name":"nested","task":"t"}',
    "echo!: Claude requested permissions to use mcp__optchat__spawn, but",
    `tool: ${`Read {"file_path":"${dir}/notes.md"}`.slice(0, 60)}`,
    "echo: trip: Oct 3",
    'tool: mcp__optchat__zoom {"id":0,"n":1}',
    "echo: 0+0|user: when is the trip? ask a subagent",
    "talk: The trip is on Oct 3.",
  ]);
  // and on its own key the server refuses spawn and tell too
  const childUrl = mcpUrlOf(scout?.argv ?? []);
  expect(await mcpCall(childUrl, "spawn", { name: "nested", task: "t" })).toContain("a subagent can't start or tell subagents");
  // zoom("scout") on the master's key reads it
  const zoomed = await mcpCall(mcpUrlOf(master?.argv ?? []), "zoom", { id: "scout" });
  expect(zoomed).toContain("scout: done, on claude-code:opus, 10 entries");
  expect(zoomed).toContain("9|talk: The trip is on Oct 3.");

  // usage.jsonl: its call as a subagent's, with its name, ref and effort
  const usage = readFileSync(`${env.OPTCHAT_HOME}/usage.jsonl`, "utf8").trim().split("\n").map((l) => decodeUsage(l));
  expect(usage.filter((u) => u.role === "subagent").map((u) => [u.subagent, u.ref, u.effort, u.engine])).toEqual([["scout", "claude-code:opus", "high", "claude-code"]]);
  expect(usage.filter((u) => u.role === "turn").every((u) => u.subagent === undefined)).toBe(true);

  // the side log and agent.json are committed with the data dir
  await eventually("committed", () => spawnSync("git", ["-C", env.OPTCHAT_HOME, "ls-files"], { encoding: "utf8" }).stdout.includes("streams/mini/agents/scout/log.jsonl"));
  const tracked = spawnSync("git", ["-C", env.OPTCHAT_HOME, "ls-files"], { encoding: "utf8" }).stdout;
  expect(tracked).toContain("streams/mini/agents/scout/agent.json");
  // AG-UI's subagent events went to the client
  expect(frames.some((f) => f.includes('"type":"SUBAGENT_STARTED"') && f.includes('"name":"scout"'))).toBe(true);
  expect(frames.some((f) => f.includes('"type":"SUBAGENT_FINISHED"') && f.includes("The trip is on Oct 3."))).toBe(true);
  ws.close();
}, 30_000);

test("from their cards over /ws: a tell reaches a running subagent, a stop ends another; the model is picked per subagent", async () => {
  const { frames, ws } = await client();
  send(ws, "start two more", "m2");
  await eventually("both running", async () => {
    const all = await agents();
    return all.filter((a) => a.state === "running").length === 2;
  });
  // the master picked sleeper's model, idler runs at the turn's
  const list = await agents();
  expect(list.find((a) => a.name === "sleeper")).toMatchObject({ effort: "low", ref: "claude-code:opus@low" });
  expect(list.find((a) => a.name === "idler")).toMatchObject({ effort: "high", ref: "claude-code:opus" });
  // a message from sleeper's card, which it takes between its steps (once its call runs: one sent
  // before that would join its opening, which the fake's script doesn't wait for)
  const Read = Schema.Struct({ type: Schema.Literal("in"), pid: Schema.Number });
  const decodeRead = Schema.decodeUnknownOption(Schema.fromJsonString(Read));
  await eventually("sleeper reads its opening", () => {
    const pid = starts("subagent")[1]?.pid;
    return readFileSync(env.FAKE_CLAUDE_LOG, "utf8").split("\n").some((line) => Option.exists(decodeRead(line), (r) => r.pid === pid));
  });
  ws.send(JSON.stringify({ name: "sleeper", text: "the word is go", type: "tell" }));
  await eventually("sleeper's report", async () => chatHas((e) => e.text === "[sleeper] got your message"));
  const slept = await sideLog("sleeper");
  expect(slept.map((e) => e.text)).toEqual(["Wait for word.", "[from the user] the word is go", "got your message"]);
  // a card's model, then its stop
  ws.send(JSON.stringify({ model: "claude-code:nope", name: "idler", type: "subagent-model" }));
  await eventually("the refusal", () => frames.some((f) => f.includes("claude-code:nope is not a model of the master's chain")));
  ws.send(JSON.stringify({ model: "claude-code:opus@medium", name: "idler", type: "subagent-model" }));
  await eventually("picked", async () => {
    const idler = await agent("idler");
    return idler?.ref === "claude-code:opus@medium";
  });
  ws.send(JSON.stringify({ name: "idler", type: "stop-subagent" }));
  await eventually("idler's report", async () => chatHas((e) => e.text.startsWith("[idler] stopped after")));
  const idler = await agent("idler");
  expect(idler?.state).toBe("stopped");
  expect(frames.some((f) => f.includes('"type":"SUBAGENT_ERROR"') && f.includes('"code":"stopped"'))).toBe(true);
  // the stopped claude is gone; nothing of either is in the chat but their reports
  const chat = await messages();
  expect(chat.filter((e) => e.text.startsWith("[")).map((e) => e.text.slice(0, 16))).toEqual(["[scout] The trip", "[sleeper] got yo", "[idler] stopped "]);
  ws.close();
}, 30_000);
