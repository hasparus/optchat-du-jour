// Subagents end to end (SPEC "Subagents"): optchat-server as a process with the fake `claude`, whose
// master calls spawn over /mcp as a real one would, and a device runner (`optchat device macbook`)
// on loopback as a second machine. A subagent's claude has the master's permissions (it writes a
// file and runs a command directly in its folder), a /mcp key of its own (on which it spawns one of
// its own, whose report comes back to it), its side log is written and committed, its usage
// recorded as a subagent's, its report reaches the chat; an isolated one's commit is merged back
// into its repository; one spawned on the other device runs there through its runner; and a /ws
// client tells one, stops another, and stops all from the cards. Git repositories and worktrees
// are made in temporary directories only. Waking is off here (subagents.wake: false), so each test's
// turn is the one its message starts; the session's and the unit tests cover waking.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Option, Schema } from "effect";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { UsageRecord } from "../src/wire.ts";
import { freePort } from "./ports.ts";

const ROOT = `${import.meta.dir}/../`;
const FAKE = `${ROOT}test/fake-claude.ts`;

const dir = realpathSync(mkdtempSync(`${tmpdir()}/odj-sub-`));
const far = realpathSync(mkdtempSync(`${tmpdir()}/odj-far-`)); // the other machine's folder
const repo = `${dir}/repo`; // a git repository an isolated subagent works on
const port = freePort();
const devicePort = freePort();
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
let device: Bun.Subprocess<"ignore", "pipe", "pipe">;

const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" }).stdout.trim();

const up = async (url: string) =>
  fetch(url).then(
    (r) => r.ok,
    () => false,
  );

beforeAll(async () => {
  writeFileSync(`${dir}/notes.md`, "trip: Oct 3\n");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(`${repo}/README.md`, "a repo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "start");
  // turns: the first spawns scout, the second sleeper and idler, the third brancher (isolated), the
  // fourth roamer on the macbook, the fifth two that never end; each subagent's script by its name
  const script = {
    subagent: {
      // writes a file and runs a command where it works, spawns helper over its own key, takes
      // helper's report between its steps, and reports
      scout: [
        { run: { input: { content: "written by scout\n", file_path: "scout.md" }, name: "Write" } },
        { run: { input: { command: "echo ran in $(pwd) > ran.txt && cat ran.txt" }, name: "Bash" } },
        { mcp: { input: { name: "helper", task: "Say hello." }, name: "spawn" } },
        { take: true },
        { tool: { input: { file_path: `${dir}/notes.md` }, name: "Read" } },
        { toolResult: "trip: Oct 3" },
        { mcp: { input: { id: 0, n: 1 }, name: "zoom" } },
        { text: "The trip is on Oct 3." },
      ],
      helper: [{ text: "hello from helper" }],
      // waits for a message, then answers it
      sleeper: [{ take: true }, { text: "got your message" }],
      // never answers
      idler: [{ hang: true }],
      // commits a file in its worktree
      brancher: [{ run: { input: { command: "printf 'b\\n' > b.md && git add -A && git -c user.name=T -c user.email=t@example.com commit -qm 'add b' && git branch --show-current" }, name: "Bash" } }, { text: "committed b.md" }],
      // on the other machine
      roamer: [{ run: { input: { command: "pwd" }, name: "Bash" } }, { text: "roamed" }],
      stuck1: [{ hang: true }],
      stuck2: [{ hang: true }],
    },
    turn: [
      [{ mcp: { input: { name: "scout", task: "Find when the trip is." }, name: "spawn" } }, { text: "scout is on it" }],
      [
        { mcp: { input: { model: "claude-code:opus@low", name: "sleeper", task: "Wait for word." }, name: "spawn" } },
        { mcp: { input: { name: "idler", task: "Idle." }, name: "spawn" } },
        { text: "two more running" },
      ],
      [{ mcp: { input: { folder: repo, isolate: true, name: "brancher", task: "Add b.md." }, name: "spawn" } }, { text: "brancher is on it" }],
      [{ mcp: { input: { device: "macbook", name: "roamer", task: "Look around." }, name: "spawn" } }, { text: "roamer is on the macbook" }],
      [
        { mcp: { input: { name: "stuck1", task: "Hang." }, name: "spawn" } },
        { mcp: { input: { name: "stuck2", task: "Hang." }, name: "spawn" } },
        { text: "two stuck" },
      ],
    ],
  };
  writeFileSync(env.FAKE_CLAUDE_SCRIPT, JSON.stringify(script));
  const settings = {
    master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    compactor: { byLevel: [{ from: 0, chain: ["claude-code:sonnet"] }], effort: "medium" },
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    devices: { macbook: { url: `http://127.0.0.1:${devicePort}`, folders: [far] }, mini: { url: "http://127.0.0.1:1", folders: [dir] } },
    defaultDevice: "mini",
    allowedLogins: [],
    server: { host: "127.0.0.1", port, mcpTransport: "http", publicUrl: base },
    subagents: { max: 4, wake: false, worktrees: `${dir}/worktrees` },
  };
  writeFileSync(env.OPTCHAT_CONFIG, `export default ${JSON.stringify(settings)};\n`);
  server = Bun.spawn(["bun", `${ROOT}cli/optchat.ts`, "server"], { env: { ...env, OPTCHAT_SERVER_DEVICE: "mini" }, stderr: "pipe", stdout: "pipe" });
  device = Bun.spawn(["bun", `${ROOT}cli/optchat.ts`, "device", "macbook"], { env: { ...env, OPTCHAT_DEVICE_HOST: "127.0.0.1", OPTCHAT_DEVICE_TRUST: "loopback" }, stderr: "pipe", stdout: "pipe" });
  for (let k = 0; k < 100; k++) {
    if ((await up(`${base}/api/state`)) && (await up(`http://127.0.0.1:${devicePort}/health`))) return;
    await Bun.sleep(100);
  }
  throw new Error(`the server or the device did not start: ${await new Response(server.stderr).text()} ${await new Response(device.stderr).text()}`);
});

afterAll(async () => {
  server.kill("SIGTERM");
  device.kill("SIGTERM");
  await server.exited;
  await device.exited;
  rmSync(dir, { force: true, recursive: true });
  rmSync(far, { force: true, recursive: true });
});

const Start = Schema.Struct({ type: Schema.Literal("start"), pid: Schema.Number, role: Schema.String, argv: Schema.Array(Schema.String), cwd: Schema.String });
const decodeStart = Schema.decodeUnknownOption(Schema.fromJsonString(Start));
const starts = (role: string) =>
  readFileSync(env.FAKE_CLAUDE_LOG, "utf8")
    .split("\n")
    .flatMap((line) => Option.toArray(decodeStart(line)))
    .filter((s) => s.role === role);
// The pid of the subagent's claude that read the opening naming it: subagents spawned together
// start in either order, so not by index
const Read = Schema.Struct({ type: Schema.Literal("in"), pid: Schema.Number, content: Schema.Json });
const decodeRead = Schema.decodeUnknownOption(Schema.fromJsonString(Read));
const pidOf = (name: string) =>
  readFileSync(env.FAKE_CLAUDE_LOG, "utf8")
    .split("\n")
    .flatMap((line) => Option.toArray(decodeRead(line)))
    .find((r) => JSON.stringify(r.content).includes(`You are the subagent \\"${name}\\"`))?.pid;
const startOf = (name: string) => starts("subagent").find((s) => s.pid === pidOf(name));
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
const Agents = Schema.Struct({
  subagents: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        state: Schema.String,
        ref: Schema.String,
        effort: Schema.NullOr(Schema.String),
        device: Schema.optional(Schema.String),
        folder: Schema.optional(Schema.String),
        parent: Schema.optional(Schema.String),
        isolated: Schema.optional(Schema.Boolean),
        merge: Schema.optional(Schema.Struct({ outcome: Schema.String, into: Schema.NullOr(Schema.String), files: Schema.Number })),
      }),
    ),
  ),
});
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

// the first 60 characters of a line, enough to tell one from another
const head = (t: string) => t.slice(0, 60);

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

test("a subagent has the master's permissions: it writes a file and runs a command in its folder, and spawns one of its own over its key", async () => {
  const { frames, ws } = await client();
  send(ws, "when is the trip? ask a subagent", "m1");
  await eventually("the report", async () => chatHas((e) => e.text.startsWith("[scout] ")));
  const chat = await messages();
  const report = chat.find((e) => e.text.startsWith("[scout] "));
  expect(report).toMatchObject({ kind: "user", text: "[scout] The trip is on Oct 3." });
  // the chat has the turn (its spawn call and answer) and scout's report; nothing of what scout or helper did
  expect(chat.map((e) => e.kind)).toEqual(["user", "tool", "echo", "talk", "user"]);
  expect(chat[1]?.text).toStartWith('mcp__optchat__spawn {"name":"scout"');
  expect(chat[2]?.text).toContain(`Started scout on Claude Opus (Claude Code), directly in ${dir} on mini`);
  expect(chat.some((e) => e.text.includes("hello from helper") || e.text.includes("trip: Oct 3"))).toBe(false);

  // its claude: a turn's argv (the master's permission mode, tools and system prompt, no
  // --allowedTools), in the master's folder, with a /mcp key of its own; never warm
  const [master] = starts("turn");
  const scout = startOf("scout");
  expect(scout).toBeDefined();
  expect(flag(scout?.argv ?? [], "--permission-mode")).toBe("bypassPermissions");
  expect(scout?.argv).not.toContain("--allowedTools");
  expect(flag(scout?.argv ?? [], "--tools")).toBe(flag(master?.argv ?? [], "--tools"));
  expect(flag(scout?.argv ?? [], "--system-prompt")).toBe(flag(master?.argv ?? [], "--system-prompt"));
  expect(flag(scout?.argv ?? [], "--effort")).toBe("high");
  expect(scout?.cwd).toBe(dir);
  expect(mcpUrlOf(scout?.argv ?? [])).not.toBe(mcpUrlOf(master?.argv ?? []));
  expect(mcpUrlOf(scout?.argv ?? [])).toContain("&agent=scout");

  // what it did, for real, in the folder
  expect(readFileSync(`${dir}/scout.md`, "utf8")).toBe("written by scout\n");
  expect(readFileSync(`${dir}/ran.txt`, "utf8")).toBe(`ran in ${dir}\n`);
  // its side log: the write and the command answered, helper spawned on its own key, helper's
  // report taken between its steps, the read and the zoom, then its reply
  const side = await sideLog("scout");
  expect(side.map((e) => head(`${e.kind}${e.error ? "!" : ""}: ${e.text}`))).toEqual(
    [
      "user: Find when the trip is.",
      String.raw`tool: Write {"content":"written by scout\n","file_path":"scout.md"}`,
      `echo: File created successfully at: ${dir}/scout.md`,
      'tool: Bash {"command":"echo ran in $(pwd) > ran.txt && cat ran.txt"}',
      `echo: ran in ${dir}`,
      'tool: mcp__optchat__spawn {"name":"helper","task":"Say hello."}',
      `echo: Started helper on Claude Opus (Claude Code), directly in ${dir} on mini`,
      "user: [helper] hello from helper",
      `tool: Read {"file_path":"${dir}/notes.md"}`,
      "echo: trip: Oct 3",
      'tool: mcp__optchat__zoom {"id":0,"n":1}',
      "echo: 0+0|user: when is the trip? ask a subagent",
      "talk: The trip is on Oct 3.",
    ].map(head),
  );
  // helper was scout's: its own key, scout's folder, its report to scout and not the chat
  expect(await agent("helper")).toMatchObject({ folder: dir, parent: "scout", state: "done" });
  expect(mcpUrlOf(startOf("helper")?.argv ?? [])).toContain("&agent=helper");
  // a key nobody was given is refused; zoom("scout") on the master's key reads it
  expect(await fetch(`${base}/mcp?key=nobody`, { body: "{}", method: "POST" }).then((r) => r.status)).toBe(403);
  const zoomed = await mcpCall(mcpUrlOf(master?.argv ?? []), "zoom", { id: "scout" });
  expect(zoomed).toContain("scout: done, on claude-code:opus, 13 entries");

  // usage.jsonl: its call and helper's as a subagent's, with its name, ref and effort
  const usage = readFileSync(`${env.OPTCHAT_HOME}/usage.jsonl`, "utf8").trim().split("\n").map((l) => decodeUsage(l));
  expect(usage.filter((u) => u.role === "subagent").map((u) => [u.subagent, u.ref, u.effort, u.engine]).toSorted((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual([
    ["helper", "claude-code:opus", "high", "claude-code"],
    ["scout", "claude-code:opus", "high", "claude-code"],
  ]);
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
  await eventually("sleeper reads its opening", () => pidOf("sleeper") !== undefined);
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
  // nothing of either is in the chat but their reports
  const chat = await messages();
  expect(chat.filter((e) => e.text.startsWith("[")).map((e) => e.text.slice(0, 16))).toEqual(["[scout] The trip", "[sleeper] got yo", "[idler] stopped "]);
  ws.close();
}, 30_000);

test("an isolated subagent works in its own worktree; its commit is merged back into the repository when it ends", async () => {
  const { ws } = await client();
  send(ws, "add b.md on a branch", "m3");
  await eventually("brancher's report", async () => chatHas((e) => e.text.startsWith("[brancher] ")));
  const brancher = startOf("brancher");
  expect(brancher?.cwd).toBe(`${dir}/worktrees/brancher`);
  const side = await sideLog("brancher");
  expect(side.find((e) => e.kind === "echo")?.text).toBe("optchat/brancher");
  const chat = await messages();
  const report = chat.find((e) => e.text.startsWith("[brancher] "))?.text ?? "";
  expect(report).toContain("committed b.md\n[main fast-forwarded to optchat/brancher; its worktree and branch are removed; 1 files changed, +1 -0]");
  expect(readFileSync(`${repo}/b.md`, "utf8")).toBe("b\n");
  expect(git(repo, "log", "--format=%s", "-1")).toBe("add b");
  expect(existsSync(`${dir}/worktrees/brancher`)).toBe(false);
  expect(await agent("brancher")).toMatchObject({ isolated: true, merge: { files: 1, into: "main", outcome: "fast-forward" }, state: "done" });
  ws.close();
}, 30_000);

test("a subagent spawned on another device runs there, through its device runner", async () => {
  const { ws } = await client();
  send(ws, "look around the macbook", "m4");
  await eventually("roamer's report", async () => chatHas((e) => e.text.startsWith("[roamer] ")));
  const roamer = startOf("roamer");
  // started by the macbook's runner, in its folder, reaching /mcp at the server's public URL
  expect(roamer?.cwd).toBe(far);
  expect(mcpUrlOf(roamer?.argv ?? [])).toStartWith(`${base}/mcp?key=`);
  expect(flag(roamer?.argv ?? [], "--permission-mode")).toBe("bypassPermissions");
  const side = await sideLog("roamer");
  expect(side.map((e) => `${e.kind}: ${e.text}`)).toEqual(["user: Look around.", 'tool: Bash {"command":"pwd"}', `echo: ${far}`, "talk: roamed"]);
  expect(await agent("roamer")).toMatchObject({ device: "macbook", folder: far, state: "done" });
  const usage = readFileSync(`${env.OPTCHAT_HOME}/usage.jsonl`, "utf8").trim().split("\n").map((l) => decodeUsage(l));
  expect(usage.find((u) => u.subagent === "roamer")?.device).toBe("macbook");
  ws.close();
}, 30_000);

test("Stop all from Background work stops the turn and every running subagent", async () => {
  const { ws } = await client();
  send(ws, "start two that hang", "m5");
  await eventually("both running", async () => {
    const all = await agents();
    return ["stuck1", "stuck2"].every((n) => all.some((a) => a.name === n && a.state === "running"));
  });
  ws.send(JSON.stringify({ type: "stop-all" }));
  await eventually("both stopped", async () => {
    const all = await agents();
    return ["stuck1", "stuck2"].every((n) => all.some((a) => a.name === n && a.state === "stopped"));
  });
  await eventually("their reports", async () => {
    const chat = await messages();
    return chat.filter((e) => /^\[stuck[12]\] stopped after/.test(e.text)).length === 2;
  });
  ws.close();
}, 30_000);
