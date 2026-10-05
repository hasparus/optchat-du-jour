// The claude-code engines against the fake `claude` (ref §10): the compactor's request and its
// retries, the turn through the session, and priming. Every test runs the fake, never `claude`,
// and every fake a test started must be gone when it ends.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { type AGUIEvent, EventType } from "@ag-ui/core";
import { BunServices } from "@effect/platform-bun";
import { type Duration, Effect, Layer, PubSub, Schema, type Scope } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import { baseArgs } from "../src/claude/args.ts";
import type { Block } from "../src/claude/events.ts";
import { LocalRunner, Runner } from "../src/claude/process.ts";
import { CompactError, type Job } from "../src/compactor.ts";
import { MASTER_TOOLS } from "../src/config.ts";
import { mcpConfig } from "../src/mcp.ts";
import { COMPACT_FILE, SCALE } from "../src/prompts.ts";
import { makeSession, type SessionEvent } from "../src/session.ts";
import { openStream } from "../server/agui.ts";
import { newMsg } from "../src/store.ts";
import { blocks, claudeCodeCompactor } from "../src/summarize/claude-code.ts";
import { retryText } from "../src/summarize/step.ts";
import { built, bytes, dayOf, getNode } from "../src/tree.ts";
import { cap, claudeCodeTurn, masterArgs } from "../src/turn/claude-code.ts";
import type { TurnEngine } from "../src/turn/engine.ts";
import type { UsageRecord } from "../src/usage.ts";

const FAKE_BIN = `${import.meta.dir}/fake-claude.ts`;

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(`${tmpdir()}/oc-`); // short: socket paths stop at ~107 characters
  dirs.push(d);
  return d;
};

// a test that could spawn `claude` spawns the fake; between tests a stray spawn runs /bin/false
beforeEach(() => {
  Bun.env.OPTCHAT_CLAUDE = FAKE_BIN;
});

// what the fake writes to its log (see its header)
const SentBlock = Schema.Struct({
  cache_control: Schema.optional(Schema.Struct({ ttl: Schema.optional(Schema.Literals(["1h", "5m"])), type: Schema.Literal("ephemeral") })),
  text: Schema.String,
  type: Schema.Literal("text"),
});
const Rec = Schema.Struct({
  argv: Schema.optional(Schema.Array(Schema.String)),
  call: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.Number),
  content: Schema.optional(Schema.Array(SentBlock)),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
  pid: Schema.Number,
  role: Schema.optional(Schema.Literals(["compact", "prime", "turn"])),
  type: Schema.Literals(["start", "in", "exit"]),
});
type Rec = typeof Rec.Type;
const decodeRec = Schema.decodeUnknownSync(Schema.fromJsonString(Rec));

const fakes: { log: string }[] = [];
const records = (log: string): Rec[] => {
  if (!existsSync(log)) return [];
  const text = readFileSync(log, "utf8");
  return text.split("\n").flatMap((line) => (line === "" ? [] : [decodeRec(line)]));
};

// a process is running: it exists, and it is not a zombie (/proc/PID/stat, state after the name)
const alive = (pid: number) => {
  const stat = `/proc/${pid}/stat`;
  if (!existsSync(stat)) return false;
  try {
    return readFileSync(stat, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    return false; // gone between the two calls
  }
};

// every fake a test started has exited; one still running is killed and fails the test
afterEach(async () => {
  Bun.env.OPTCHAT_CLAUDE = "/bin/false";
  const pids = fakes.splice(0).flatMap((f) => records(f.log).filter((r) => r.type === "start").map((r) => r.pid));
  const deadline = Date.now() + 3000;
  while (pids.some(alive) && Date.now() < deadline) await Bun.sleep(10);
  const left = pids.filter(alive);
  for (const pid of left) process.kill(pid, "SIGKILL");
  expect(left).toEqual([]);
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

type Script = { turn?: unknown[]; prime?: unknown[]; compact?: unknown[] };

// a fake with its script, and a Runner that starts it with that script and its own log
function scripted(script: Script = {}) {
  const dir = tmp();
  const f = { log: `${dir}/fake.jsonl`, script: `${dir}/plan.json` };
  writeFileSync(f.script, JSON.stringify(script));
  fakes.push(f);
  const layer = Layer.effect(
    Runner,
    Effect.gen(function* () {
      const base = yield* Runner;
      return {
        // the variables optchat sets are passed even when empty, so this shell's own can't leak in
        spawn: (o: Parameters<typeof base.spawn>[0]) =>
          base.spawn({ ...o, env: { CLAUDE_CODE_PROMPT_CACHE_TTL: "", DISABLE_PROMPT_CACHING: "", ...o.env, FAKE_CLAUDE_LOG: f.log, FAKE_CLAUDE_SCRIPT: f.script } }),
      };
    }),
  ).pipe(Layer.provide(LocalRunner), Layer.provide(BunServices.layer));
  const of = (role: "compact" | "prime" | "turn") => {
    const all = records(f.log);
    return all
      .filter((r) => r.type === "start" && r.role === role)
      .map((s) => ({ ...s, ins: all.filter((r) => r.type === "in" && r.pid === s.pid).map((r) => r.content ?? []) }));
  };
  return { ...f, layer, of };
}

const run = async <A, E>(f: { layer: Layer.Layer<Runner> }, effect: Effect.Effect<A, E, Runner | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(f.layer)));

// polls a condition on the real clock
const until = (what: string, ok: () => boolean, ms = 4000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("5 millis");
    }
  });

const textOf = (b: Block | undefined) => b?.text ?? "";
const long = (n: number) => "w".repeat(n);

// the compactor engine

test("a compactor call: four marked context pieces at the marks, the unmarked step, its flags and env", async () => {
  const f = scripted();
  const ctx = Array.from({ length: 260 }, (_, k) => `${k} ${"c".repeat(395)}`); // ~104k chars: every mark is used
  const job: Job = { ctx, i: 260, l: 0, msg: newMsg(260, "user", "line one\nline two") };
  const usage: UsageRecord[] = [];
  const line = await run(
    f,
    Effect.gen(function* () {
      const summarize = yield* claudeCodeCompactor({ effort: "medium", log: (r) => Effect.sync(() => usage.push(r)), model: "sonnet", ttl: "5m" });
      return yield* summarize(job);
    }),
  );
  expect(line).toBe("talk: a short summary line");

  const [call] = f.of("compact");
  expect(call?.argv).toEqual([...baseArgs({ effort: "medium", model: "sonnet", systemFile: COMPACT_FILE, tools: "" }), "--safe-mode"]);
  expect(call?.env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m", DISABLE_PROMPT_CACHING: "1" });
  expect(call?.ins).toEqual([blocks(job, "5m")]);

  const sent = call?.ins[0] ?? [];
  expect(sent).toHaveLength(5);
  const pieces = sent.slice(0, 4);
  for (const p of pieces) expect(p.cache_control).toEqual({ ttl: "5m", type: "ephemeral" });
  expect(pieces.map(textOf).join("")).toBe(["<chat>", ...ctx, "</chat>"].join("\n"));
  let end = 0;
  for (const [k, mark] of [50_000, 80_000, 100_000].entries()) {
    end += textOf(pieces[k]).length;
    expect(end).toBeLessThanOrEqual(mark);
    expect(end).toBeGreaterThan(mark - 400); // the last line end before the mark, not an earlier one
    expect(textOf(pieces[k]).endsWith("\n")).toBe(true);
  }
  const stepBlock = sent[4];
  expect(stepBlock?.cache_control).toBeUndefined();
  expect(bytes(SCALE)).toBe(512);
  expect(textOf(stepBlock)).toBe(
    `For scale, this line is exactly 512 bytes:\n${SCALE}\n\nCompress this message into one line, in at most 512 bytes:\nuser: line one\nline two`,
  );
  const merge = blocks({ a: "user: a\nb", b: "talk: c", ctx: [], i: 0, l: 1 }, "1h");
  expect(merge.map(textOf)).toEqual(["<chat>\n</chat>", `For scale, this line is exactly 512 bytes:\n${SCALE}\n\nMerge these two lines into one, in at most 512 bytes:\nuser: a b\ntalk: c`]);

  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ attempt: 1, engine: "claude-code", failoverFrom: null, level: 0, model: "sonnet", role: "compact" });
});

test("a line over 512 bytes is retried in the same call with the gist's text, and the shortest try is kept", async () => {
  const over = `${"x".repeat(511)}ä${"y".repeat(87)}`; // 600 bytes, with a character across the cut
  const tries = [over, "b".repeat(530), "c".repeat(700), "d".repeat(520), "e".repeat(560)];
  const f = scripted({ compact: [tries.map((t) => [{ text: t }]), [[{ text: over }], [{ text: "talk: short enough" }]]] });
  const usage: UsageRecord[] = [];
  const job: Job = { ctx: ["user: earlier"], i: 3, l: 0, msg: newMsg(3, "echo", long(900)) };
  const [stubborn, quick] = await run(
    f,
    Effect.gen(function* () {
      const summarize = yield* claudeCodeCompactor({ effort: "medium", log: (r) => Effect.sync(() => usage.push(r)), model: "sonnet", ttl: "1h" });
      return [yield* summarize(job, "openai-plan:luna"), yield* summarize(job)];
    }),
  );
  expect(stubborn).toBe("d".repeat(520)); // TRIES spent: the shortest, a few bytes over
  expect(quick).toBe("talk: short enough"); // stops as soon as it fits

  const [first, second] = f.of("compact");
  expect(first?.ins).toHaveLength(5);
  expect(first?.ins[1]).toEqual([{ text: `That line is 600 bytes; the limit is 512. It must end where it is cut here:\n${"x".repeat(511)}| ← LIMIT`, type: "text" }]);
  expect(first?.ins.slice(2).map((m) => textOf(m[0]))).toEqual(tries.slice(1, 4).map(retryText));
  expect(second?.ins).toHaveLength(2);
  expect(usage.map((u) => [u.attempt, u.failoverFrom])).toEqual([
    [1, "openai-plan:luna"],
    [2, "openai-plan:luna"],
    [3, "openai-plan:luna"],
    [4, "openai-plan:luna"],
    [5, "openai-plan:luna"],
    [1, null],
    [2, null],
  ]);
});

test("a hung compactor call times out and fails the node; the pump reports it once and builds it on the retry", async () => {
  const f = scripted({ compact: [[{ hang: true }], [{ text: "echo: built on the second call" }]] });
  const reports: string[] = [];
  const dir = tmp();
  await run(
    f,
    Effect.gen(function* () {
      const engine = yield* claudeCodeCompactor({ effort: "medium", log: () => Effect.void, model: "sonnet", timeout: "300 millis", ttl: "1h" });
      const chat = yield* openChat(dir, {
        report: (m) => Effect.sync(() => reports.push(m)),
        retry: "50 millis",
        summarize: (job) => engine(job).pipe(Effect.mapError((e) => new CompactError({ message: e.message }))),
      });
      yield* chat.log("echo", long(900));
      yield* until("the node", () => built(chat.mem, { i: 0, l: 0 }));
      expect(getNode(chat.mem, { i: 0, l: 0 })?.text).toBe("echo: built on the second call");
    }),
  );
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatch(/^0\+1: no answer within /);
  expect(f.of("compact")).toHaveLength(2); // the hung one is gone: afterEach checks it
});

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
};

const rig = (f: ReturnType<typeof scripted>, o: RigOptions = {}) =>
  Effect.gen(function* () {
    const dir = tmp();
    // free level-0 lines; a few short ones make every node free, so nothing changes the view later
    if (o.seed) seedNotes(dir, o.seed, o.seed > 8 ? 480 : 40);
    const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
    const runner = yield* Runner;
    const reports: string[] = [], usage: UsageRecord[] = [];
    const options = {
      effort: "high",
      logUsage: (r: UsageRecord) => Effect.sync(() => usage.push(r)),
      mcpConfig: mcpConfig("http://127.0.0.1:9/mcp?key=k"),
      model: "opus",
      permissionMode: "bypassPermissions",
      primeTtl: "1h" as const,
      report: (m: string) => Effect.sync(() => reports.push(m)),
      runnerFor: () => Effect.succeed({ runner }),
      systemFile: "/dev/null",
      tools: MASTER_TOOLS,
      ttl: "1h" as const,
    };
    const engine = yield* claudeCodeTurn(options);
    const engines: TurnEngine[] = [o.prime ? engine : { ref: engine.ref, run: engine.run }];
    const session = yield* makeSession({
      chat,
      commit: o.commit ?? Effect.succeed(null),
      defaultDevice: "mini",
      devices: ["mini"],
      engines,
      idle: o.idle ?? "1 hour",
      logUsage: (r) => Effect.sync(() => usage.push(r)),
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
    return { chat, events, finished, infos, log, options, reports, session, usage };
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
      expect(r.session.state().queued).toEqual([]);
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
      expect(r.session.state().queued).toEqual([]);
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

// priming

test("priming sends the turn's argv and the turn's view blocks with marks, plus ok", async () => {
  const f = scripted();
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { prime: true, seed: 120 });
      yield* r.session.input("hello");
      yield* r.finished(1);
      expect(r.usage.map((u) => u.role)).toEqual(["prime", "turn"]);
      expect(masterArgs(r.options)).toContain("--replay-user-messages");
    }),
  );
  const [prime] = f.of("prime"), [turn] = f.of("turn");
  expect(prime?.argv).toEqual(turn?.argv ?? []);
  expect(prime?.env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", DISABLE_PROMPT_CACHING: "1" });
  expect(turn?.env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "1h", DISABLE_PROMPT_CACHING: "" });
  const sent = turn?.ins[0] ?? [];
  const view = sent.slice(0, -1);
  expect(view.length).toBeGreaterThanOrEqual(2); // a view past the first mark
  expect(view.map(textOf).join("")).toStartWith("<chat>\n0+1|note: 0 ");
  expect(view.map(textOf).join("")).toEndWith("</chat>");
  expect(view.every((b) => b.cache_control === undefined)).toBe(true);
  expect(sent.at(-1)).toEqual({ text: "hello", type: "text" });
  expect(prime?.ins).toEqual([[...view.map((b) => ({ ...b, cache_control: { ttl: "1h" as const, type: "ephemeral" as const } })), { text: "ok", type: "text" }]]);
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

test("a cancel during the turn's own priming ends the wait at once; the priming call finishes in the background", async () => {
  const f = scripted({ prime: [[{ sleep: 600 }, { text: "x" }]] });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { prime: true, seed: 3 });
      yield* r.session.input("hello");
      yield* until("the priming call", () => r.session.state().phase === "priming" && f.of("prime").length === 1);
      yield* r.session.cancel;
      yield* until("idle", () => r.session.state().phase === "idle");
      expect(r.usage).toEqual([]); // the priming has not been accepted yet
      expect(r.log().slice(3)).toEqual([["user", "hello"]]);
      yield* until("the priming's usage", () => r.usage.some((u) => u.role === "prime"));
      expect(f.of("turn")).toHaveLength(0);
    }),
  );
});

test("priming that keeps failing is reported a single time, and every turn still runs", async () => {
  const f = scripted({ prime: [[{ exit: 1, stderr: "not logged in" }]] });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { prime: true, seed: 3 });
      yield* r.session.input("a");
      yield* r.finished(1);
      yield* r.session.input("b");
      yield* r.finished(2);
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
