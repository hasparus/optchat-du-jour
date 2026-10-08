// The claude-code turn against the fake `claude` (ref §10): through the session, priming (E17), warm
// processes (E18), the MCP transport's fallback (E8), and what a compaction shares with a turn
// (the compactor's own tests are in claude-compactor.test.ts). Every test runs the fake, never
// `claude`, and every fake a test started must be gone when it ends.
import { expect, test } from "bun:test";
import { type AGUIEvent, EventType } from "@ag-ui/core";
import { type Duration, Effect, Fiber, PubSub } from "effect";
import { mkdirSync, writeFileSync } from "node:fs";
import { openChat } from "../src/chat.ts";
import { ClaudeError, Runner, type Spawn } from "../src/claude/process.ts";
import { type WarmOptions, warmRunner } from "../src/claude/warm.ts";
import { MASTER_TOOLS } from "../src/config.ts";
import { type McpSeen, mcpConfig, mcpTransports } from "../src/mcp.ts";
import { makeSession, noMedia, type SessionEvent } from "../src/session.ts";
import { openStream } from "../server/agui.ts";
import { newMsg } from "../src/store.ts";
import { makeGate, type Gate } from "../src/engines/inflight.ts";
import { claudeCodeCompactor } from "../src/summarize/claude-code.ts";
import { dayOf } from "../src/tree.ts";
import { cap } from "../src/cap.ts";
import { claudeCodeTurn, masterArgs, type Placement, primeBlocks } from "../src/turn/claude-code.ts";
import type { TurnEngine } from "../src/turn/engine.ts";
import type { UsageRecord } from "../src/usage.ts";
import { alive, run, scripted, textOf, tmp, until, withFakeClaude } from "./fake-claude-rig.ts";


withFakeClaude();

// the turn, driven through the session on a real chat. The compactor is a function here, so no
// compactor call ever starts.

const seedNotes = (dir: string, n: number, size: number) => {
  mkdirSync(`${dir}/chat/main`, { recursive: true });
  const day = new Date(2026, 9, 1, 12);
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify(newMsg(i, "note", `${i} ${"n".repeat(size)}`, day))).join("\n");
  writeFileSync(`${dir}/chat/main/${dayOf(day)}.jsonl`, `${lines}\n`);
};

type RigOptions = {
  readonly prime?: boolean;
  readonly idle?: Duration.Input;
  readonly seed?: number;
  readonly commit?: Effect.Effect<string | null>;
  readonly warm?: WarmOptions; // the fake behind a pool of warm processes
  readonly warms?: boolean; // the warm processes follow this engine: it heads the master's chain (default)
};

const rig = (f: ReturnType<typeof scripted>, o: RigOptions = {}) =>
  Effect.gen(function* () {
    const dir = tmp();
    // free level-0 lines; a few short ones make every node free, so nothing changes the view later
    if (o.seed) seedNotes(dir, o.seed, o.seed > 8 ? 480 : 40);
    const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
    const base = yield* Runner;
    const runner = o.warm ? yield* warmRunner(base, o.warm) : base;
    const reports: string[] = [], usage: UsageRecord[] = [];
    const report = (m: string) => Effect.sync(() => reports.push(m));
    // two devices on this machine: mini in the default folder, other in its own
    const other = tmp();
    const transports = mcpTransports("ws", report);
    const options = {
      effort: "high",
      logUsage: (r: UsageRecord) => Effect.sync(() => usage.push(r)),
      model: "opus",
      permissionMode: "bypassPermissions",
      primeTtl: "1h" as const,
      ref: "claude-code:opus",
      report,
      runnerFor: (device: string) =>
        Effect.sync(() => ({
          cwd: device === "other" ? other : undefined,
          mcpConfig: mcpConfig("http://127.0.0.1:9/mcp?key=k", transports.of(device)),
          mcpSeen: (seen: McpSeen) => transports.seen(device, seen),
          runner,
        })),
      instructions: "SYSTEM",
      tools: MASTER_TOOLS,
      ttl: "1h" as const,
      warms: () => o.warms ?? true,
    };
    const engine = yield* claudeCodeTurn(options);
    const engines: TurnEngine[] = [o.prime ? engine : { ref: engine.ref, run: engine.run, vision: engine.vision, warm: engine.warm }];
    const session = yield* makeSession({
      chat,
      commit: o.commit ?? Effect.succeed(null),
      defaultDevice: "mini",
      devices: ["mini", "other"],
      engines,
      idle: o.idle ?? "1 hour",
      logUsage: (r) => Effect.sync(() => usage.push(r)),
      media: noMedia,
    });
    const events: SessionEvent[] = [];
    const sub = yield* PubSub.subscribe(session.events);
    yield* PubSub.take(sub).pipe(
      Effect.tap((e) => Effect.sync(() => events.push(e))),
      Effect.forever,
      Effect.forkScoped,
    );
    const finished = (n: number) =>
      until(`${n} finished runs`, () => events.filter((e) => e.type === "run-finished").length >= n && session.state().phase === "idle");
    const log = () => chat.mem.root.map((m) => [m.kind, m.text]);
    const infos = () => events.flatMap((e) => (e.type === "info" ? [e.message] : []));
    return { chat, events, finished, infos, log, options, other, reports, session, usage };
  });

test("a turn's stream becomes the log in order: talk, tool, a capped echo; thinking only as its size", async () => {
  const output = `a\n${"x".repeat(40_000)}\nz`;
  const f = scripted({
    turn: [
      [
        { thinking: 120 },
        { text: "Let me look." },
        { tool: { input: { command: "ls" }, name: "Bash" } },
        { toolResult: output },
        { text: "Found it." },
      ],
    ],
  });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f);
      yield* r.session.input("hello");
      yield* r.finished(1);
      expect(r.log()).toEqual([
        ["user", "hello"],
        ["talk", "Let me look."],
        ["tool", 'Bash {"command":"ls"}'],
        ["echo", cap(output)],
        ["talk", "Found it."],
      ]);
      const echo = cap(output);
      expect(echo).toStartWith("a\nxxx");
      expect(echo).toEndWith("xxx\nz");
      expect(echo).toContain(`\n[… ${output.length - 30_000} chars cut …]\n`);
      expect(r.events.flatMap((e) => (e.type === "text" ? [e.delta] : []))).toEqual(["Let me look.", "Found it."]);
      // each delta names the index its talk entry then got
      expect(r.events.flatMap((e) => (e.type === "text" ? [e.at] : []))).toEqual([1, 4]);
      expect(r.events.flatMap((e) => (e.type === "thinking" ? [e.tokens] : []))).toEqual([120]);
      expect(r.usage.map((u) => [u.role, u.device, u.model])).toEqual([["turn", "mini", "opus"]]);
      expect(r.infos()).toEqual([]); // the optchat MCP server was connected
      expect(r.events.find((e) => e.type === "run-finished")).toMatchObject({ error: null });
    }),
  );
  expect(f.of("turn")).toHaveLength(1);
});

test("a message sent while a tool runs is taken at the tool boundary and logged as user, in the same call", async () => {
  const f = scripted({
    turn: [
      [
        { tool: { input: { command: "sleep 2" }, name: "Bash" } },
        { waitInput: true },
        { toolResult: "slept" },
        { take: true },
        { text: "Both done." },
      ],
    ],
  });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f);
      yield* r.session.input("first");
      yield* until("the tool call", () => r.chat.mem.root.some((m) => m.kind === "tool"));
      yield* r.session.input("second");
      yield* r.finished(1);
      expect(r.log()).toEqual([
        ["user", "first"],
        ["tool", 'Bash {"command":"sleep 2"}'],
        ["echo", "slept"],
        ["user", "second"],
        ["talk", "Both done."],
      ]);
      expect(r.session.state().pending).toEqual([]);
    }),
  );
  const [call] = f.of("turn");
  expect(f.of("turn")).toHaveLength(1);
  expect(call?.ins.map((m) => textOf(m.at(-1)))).toEqual(["first", "second"]);
});

test("a message that arrives after the last tool is requeued and gets a fresh call", async () => {
  const f = scripted({ turn: [[{ waitInput: true }, { text: "answer one" }], [{ text: "answer two" }]] });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f);
      yield* r.session.input("first");
      yield* until("the call", () => r.session.state().phase === "running" && f.of("turn")[0]?.ins.length === 1);
      yield* r.session.input("late");
      yield* r.finished(2);
      expect(r.log()).toEqual([
        ["user", "first"],
        ["talk", "answer one"],
        ["user", "late"],
        ["talk", "answer two"],
      ]);
    }),
  );
  const calls = f.of("turn");
  expect(calls).toHaveLength(2);
  expect(textOf(calls[1]?.ins[0]?.at(-1))).toBe("late");
});

test("a cancel kills the call and logs what it never took as unanswered user messages", async () => {
  const f = scripted({ turn: [[{ text: "working on it" }, { hang: true }]] });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f);
      yield* r.session.input("first");
      yield* until("the reply", () => r.chat.mem.root.some((m) => m.kind === "talk"));
      yield* r.session.input("never mind");
      yield* until("the mid-run message on stdin", () => f.of("turn")[0]?.ins.length === 2);
      yield* r.session.cancel;
      yield* until("the end of the loop", () => r.session.state().phase === "idle" && r.events.some((e) => e.type === "run-finished" && e.error === "cancelled"));
      expect(r.log()).toEqual([
        ["user", "first"],
        ["talk", "working on it"],
        ["user", "never mind"],
      ]);
      expect(r.session.state().pending).toEqual([]);
    }),
  );
});

test("a cancel mid-reply ends the run, and a client sees the partial closed before the next message takes its index", async () => {
  const delta = { event: { delta: { text: "Hello, I was ", type: "text_delta" }, type: "content_block_delta" }, type: "stream_event" };
  const f = scripted({ turn: [[{ emit: delta }, { hang: true }], [{ text: "fresh answer" }]] });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f);
      yield* r.session.input("first");
      yield* until("the partial reply", () => r.session.live()?.reply?.text === "Hello, I was ");
      // a client that connects now gets the reply so far
      const sub = yield* PubSub.subscribe(r.session.events);
      const { first, translate } = openStream({ entries: r.chat.mem.root, live: r.session.live(), state: r.session.state(), thread: "mini", window: 50 });
      const seen: AGUIEvent[] = [...first];
      yield* PubSub.take(sub).pipe(
        Effect.tap((e) => Effect.sync(() => seen.push(...translate(e)))),
        Effect.forever,
        Effect.forkScoped,
      );
      expect(seen.flatMap((e) => (e.type === EventType.TEXT_MESSAGE_CONTENT ? [[e.messageId, e.delta]] : []))).toEqual([["1", "Hello, I was "]]);

      yield* r.session.cancel;
      yield* r.session.input("next");
      yield* r.finished(2);
      expect(r.log()).toEqual([
        ["user", "first"],
        ["user", "next"],
        ["talk", "fresh answer"],
      ]);
      expect(r.events.flatMap((e) => (e.type === "run-finished" ? [e.error] : []))).toEqual(["cancelled", null]);
      yield* until("the client's last snapshot", () => seen.filter((e) => e.type === EventType.MESSAGES_SNAPSHOT).length === 3);
      const at = (ok: (e: AGUIEvent) => boolean) => seen.findIndex(ok);
      const closed = at((e) => e.type === EventType.TEXT_MESSAGE_END && e.messageId === "1");
      const next = at((e) => e.type === EventType.TEXT_MESSAGE_START && e.messageId === "1" && e.role === "user");
      const resync = seen.findIndex((e, k) => k > closed && e.type === EventType.MESSAGES_SNAPSHOT);
      expect(closed).toBeGreaterThan(-1);
      expect(resync).toBeGreaterThan(closed);
      expect(next).toBeGreaterThan(resync);
    }),
  );
});

test("a refusal, an error result and a crash are reported, and each ends its turn", async () => {
  const f = scripted({
    turn: [
      [{ result: { stop_reason: "refusal", text: "" } }],
      [{ result: { is_error: true, text: "API Error: 500 the server broke" } }],
      [{ exit: 3, stderr: "crashed hard" }],
    ],
  });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f);
      for (const [k, text] of ["a", "b", "c"].entries()) {
        yield* r.session.input(text);
        yield* r.finished(k + 1);
      }
      expect(r.log()).toEqual([
        ["user", "a"],
        ["user", "b"],
        ["user", "c"],
      ]);
      const infos = r.infos();
      expect(infos[0]).toBe("declined: the model would not answer this message");
      expect(infos[1]).toBe("error: API Error: 500 the server broke");
      expect(infos[2]).toMatch(/^error: claude exited \(code 3\): crashed hard/);
      const errors = r.events.flatMap((e) => (e.type === "run-finished" ? [e.error] : []));
      expect(errors).toHaveLength(3);
      expect(errors).not.toContain(null);
    }),
  );
  expect(f.of("turn")).toHaveLength(3);
});

test("a blank message starts nothing; one sent while the loop winds down gets its turn; idle comes after the commit", async () => {
  const f = scripted({ turn: [[{ text: "first answer" }], [{ text: "second answer" }]] });
  let commits = 0;
  const idleAt: number[] = []; // the commits done each time the session said idle
  await run(
    f,
    Effect.gen(function* () {
      const commit = Effect.sleep("150 millis").pipe(Effect.andThen(Effect.sync(() => ((commits += 1), null))));
      const r = yield* rig(f, { commit });
      const sub = yield* PubSub.subscribe(r.session.events);
      yield* PubSub.take(sub).pipe(
        Effect.tap((e) => Effect.sync(() => e.type === "state" && e.state.phase === "idle" && idleAt.push(commits))),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* r.session.input("  \n ");
      expect(r.session.state().phase).toBe("idle");
      yield* r.session.input("first");
      yield* until("the first run's end", () => r.events.some((e) => e.type === "run-finished"));
      expect(r.session.state().phase).not.toBe("idle"); // committing
      yield* r.session.input("second"); // the loop is still on, but past its last turn
      yield* r.finished(2);
      expect(r.log()).toEqual([
        ["user", "first"],
        ["talk", "first answer"],
        ["user", "second"],
        ["talk", "second answer"],
      ]);
      yield* until("the second commit", () => commits === 2 && idleAt.length > 0);
      expect(idleAt.every((n) => n > 0)).toBe(true);
    }),
  );
});

// a compaction sends what a turn sends before its view (docs/optchat.md §4, §5)

// the value after a flag in an argv
const flag = (argv: readonly string[] | undefined, name: string) => argv?.[argv.indexOf(name) + 1];

// the claude-code compactor: a turn's spawn, here on this machine
const placement = (runner: Runner["Service"]): Effect.Effect<Placement> =>
  Effect.succeed({ cwd: undefined, mcpConfig: mcpConfig("http://127.0.0.1:9/mcp?key=k", "http"), mcpSeen: () => Effect.succeed(false), runner });
const compactor = (o: {
  readonly ttl: "1h" | "5m";
  readonly log?: (r: UsageRecord) => Effect.Effect<void>;
  readonly timeout?: Duration.Input;
  readonly gate?: Gate;
  readonly placement?: Effect.Effect<Placement>;
}) =>
  Effect.gen(function* () {
    const runner = yield* Runner;
    return claudeCodeCompactor({
      effort: "medium",
      gate: o.gate ?? makeGate(),
      instructions: "SYSTEM",
      log: o.log ?? (() => Effect.void),
      model: "sonnet",
      placement: o.placement ?? placement(runner),
      tools: MASTER_TOOLS,
      ttl: o.ttl,
      timeout: o.timeout ?? "5 minutes",
    });
  });

test("claude-code: a turn and a compaction send the same system prompt, tools and MCP servers, from the same folder, and never share a warm process", async () => {
  const f = scripted();
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { prime: true });
      yield* r.session.input("hello");
      yield* r.finished(1);
      // the compactor runs where a turn on the server's own device runs (server/app.ts)
      const summarize = yield* compactor({ placement: r.options.runnerFor("mini"), ttl: "1h" });
      yield* summarize({ ctx: [], i: 0, l: 0, msg: newMsg(0, "user", "hello") });
    }),
  );
  const [turn] = f.of("turn"), [call] = f.of("compact");
  // what reaches the request before the view: the system prompt and the tools, built in and MCP
  for (const name of ["--system-prompt", "--tools", "--mcp-config", "--setting-sources"]) expect(flag(call?.argv, name)).toBe(flag(turn?.argv, name) ?? "");
  expect(call?.argv).toContain("--strict-mcp-config");
  expect(call?.cwd).toBe(turn?.cwd ?? "");
  // what differs: the model and its effort, the permission mode (refusing the tools that need one),
  // and no replays, which shape claude's output, not the request
  const differ = (turn?.argv ?? []).flatMap((a, k) => (call?.argv?.[k] === a ? [] : [a]));
  expect(differ).toEqual(["opus", "high", "bypassPermissions", "--replay-user-messages"]);
});

// priming

test("priming sends the turn's argv and the turn's view blocks with marks, plus ok", async () => {
  const f = scripted();
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { prime: true, seed: 120 });
      yield* r.session.primeSoon; // a client connects
      yield* until("the priming", () => r.usage.some((u) => u.role === "prime"));
      yield* r.session.input("hello");
      yield* r.finished(1);
      expect(r.usage.map((u) => u.role)).toEqual(["prime", "turn"]);
      expect(masterArgs({ ...r.options, mcpConfig: "{}" })).toContain("--replay-user-messages");
    }),
  );
  const [prime] = f.of("prime"), [turn] = f.of("turn");
  expect(prime?.argv).toEqual(turn?.argv ?? []);
  // the system prompt is inline, as it is on every device, never a file (SPEC "Multi-machine")
  const at = turn?.argv?.indexOf("--system-prompt") ?? -1;
  expect(at).toBeGreaterThan(-1);
  expect(turn?.argv?.[at + 1]).toBe("SYSTEM");
  expect(turn?.argv).not.toContain("--system-prompt-file");
  expect(prime?.env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", DISABLE_PROMPT_CACHING: "1" });
  expect(turn?.env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", DISABLE_PROMPT_CACHING: "" });
  const sent = turn?.ins[0] ?? [];
  const view = sent.slice(0, -1);
  expect(view.length).toBeGreaterThanOrEqual(2); // a view past the first mark
  expect(view.map(textOf).join("")).toStartWith("<chat>\n0+1|note: 0 ");
  expect(view.map(textOf).join("")).toEndWith("</chat>");
  expect(view.every((b) => b.cache_control === undefined)).toBe(true);
  expect(view.slice(0, -1).every((b) => textOf(b).match(/\n/g)?.length === 4)).toBe(true); // blocks of 4 lines
  expect(sent.at(-1)).toEqual({ text: "hello", type: "text" });
  // the same blocks, marked on the last whole one and on the view's end, then ok
  const primed = primeBlocks(view.map(textOf).join(""), "1h");
  expect(prime?.ins).toEqual([[...primed, { text: "ok", type: "text" }]]);
  const marked = primed.flatMap((b, k) => (b.cache_control ? [k] : []));
  expect(marked).toEqual([view.length - 2, view.length - 1]); // the last block ends in </chat>: partial
  expect(primed.map((b) => ({ ...b, cache_control: undefined }))).toEqual(view.map((b) => ({ ...b, cache_control: undefined })));
});

test("an idle view is primed once in the background, and not again while it is fresh", async () => {
  const f = scripted();
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { idle: "40 millis", prime: true, seed: 3 });
      yield* Effect.sleep("150 millis");
      expect(f.of("prime")).toHaveLength(0); // nothing is primed at startup
      yield* r.chat.log("note", "a new note changes the view");
      yield* until("the background priming", () => r.usage.some((u) => u.role === "prime"));
      yield* Effect.sleep("200 millis");
      yield* r.session.primeSoon; // a client connects: the same view, primed a moment ago
      yield* Effect.sleep("100 millis");
      expect(f.of("prime")).toHaveLength(1);
      expect(r.usage.filter((u) => u.role === "prime")).toHaveLength(1);
    }),
  );
});

test("a turn never primes first, nor waits for a priming in flight: it stops it and answers at once (E17)", async () => {
  // this priming would take 10 s to be accepted
  const f = scripted({ prime: [[{ sleep: 10_000 }, { text: "x" }]] });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { prime: true, seed: 3 });
      const phases: string[] = [];
      const sub = yield* PubSub.subscribe(r.session.events);
      yield* PubSub.take(sub).pipe(
        Effect.tap((e) => Effect.sync(() => (e.type === "state" ? phases.push(e.state.phase) : 0))),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* r.session.primeSoon; // a client connects
      yield* until("the priming call", () => f.of("prime")[0]?.ins.length === 1);
      const asked = Date.now();
      yield* r.session.input("hello");
      yield* until("the answer", () => r.log().some(([kind]) => kind === "talk"), 2000);
      expect(Date.now() - asked).toBeLessThan(2000);
      yield* r.finished(1);
      // the priming was stopped: its claude is gone, it logged no usage, and no phase waited for it
      const pid = f.of("prime")[0]?.pid ?? 0;
      yield* until("the priming's claude to end", () => !alive(pid));
      expect(r.usage.map((u) => u.role)).toEqual(["turn"]);
      expect(r.log().slice(3)).toEqual([
        ["user", "hello"],
        ["talk", "ok"],
      ]);
      yield* until("the idle state to reach a client", () => phases.includes("idle"));
      expect(new Set(phases)).toEqual(new Set(["running", "idle"]));
      expect(r.reports).toEqual([]); // a stopped priming is no failure
    }),
  );
  expect(f.of("prime")).toHaveLength(1);
});

test("priming that keeps failing is reported a single time, and every turn still runs", async () => {
  const f = scripted({ prime: [[{ exit: 1, stderr: "not logged in" }]] });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { idle: "40 millis", prime: true, seed: 3 });
      yield* r.session.input("a");
      yield* r.finished(1);
      yield* until("the priming after the first turn", () => f.of("prime").length === 1 && r.reports.length === 1);
      yield* r.session.input("b");
      yield* r.finished(2);
      yield* until("the priming after the second turn", () => f.of("prime").length === 2);
      yield* Effect.sleep("100 millis");
      expect(r.log().slice(3)).toEqual([
        ["user", "a"],
        ["talk", "ok"],
        ["user", "b"],
        ["talk", "ok"],
      ]);
      expect(r.reports).toHaveLength(1);
      expect(r.reports[0]).toMatch(/^priming failed, the turn goes on without it: claude exited \(code 1\): not logged in/);
    }),
  );
  expect(f.of("prime")).toHaveLength(2);
  expect(f.of("turn")).toHaveLength(2);
});

// warm processes (E18)

// the turn processes that got a message, and those that never did
const served = (f: ReturnType<typeof scripted>) => f.of("turn").filter((t) => t.ins.length > 0);
const idleTurns = (f: ReturnType<typeof scripted>) => f.of("turn").filter((t) => t.ins.length === 0);

test("the next turn and priming get processes started while idle; each one handed out is replaced", async () => {
  const f = scripted();
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { prime: true, seed: 3, warm: {} });
      // at startup: one turn and one priming process, waiting on stdin
      yield* until("the warm processes", () => f.of("turn").length === 1 && f.of("prime").length === 1);
      const [early] = f.of("turn");
      yield* Effect.sleep("100 millis");
      expect(f.of("turn").length + f.of("prime").length).toBe(2); // one each, no more
      yield* r.session.input("hello");
      yield* r.finished(1);
      // it was answered by the process started before the message, and a new one waits for the next
      expect(served(f).map((t) => t.pid)).toEqual([early?.pid ?? -1]);
      yield* until("the replacement", () => idleTurns(f).length === 1);
      // priming takes its warm process too, and a fresh one replaces it
      const warmPrime = f.of("prime")[0]?.pid;
      yield* r.session.primeSoon;
      yield* until("the priming", () => r.usage.some((u) => u.role === "prime"));
      expect(f.of("prime").find((p) => p.ins.length > 0)?.pid).toBe(warmPrime ?? -1);
      yield* until("the priming's replacement", () => f.of("prime").filter((p) => p.ins.length === 0).length === 1);
      yield* r.session.input("again");
      yield* r.finished(2);
      expect(served(f)).toHaveLength(2);
      expect(r.log().slice(3).map(([kind]) => kind)).toEqual(["user", "talk", "user", "talk"]);
    }),
  );
  // the scope's end killed the ones still waiting: afterEach checks none is left
});

test("a warm process that dies while idle is never handed out", async () => {
  const f = scripted();
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { seed: 3, warm: { retry: "1 hour" } });
      yield* until("the warm turn process", () => f.of("turn").length === 1);
      const dead = f.of("turn")[0]?.pid ?? 0;
      process.kill(dead, "SIGKILL");
      yield* until("it to die", () => !alive(dead));
      yield* Effect.sleep("50 millis");
      yield* r.session.input("hello");
      yield* r.finished(1);
      expect(r.log().slice(3)).toEqual([
        ["user", "hello"],
        ["talk", "ok"],
      ]);
      expect(served(f).map((t) => t.pid)).not.toContain(dead);
      expect(r.infos()).toEqual([]);
    }),
  );
});

test("a turn in another folder starts fresh, and the warm process stays unused for the next one", async () => {
  const f = scripted();
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { seed: 3, warm: {} });
      yield* until("the warm turn process", () => f.of("turn").length === 1);
      const warm = f.of("turn")[0];
      yield* r.session.input("/on other look there");
      yield* r.finished(1);
      // a fresh process in the other folder took it; the warm one still waits, untouched
      const [there] = served(f);
      expect(there?.cwd).toBe(r.other);
      expect(there?.pid).not.toBe(warm?.pid);
      expect(alive(warm?.pid ?? 0)).toBe(true);
      expect(warm && f.of("turn").find((t) => t.pid === warm.pid)?.ins).toEqual([]);
    }),
  );
  // the scope's end killed the warm one too: afterEach checks none is left
});

// a spawn to expect, by model
const expected = (model: string) => ({ args: ["-p", "--model", model], env: { CLAUDE_CODE_PROMPT_CACHE_TTL: "1h" } });

test("a pool keeps one process per expected spawn, and closes one no longer expected", async () => {
  const f = scripted();
  const idleWith = (model: string) => f.of("turn").filter((t) => t.argv?.includes(model) === true && t.ins.length === 0 && alive(t.pid));
  await run(
    f,
    Effect.gen(function* () {
      const pool = yield* warmRunner(yield* Runner);
      yield* pool.warm([expected("opus"), expected("opus")]); // the same spawn twice: one process
      yield* until("the opus process", () => idleWith("opus").length === 1);
      const opus = idleWith("opus")[0]?.pid ?? 0;
      yield* pool.warm([expected("opus")]); // named again: kept, not restarted
      yield* Effect.sleep("100 millis");
      expect(f.of("turn").map((t) => t.pid)).toEqual([opus]);
      // the next turn is expected on another model now: the stale process is killed, a new one started
      yield* pool.warm([expected("sonnet")]);
      yield* until("the stale process to end", () => !alive(opus));
      yield* until("the sonnet process", () => idleWith("sonnet").length === 1);
      expect(f.of("turn")).toHaveLength(2);
    }),
  );
});

// a spawn whose process ends as it starts, before reading stdin: the fake rejecting a ws MCP config
const dying = { ...expected("opus"), args: [...expected("opus").args, "--mcp-config", mcpConfig("http://127.0.0.1:9/mcp")] };
// when each start showed up in the log, polled
const startTimes = (f: ReturnType<typeof scripted>) => {
  const at: number[] = [];
  const poll = Effect.sync(() => {
    while (at.length < f.of("turn").length) at.push(Date.now());
  });
  return { at, poll: poll.pipe(Effect.andThen(Effect.sleep("5 millis")), Effect.forever, Effect.forkScoped) };
};

test("a process that keeps dying while idle is restarted after the retry delay, WARM_TRIES times in a row at most", async () => {
  const f = scripted({}, { FAKE_CLAUDE_NO_WS: "1" });
  const times = startTimes(f);
  await run(
    f,
    Effect.gen(function* () {
      yield* times.poll;
      const pool = yield* warmRunner(yield* Runner, { retry: "250 millis", tries: 2 });
      yield* pool.warm([dying]);
      yield* until("three starts", () => f.of("turn").length === 3);
      yield* Effect.sleep("600 millis");
      expect(f.of("turn")).toHaveLength(3); // the first one and two more: then it gives up
      const [t0 = 0, t1 = 0, t2 = 0] = times.at;
      expect(t1 - t0).toBeGreaterThanOrEqual(200);
      expect(t2 - t1).toBeGreaterThanOrEqual(200);
      // a spawn that starts claude again gets a new keeper, with its tries to spend again
      yield* Effect.scoped(Effect.flatMap(pool.spawn(dying), (claude) => claude.ended));
      yield* until("the new keeper's starts", () => f.of("turn").length === 7);
      yield* Effect.sleep("600 millis");
      expect(f.of("turn")).toHaveLength(7);
    }),
  );
}, 10_000);

test("a process that won't start counts as a death: retried with the same delay and cap", async () => {
  const f = scripted();
  let failures = 2;
  const attempts: number[] = [];
  await run(
    f,
    Effect.gen(function* () {
      const base = yield* Runner;
      const flaky = {
        spawn: (o: Spawn) =>
          Effect.suspend(() => {
            attempts.push(Date.now());
            if (failures <= 0) return base.spawn(o);
            failures -= 1;
            return Effect.fail(new ClaudeError({ message: "cannot start claude" }));
          }),
        warm: base.warm,
      };
      const pool = yield* warmRunner(flaky, { retry: "150 millis", tries: 3 });
      yield* pool.warm([expected("opus")]);
      yield* until("the process", () => f.of("turn").filter((t) => alive(t.pid)).length === 1);
      expect(attempts).toHaveLength(3);
      expect((attempts[2] ?? 0) - (attempts[0] ?? 0)).toBeGreaterThanOrEqual(250);
      // one that never starts: tries + 1 attempts, then none
      failures = Number.POSITIVE_INFINITY;
      yield* pool.warm([expected("sonnet")]);
      yield* until("the attempts", () => attempts.length === 3 + 4);
      yield* Effect.sleep("400 millis");
      expect(attempts).toHaveLength(7);
    }),
  );
});

test("a process older than maxAge is replaced by a new one, and killed", async () => {
  const f = scripted();
  await run(
    f,
    Effect.gen(function* () {
      const pool = yield* warmRunner(yield* Runner, { maxAge: "200 millis" });
      yield* pool.warm([expected("opus")]);
      yield* until("three generations", () => f.of("turn").length >= 3, 3000);
      const old = f.of("turn").slice(0, 2);
      yield* until("the old ones to end", () => old.every((t) => !alive(t.pid)));
      expect(f.of("turn").every((t) => t.ins.length === 0)).toBe(true);
      // the one handed out is a live one
      const claude = yield* pool.spawn(expected("opus"));
      yield* claude.send([{ text: "hi", type: "text" }]);
      yield* claude.result;
      expect(f.of("turn").filter((t) => t.ins.length > 0).map((t) => alive(t.pid))).toEqual([true]);
    }),
  );
});

test("a spawn interrupted while it takes a warm process leaves none behind", async () => {
  const f = scripted();
  await run(
    f,
    Effect.gen(function* () {
      const pool = yield* warmRunner(yield* Runner, { retry: "1 hour" });
      yield* pool.warm([expected("opus")]);
      for (let k = 0; k < 12; k++) {
        yield* until("a warm process", () => f.of("turn").some((t) => alive(t.pid) && t.ins.length === 0));
        yield* Effect.sleep("30 millis");
        const taking = yield* Effect.forkChild(Effect.scoped(pool.spawn(expected("opus"))));
        for (let y = 0; y < k; y++) yield* Effect.yieldNow;
        yield* Fiber.interrupt(taking);
      }
      // every process taken went with its caller's scope; only the one waiting in the slot is left
      yield* until("one process left", () => f.of("turn").filter((t) => alive(t.pid)).length === 1);
      yield* Effect.sleep("200 millis");
      expect(f.of("turn").filter((t) => alive(t.pid))).toHaveLength(1);
    }),
  );
});

// the MCP transport (E8)

const configOf = (argv: readonly string[] | undefined) => argv?.[argv.indexOf("--mcp-config") + 1] ?? "";
const overHttp = (t: { readonly argv?: readonly string[] | undefined }) => configOf(t.argv).includes('"type":"http"');

test("a claude that lists optchat over ws as failed moves its device to http, said once; the next calls use http", async () => {
  const f = scripted({}, { FAKE_CLAUDE_WS_STATUS: "failed" });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { prime: true, seed: 3 });
      yield* r.session.primeSoon; // priming is the first call: its init shows it
      yield* until("the fallback", () => r.reports.length === 1);
      expect(r.reports[0]).toBe("zoom and date over WebSocket did not work for claude on mini (MCP server optchat is failed); trying HTTP there from now on");
      yield* r.session.input("hello");
      yield* r.finished(1);
      expect(r.infos()).toEqual([]); // the turn had zoom and date
      expect(r.reports).toHaveLength(1);
    }),
  );
  expect(configOf(f.of("prime")[0]?.argv)).toContain('"type":"ws"');
  expect(configOf(f.of("turn")[0]?.argv)).toContain('"type":"http","url":"http://127.0.0.1:9/mcp?key=k"');
});

test("a claude that rejects the ws config and ends before init moves its device to http, and warm processes start for http", async () => {
  const f = scripted({}, { FAKE_CLAUDE_NO_WS: "1" });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { prime: true, seed: 3, warm: { retry: "1 hour" } });
      // the warm ws processes die as they start; priming starts one more, which dies before init
      yield* r.session.primeSoon;
      yield* until("the fallback", () => r.reports.length === 2);
      expect(r.reports[0]).toBe(
        "zoom and date over WebSocket did not work for claude on mini (its MCP config was rejected: claude exited (code 1): Error: Invalid MCP configuration:\nmcpServers.optchat: Does not adhere to MCP server configuration schema); trying HTTP there from now on",
      );
      expect(r.reports[1]).toStartWith("priming failed, the turn goes on without it: claude exited (code 1): Error: Invalid MCP configuration");
      // the device was warmed again: a turn and a priming process over http wait for the next calls
      yield* until("warm http processes", () => f.of("turn").some((t) => overHttp(t) && alive(t.pid)) && f.of("prime").some((p) => overHttp(p) && alive(p.pid)));
      const ready = f.of("turn").find(overHttp);
      yield* r.session.input("hello");
      yield* r.finished(1);
      expect(served(f).map((t) => t.pid)).toEqual([ready?.pid ?? -1]);
      expect(r.log().slice(3)).toEqual([
        ["user", "hello"],
        ["talk", "ok"],
      ]);
      expect(r.reports).toHaveLength(2);
    }),
  );
});

test("an engine the warm processes don't follow leaves them to the session's next warm after a transport move", async () => {
  const f = scripted({}, { FAKE_CLAUDE_NO_WS: "1" });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { prime: true, seed: 3, warms: false, warm: { retry: "1 hour" } });
      yield* r.session.primeSoon;
      yield* until("the fallback", () => r.reports.length === 2);
      yield* Effect.sleep("300 millis");
      expect(f.of("turn").some(overHttp)).toBe(false); // its own spawns would have taken the followed engine's place
      // the session warms the latest turn's engine when it goes idle after the next turn
      yield* r.session.input("hello");
      yield* r.finished(1);
      yield* until("a warm http process besides the turn's own", () => f.of("turn").some((t) => overHttp(t) && alive(t.pid)) && f.of("turn").filter(overHttp).length >= 2);
    }),
  );
});

test("a turn whose claude rejects the ws config fails; the device moves to http and the next turn runs", async () => {
  const f = scripted({}, { FAKE_CLAUDE_NO_WS: "1" });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { seed: 3 });
      yield* r.session.input("a");
      yield* r.finished(1);
      expect(r.infos()[0]).toStartWith("error: claude exited (code 1): Error: Invalid MCP configuration");
      expect(r.reports).toHaveLength(1);
      yield* r.session.input("b");
      yield* r.finished(2);
      expect(r.log().slice(3)).toEqual([
        ["user", "a"],
        ["user", "b"],
        ["talk", "ok"],
      ]);
    }),
  );
  expect(f.of("turn").map((t) => configOf(t.argv).includes('"type":"ws"'))).toEqual([true, false]);
});

test("pending or needs-auth keep ws: the turn says it has no zoom or date, the transport stays", async () => {
  for (const status of ["pending", "needs-auth"]) {
    const f = scripted({}, { FAKE_CLAUDE_WS_STATUS: status });
    await run(
      f,
      Effect.gen(function* () {
        const r = yield* rig(f, { seed: 3 });
        for (const [k, text] of ["a", "b"].entries()) {
          yield* r.session.input(text);
          yield* r.finished(k + 1);
        }
        const notice = `no zoom or date in this turn: MCP server optchat is ${status}`;
        expect(r.infos()).toEqual([notice, notice]);
        expect(r.reports).toEqual([]);
      }),
    );
    expect(f.of("turn").map((t) => configOf(t.argv).includes('"type":"ws"'))).toEqual([true, true]);
  }
});
