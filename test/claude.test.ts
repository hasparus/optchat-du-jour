// The claude-code engines against the fake `claude` (ref §10): the compactor's request and its
// retries, the turn through the session, and priming. Every test runs the fake, never `claude`,
// and every fake a test started must be gone when it ends.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
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
import { newMsg } from "../src/store.ts";
import { blocks, claudeCodeCompactor, retryText } from "../src/summarize/claude-code.ts";
import { built, bytes, dayOf, getNode } from "../src/tree.ts";
import { cap, claudeCodeTurn, masterArgs } from "../src/turn/claude-code.ts";
import type { TurnEngine } from "../src/turn/engine.ts";
import type { UsageRecord } from "../src/usage.ts";

const FAKE = new URL("fake-claude.ts", import.meta.url).pathname;

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(`${tmpdir()}/oc-`); // short: socket paths stop at ~107 characters
  dirs.push(d);
  return d;
};

// a test that could spawn `claude` spawns the fake; between tests a stray spawn runs /bin/false
beforeEach(() => {
  Bun.env.OPTCHAT_CLAUDE = FAKE;
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
const records = (log: string): Rec[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => decodeRec(l))
    : [];

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z"; // a zombie is gone too
  } catch {
    return false;
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
function fake(script: Script = {}) {
  const dir = tmp();
  const f = { log: `${dir}/fake.jsonl`, script: `${dir}/script.json` };
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

// ---------------------------------------------------------------------------------------------
// the compactor engine

test("a compactor call: four marked context pieces at the marks, the unmarked step, its flags and env", async () => {
  const f = fake();
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
  const f = fake({ compact: [tries.map((t) => [{ text: t }]), [[{ text: over }], [{ text: "talk: short enough" }]]] });
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
  const f = fake({ compact: [[{ hang: true }], [{ text: "echo: built on the second call" }]] });
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
      yield* until("the node", () => built(chat.mem, 0, 0));
      expect(getNode(chat.mem, 0, 0)?.text).toBe("echo: built on the second call");
    }),
  );
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatch(/^0\+1: no answer within /);
  expect(f.of("compact")).toHaveLength(2); // the hung one is gone: afterEach checks it
});

// ---------------------------------------------------------------------------------------------
// the turn, driven through the session on a real chat. The compactor is a function here, so no
// compactor call ever starts.

const seedNotes = (dir: string, n: number, size: number) => {
  mkdirSync(`${dir}/chat/main`, { recursive: true });
  const day = new Date(2026, 9, 1, 12);
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify(newMsg(i, "note", `${i} ${"n".repeat(size)}`, day))).join("\n");
  writeFileSync(`${dir}/chat/main/${dayOf(day)}.jsonl`, `${lines}\n`);
};

const rig = (f: ReturnType<typeof fake>, o: { readonly prime?: boolean; readonly idle?: Duration.Input; readonly seed?: number } = {}) =>
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
      model: "opus",
      permissionMode: "bypassPermissions",
      primeTtl: "1h" as const,
      report: (m: string) => Effect.sync(() => reports.push(m)),
      runnerFor: () => Effect.succeed({ cwd: undefined, mcpConfig: mcpConfig("http://127.0.0.1:9/mcp?key=k"), runner }),
      systemFile: "/dev/null",
      tools: MASTER_TOOLS,
      ttl: "1h" as const,
    };
    const engine = yield* claudeCodeTurn(options);
    const engines: TurnEngine[] = [o.prime ? engine : { ref: engine.ref, run: engine.run }];
    const session = yield* makeSession({
      chat,
      commit: Effect.succeed(null),
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
  const f = fake({
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
      expect(r.events.flatMap((e) => (e.type === "thinking" ? [e.tokens] : []))).toEqual([120]);
      expect(r.usage.map((u) => [u.role, u.device, u.model])).toEqual([["turn", "mini", "opus"]]);
      expect(r.infos()).toEqual([]); // the optchat MCP server was connected
      expect(r.events.find((e) => e.type === "run-finished")).toMatchObject({ error: null });
    }),
  );
  expect(f.of("turn")).toHaveLength(1);
});

test("a message sent while a tool runs is taken at the tool boundary and logged as user, in the same call", async () => {
  const f = fake({
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
  const f = fake({ turn: [[{ waitInput: true }, { text: "answer one" }], [{ text: "answer two" }]] });
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
  const f = fake({ turn: [[{ text: "working on it" }, { hang: true }]] });
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f);
      yield* r.session.input("first");
      yield* until("the reply", () => r.chat.mem.root.some((m) => m.kind === "talk"));
      yield* r.session.input("never mind");
      yield* until("the mid-run message on stdin", () => f.of("turn")[0]?.ins.length === 2);
      yield* r.session.cancel;
      yield* until("the end of the loop", () => r.session.state().phase === "idle" && r.infos().includes("cancelled"));
      expect(r.log()).toEqual([
        ["user", "first"],
        ["talk", "working on it"],
        ["user", "never mind"],
      ]);
      expect(r.session.state().queued).toEqual([]);
    }),
  );
});

test("a refusal, an error result and a crash are reported, and each ends its turn", async () => {
  const f = fake({
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
      expect(infos[0]).toBe("the model refused this request (stop_reason: refusal)");
      expect(infos[1]).toBe("error: API Error: 500 the server broke");
      expect(infos[2]).toMatch(/^error: claude exited \(code 3\): crashed hard/);
      const errors = r.events.flatMap((e) => (e.type === "run-finished" ? [e.error] : []));
      expect(errors).toHaveLength(3);
      expect(errors).not.toContain(null);
    }),
  );
  expect(f.of("turn")).toHaveLength(3);
});

// ---------------------------------------------------------------------------------------------
// priming

test("priming sends the turn's argv and the turn's view blocks with marks, plus ok", async () => {
  const f = fake();
  await run(
    f,
    Effect.gen(function* () {
      const r = yield* rig(f, { prime: true, seed: 120 });
      yield* r.session.input("hello");
      yield* r.finished(1);
      expect(r.usage.map((u) => u.role)).toEqual(["prime", "turn"]);
      expect(masterArgs({ ...r.options, mcpConfig: "{}" })).toContain("--replay-user-messages");
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
  const f = fake();
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

test("a failing priming is reported once, and the turns go on without it", async () => {
  const f = fake({ prime: [[{ exit: 1, stderr: "not logged in" }]] });
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
