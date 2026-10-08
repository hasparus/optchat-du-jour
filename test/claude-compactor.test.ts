// The claude-code compactor against the fake `claude` (docs/optchat.md §4; ref §10): its spawn and
// request, a tool call that ends a try, the size retries, the wait on a call writing the same
// marked prefix (§3.3), and a hung call. Every test runs the fake, never `claude`.
import { expect, test } from "bun:test";
import { type Duration, Effect } from "effect";
import { baseArgs } from "../src/claude/args.ts";
import { Runner } from "../src/claude/process.ts";
import { openChat } from "../src/chat.ts";
import { CompactError, type Job } from "../src/compactor.ts";
import { MASTER_TOOLS } from "../src/config.ts";
import { makeGate, type Gate } from "../src/engines/inflight.ts";
import { mcpConfig } from "../src/mcp.ts";
import { newMsg } from "../src/store.ts";
import { warmRunner } from "../src/claude/warm.ts";
import { blocks, claudeCodeCompactor, compactSpawn, markedPrefix } from "../src/summarize/claude-code.ts";
import { retryText, task } from "../src/summarize/step.ts";
import { built, getNode } from "../src/tree.ts";
import type { Placement } from "../src/turn/claude-code.ts";
import type { UsageRecord } from "../src/usage.ts";
import { long, run, scripted, textOf, tmp, until, withFakeClaude } from "./fake-claude-rig.ts";

withFakeClaude();


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

test("a compactor call: a turn's argv but model, effort and permission mode; context pieces of 4 lines, marks on the last whole one and the task", async () => {
  const f = scripted();
  const ctx = Array.from({ length: 260 }, (_, k) => `${k}+1|${"c".repeat(395)}`); // <chat>, 260 lines, </chat>: 65 whole blocks and a partial one
  const job: Job = { ctx, i: 260, l: 0, msg: newMsg(260, "user", "line one\nline two") };
  const usage: UsageRecord[] = [];
  const line = await run(
    f,
    Effect.gen(function* () {
      const summarize = yield* compactor({ log: (r) => Effect.sync(() => usage.push(r)), ttl: "5m" });
      return yield* summarize(job);
    }),
  );
  expect(line).toBe("talk: a short summary line");

  const [call] = f.of("compact");
  const mcp = mcpConfig("http://127.0.0.1:9/mcp?key=k", "http");
  // a turn's flags but for the model, effort and permission mode, and no replays
  expect(call?.argv).toEqual([...baseArgs({ effort: "medium", model: "sonnet", system: "SYSTEM", tools: MASTER_TOOLS.join(",") }), "--mcp-config", mcp, "--permission-mode", "default"]);
  expect(call?.argv).not.toContain("--safe-mode"); // it would drop the MCP servers, and with them zoom and date
  expect(call?.env).toEqual({ CLAUDE_CODE_PROMPT_CACHE_TTL: "5m", DISABLE_PROMPT_CACHING: "1" });
  expect(call?.ins).toEqual([blocks(job, "5m")]);

  const sent = call?.ins[0] ?? [];
  expect(sent).toHaveLength(67);
  const pieces = sent.slice(0, 66);
  expect(pieces.map(textOf).join("")).toBe(["<chat>", ...ctx, "</chat>"].join("\n"));
  for (const p of pieces.slice(0, 65)) expect(textOf(p).match(/\n/g)).toHaveLength(4);
  expect(textOf(pieces[65])).toBe(`${ctx.at(-1)}\n</chat>`); // 261 lines end in a line break: 65 blocks and one over
  // two marks: the last whole piece, for the next call's lookback, and the request's end
  const mark = { ttl: "5m", type: "ephemeral" } as const;
  expect(sent.map((b) => b.cache_control ?? null)).toEqual(sent.map((_, k) => (k === 64 || k === 66 ? mark : null)));
  expect(textOf(sent[66])).toBe(task(job));
  expect(markedPrefix(sent)).toEqual(pieces.slice(0, 65).map(textOf));

  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ attempt: 1, engine: "claude-code", failoverFrom: null, level: 0, model: "sonnet", role: "compact" });
});

test("a compactor's spawn is never pooled: nothing is kept warm for it, and a warm twin is never handed to it (E18)", async () => {
  const f = scripted();
  await run(
    f,
    Effect.gen(function* () {
      const runner = yield* Runner;
      const pool = yield* warmRunner(runner, { retry: "1 hour" });
      const p = yield* placement(runner);
      const spec = compactSpawn({ effort: "medium", instructions: "SYSTEM", model: "sonnet", tools: MASTER_TOOLS, ttl: "1h" }, p);
      expect(spec.pooled).toBe(false);
      yield* pool.warm([spec]);
      yield* Effect.sleep("300 millis");
      expect(f.of("compact")).toHaveLength(0); // nothing started ahead for it
      yield* pool.warm([{ ...spec, pooled: true }]); // the same spawn, poolable: one starts ahead
      yield* until("the warm twin", () => f.of("compact").length === 1);
      const claude = yield* pool.spawn(spec);
      yield* claude.send([{ text: "hi", type: "text" }]);
      yield* until("a fresh process", () => f.of("compact").length === 2);
      yield* until("its message", () => f.of("compact").some((c) => c.ins.length > 0));
      expect(f.of("compact").find((c) => c.ins.length > 0)?.pid).toBe(f.of("compact")[1]?.pid); // not the warm one
    }),
  );
});

test("a compactor that calls a tool anyway has failed that call; the tool's result never comes", async () => {
  const f = scripted({ compact: [[{ tool: { input: { command: "rm -rf /" }, name: "Bash" } }, { toolResult: "never" }, { text: "talk: too late" }]] });
  const failed = await run(
    f,
    Effect.gen(function* () {
      const summarize = yield* compactor({ ttl: "1h" });
      return yield* Effect.flip(summarize({ ctx: [], i: 0, l: 0, msg: newMsg(0, "user", long(900)) }));
    }),
  );
  expect(failed.message).toBe("the compactor called a tool");
});

test("a tool call ends the try as soon as its block starts streaming, before claude could run it", async () => {
  // the call's block starts, and nothing follows: only the start can end the try
  const toolStart = { emit: { event: { content_block: { id: "toolu_1", input: {}, name: "Read", type: "tool_use" }, index: 0, type: "content_block_start" }, type: "stream_event" } };
  const f = scripted({ compact: [[toolStart, { hang: true }]] });
  const failed = await run(
    f,
    Effect.gen(function* () {
      const summarize = yield* compactor({ timeout: "3 seconds", ttl: "1h" });
      return yield* Effect.flip(summarize({ ctx: [], i: 0, l: 0, msg: newMsg(0, "user", long(900)) }));
    }),
  );
  expect(failed.message).toBe("the compactor called a tool");
});

test("a line over 512 bytes is retried in the same call with docs/optchat.md §4's text, and the shortest try is kept", async () => {
  const over = `${"x".repeat(511)}ä${"y".repeat(87)}`; // 600 bytes, with a character across the cut
  const tries = [over, "b".repeat(530), "c".repeat(700), "d".repeat(520), "e".repeat(560)];
  const f = scripted({ compact: [tries.map((t) => [{ text: t }]), [[{ text: over }], [{ text: "talk: short enough" }]]] });
  const usage: UsageRecord[] = [];
  const job: Job = { ctx: ["0+1|user: earlier"], i: 3, l: 0, msg: newMsg(3, "echo", long(900)) };
  const [stubborn, quick] = await run(
    f,
    Effect.gen(function* () {
      const summarize = yield* compactor({ log: (r) => Effect.sync(() => usage.push(r)), ttl: "1h" });
      return [yield* summarize(job, "openai-plan:luna"), yield* summarize(job)];
    }),
  );
  expect(stubborn).toBe("d".repeat(520)); // TRIES spent: the shortest, a few bytes over
  expect(quick).toBe("talk: short enough"); // stops as soon as it fits

  const [first, second] = f.of("compact");
  expect(first?.ins).toHaveLength(5);
  expect(first?.ins[1]).toEqual([
    {
      text: `Too long: your line is 600 bytes, over the 512-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${"x".repeat(511)}| ← LIMIT`,
      type: "text",
    },
  ]);
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

test("an empty answer to a size retry ends the call with the shortest line before it", async () => {
  const over = `talk: ${"x".repeat(594)}`;
  const f = scripted({ compact: [[[{ text: over }], [{ result: { text: "" } }]]] });
  const line = await run(
    f,
    Effect.gen(function* () {
      const summarize = yield* compactor({ ttl: "1h" });
      return yield* summarize({ ctx: [], i: 0, l: 0, msg: newMsg(0, "user", long(900)) });
    }),
  );
  expect(line).toBe(over);
  expect(f.of("compact")[0]?.ins).toHaveLength(2);
});

test("compactions on one marked prefix: the first writes it, the rest wait for its response to start", async () => {
  // every call takes 300 ms to start its response; all three ask with the same context
  const slow = [{ sleep: 300 }, { text: "talk: done" }];
  const f = scripted({ compact: [slow] });
  const ctx = Array.from({ length: 8 }, (_, k) => `${k}+1|user: line ${k}`); // two whole blocks: the second carries the mark
  const jobs: Job[] = [8, 9, 10].map((i) => ({ ctx, i, l: 0, msg: newMsg(i, "user", long(900)) }));
  const gate = makeGate();
  await run(
    f,
    Effect.gen(function* () {
      const summarize = yield* compactor({ gate, ttl: "1h" });
      yield* Effect.forEach(jobs, (j) => summarize(j), { concurrency: "unbounded", discard: true });
    }),
  );
  const asked = f.of("compact").map((c) => c.asked ?? 0).toSorted((a, b) => a - b);
  expect(asked).toHaveLength(3);
  // one went at once; the two others only once its response had started, together
  expect((asked[1] ?? 0) - (asked[0] ?? 0)).toBeGreaterThanOrEqual(250);
  expect((asked[2] ?? 0) - (asked[1] ?? 0)).toBeLessThan(250);
});

test("compactions with no marked prefix in common, or with another context, never wait", async () => {
  const f = scripted({ compact: [[{ sleep: 300 }, { text: "talk: done" }]] });
  const jobs: Job[] = [
    { ctx: [], i: 0, l: 0, msg: newMsg(0, "user", long(900)) }, // nothing marked but the task
    { ctx: [], i: 1, l: 0, msg: newMsg(1, "user", long(900)) },
    { ctx: Array.from({ length: 4 }, (_, k) => `${k}+1|a`), i: 4, l: 0, msg: newMsg(4, "user", long(900)) },
    { ctx: Array.from({ length: 4 }, (_, k) => `${k}+1|b`), i: 4, l: 0, msg: newMsg(4, "user", long(900)) },
  ];
  await run(
    f,
    Effect.gen(function* () {
      const summarize = yield* compactor({ gate: makeGate(), ttl: "1h" });
      yield* Effect.forEach(jobs, (j) => summarize(j), { concurrency: "unbounded", discard: true });
    }),
  );
  const asked = f.of("compact").map((c) => c.asked ?? 0);
  expect(Math.max(...asked) - Math.min(...asked)).toBeLessThan(250);
});

test("a hung compactor call times out and fails the node; the pump reports it once and builds it at the next message", async () => {
  const f = scripted({ compact: [[{ hang: true }], [{ text: "echo: built on the second call" }]] });
  const reports: string[] = [];
  const dir = tmp();
  await run(
    f,
    Effect.gen(function* () {
      const engine = yield* compactor({ timeout: "300 millis", ttl: "1h" });
      const chat = yield* openChat(dir, {
        report: (m) => Effect.sync(() => reports.push(m)),
        summarize: (job) => engine(job).pipe(Effect.mapError((e) => new CompactError({ message: e.message }))),
      });
      yield* chat.log("echo", long(900));
      yield* until("the report", () => reports.length > 0);
      yield* chat.log("user", "hi"); // the next message: the failed call is tried again
      yield* until("the node", () => built(chat.mem, { i: 0, l: 0 }));
      expect(getNode(chat.mem, { i: 0, l: 0 })?.text).toBe("echo: built on the second call");
    }),
  );
  expect(reports).toHaveLength(1);
  expect(reports[0]).toMatch(/^0\+1: no answer within /);
  expect(f.of("compact")).toHaveLength(2); // the hung one is gone: afterEach checks it
});
