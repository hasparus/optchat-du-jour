// Single flight on every block prefix, with TTLs (E50; docs/optchat.md §3.3, after UniiChat's
// AskAI.keys and AskAI.wait). Real api-key compactor calls against a fake vendor whose prompt
// cache works as §3.3 says Anthropic's does: an entry only at a marked block, found from a mark by
// looking back at most LOOKBACK blocks, there from the response's first event on, kept five
// minutes from its last read. The fake counts the requests and the blocks each one writes to the
// cache. Time is the TestClock's.
import { expect, test } from "bun:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { Job } from "../src/compactor.ts";
import { LOOKBACK, MASTER_TOOLS } from "../src/config.ts";
import { type Gate, makeGate, type Prefix } from "../src/engines/inflight.ts";
import { isPicture } from "../src/media/part.ts";
import type { Provider } from "../src/providers/provider.ts";
import { newMsg } from "../src/store.ts";
import { apiKeyCompactor } from "../src/summarize/api-key.ts";
import { blocks } from "../src/summarize/claude-code.ts";
import { claudePrefix, primeBlocks } from "../src/turn/claude-code.ts";

const TTL = Duration.toMillis(Duration.minutes(5));
const RESPONSE = Duration.toMillis(Duration.seconds(1)); // from a request to its first response event

// One request as the vendor saw it: when it came, and how many blocks it wrote to the cache
type Seen = { readonly at: number; readonly wrote: number };

// `hangs`: the requests (by their number, from 0) whose response never starts
const vendor = (hangs: readonly number[] = []) => {
  const entries = new Map<string, number>(); // a marked prefix, by its blocks, and until when it is kept
  const seen: Seen[] = [];
  const provider: Provider = {
    auth: "api-key",
    call: (c) =>
      Effect.gen(function* () {
        const first = c.history[0];
        const parts = first?.type === "user" ? first.parts.flatMap((p) => (isPicture(p) ? [] : [p])) : [];
        const mark = first?.type === "user" ? (first.mark ?? -1) : -1;
        const key = (k: number) => parts.slice(0, k + 1).join("\u0000");
        const now = yield* Effect.clockWith((clock) => Effect.sync(() => clock.currentTimeMillisUnsafe()));
        // the longest entry on one of its block boundaries within the lookback; a read keeps it longer
        let hit = mark;
        while (hit >= Math.max(0, mark - LOOKBACK) && (entries.get(key(hit)) ?? 0) <= now) hit--;
        if (hit < Math.max(0, mark - LOOKBACK)) hit = -1;
        if (hit >= 0) entries.set(key(hit), now + TTL);
        const n = seen.push({ at: now, wrote: mark - hit }) - 1;
        if (hangs.includes(n)) return yield* Effect.never;
        yield* Effect.sleep(RESPONSE);
        if (mark >= 0) entries.set(key(mark), now + RESPONSE + TTL); // written once the response starts
        yield* c.onStart ?? Effect.void;
        return { items: [{ text: "user: a line", type: "text" }], model: "fake", usage: { cacheRead: 0, cacheWrite: 0, input: 1, output: 1 } };
      }),
    engine: "api-key",
  };
  return { provider, seen };
};

// <chat>, then n lines of the same chat, then </chat>: (n + 1) / 4 whole blocks when n + 1 is a
// multiple of 4, the last of them marked
const line = (k: number) => `${k}+1|user: line ${k} ${"z".repeat(200)}`;
const job = (lines: number, i = lines): Job => ({ ctx: Array.from({ length: lines }, (_, k) => line(k)), i, l: 0, msg: newMsg(i, "user", "squeeze me") });

// compactions of `jobs`, all at once, in their order, on `gate`
const compact = (gate: Gate, provider: Provider, jobs: readonly Job[]) => {
  const summarize = apiKeyCompactor({ effort: "medium", gate, instructions: "SYSTEM", log: () => Effect.void, model: "fake", provider, tools: [] });
  return Effect.forEach(jobs, (j) => summarize(j), { concurrency: "unbounded", discard: true });
};

// the forked fibers run until they wait on the clock or on each other
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true });
const advance = (d: Duration.Input) => Effect.andThen(settle, Effect.andThen(TestClock.adjust(d), settle));
const run = async <A>(eff: Effect.Effect<A, unknown>) => Effect.runPromise(Effect.scoped(eff).pipe(Effect.provide(TestClock.layer())));

// no single flight at all, and the old one, which waited only on a call writing the very same prefix
const none: Gate = { through: (_prefix, call) => call(Effect.void) };
const exactOnly = (gate: Gate): Gate => ({
  through: (prefix, call) => gate.through(prefix && { keys: prefix.keys.slice(-1), marks: [0], ttl: prefix.ttl }, call),
});

test("compactions whose contexts extend each other: the first writes its prefix, each longer one waits and writes only the blocks after it", async () => {
  // contexts of 7, 11, 15 and 19 lines, marked on blocks 1, 2, 3 and 4: each a prefix of the next
  const jobs = [7, 11, 15, 19].map((n) => job(n));
  const writes = async (gate: Gate) =>
    run(
      Effect.gen(function* () {
        const v = vendor();
        const all = yield* Effect.forkChild(compact(gate, v.provider, jobs));
        for (let s = 0; s < 6; s++) yield* advance(RESPONSE);
        yield* Fiber.join(all);
        return v.seen;
      }),
    );
  const prefixes = await writes(makeGate());
  // one request each; the shortest went at once, every other one once the one before had started
  expect(prefixes).toEqual([0, 1, 2, 3].map((k) => ({ at: k * RESPONSE, wrote: k === 0 ? 2 : 1 })));
  // without single flight, or with the old one (no two of them share their whole prefix), all go
  // at once and each writes its whole context
  for (const gate of [none, exactOnly(makeGate())]) expect(await writes(gate)).toEqual([2, 3, 4, 5].map((wrote) => ({ at: 0, wrote })));
  // 5 blocks written instead of 14
});

test("a prefix beyond the lookback is no reason to wait: only a call that can read the writer's entry waits for it", async () => {
  // the 79-line context's mark (block 19) reaches back to block 1, the 99-line one's (block 24) to block 4
  const seen = await run(
    Effect.gen(function* () {
      const v = vendor();
      const all = yield* Effect.forkChild(compact(makeGate(), v.provider, [job(7), job(79), job(99)]));
      for (let s = 0; s < 4; s++) yield* advance(RESPONSE);
      yield* Fiber.join(all);
      return v.seen;
    }),
  );
  expect(seen).toEqual([
    { at: 0, wrote: 2 },
    { at: 0, wrote: 25 }, // the 99-line one went at once: it could never read block 1
    { at: RESPONSE, wrote: 18 }, // the 79-line one waited, then wrote blocks 2 to 19
  ]);
});

test("a writer stuck before its response holds its prefix for FLIGHT_WAIT at most; then the next call writes it, and later ones wait on that one", async () => {
  const seen = await run(
    Effect.gen(function* () {
      const v = vendor([0]); // the first request never gets a response
      const gate = makeGate();
      const first = yield* Effect.forkChild(compact(gate, v.provider, [job(7)]));
      yield* settle;
      const waiting = yield* Effect.forkChild(compact(gate, v.provider, [job(11)]));
      yield* advance("29 seconds");
      expect(v.seen).toHaveLength(1); // still waiting on the stuck one
      yield* advance("1 second");
      expect(v.seen).toHaveLength(2); // its claim lapsed: the waiter went
      const later = yield* Effect.forkChild(compact(gate, v.provider, [job(15)]));
      yield* advance(RESPONSE);
      yield* advance(RESPONSE);
      yield* Fiber.join(waiting);
      yield* Fiber.join(later);
      yield* Fiber.interrupt(first);
      return v.seen;
    }),
  );
  expect(seen).toEqual([
    { at: 0, wrote: 2 }, // stuck: it wrote nothing anyone could read
    { at: 30_000, wrote: 3 }, // the waiter, once the claim lapsed: blocks 0 to 2
    { at: 30_000 + RESPONSE, wrote: 1 }, // came while that one wrote, waited for it, wrote block 3
  ]);
});

// minutes and seconds on the TestClock, in ms
const at = (m: number, s: number) => (m * 60 + s) * 1000;

test("a prefix written within its TTL is read without a wait; past its TTL the next call writes it again and the others wait", async () => {
  const seen = await run(
    Effect.gen(function* () {
      const v = vendor();
      const gate = makeGate();
      const pair = (after: Duration.Input) =>
        Effect.gen(function* () {
          yield* advance(after);
          const both = yield* Effect.forkChild(compact(gate, v.provider, [job(7), job(7, 8)]));
          yield* advance(RESPONSE);
          yield* advance(RESPONSE);
          yield* Fiber.join(both);
        });
      const once = yield* Effect.forkChild(compact(gate, v.provider, [job(7)]));
      yield* advance(RESPONSE);
      yield* Fiber.join(once); // written at 1 s, kept to 5 min 1 s
      yield* pair("4 minutes"); // read at 4 min 1 s, kept to 9 min 1 s
      yield* pair("4 minutes"); // read again at 8 min 3 s
      yield* pair("6 minutes"); // at 14 min 5 s: gone
      return v.seen;
    }),
  );
  expect(seen).toEqual([
    { at: at(0, 0), wrote: 2 },
    { at: at(4, 1), wrote: 0 },
    { at: at(4, 1), wrote: 0 }, // both at once: the gate knew the prefix was there
    { at: at(8, 3), wrote: 0 },
    { at: at(8, 3), wrote: 0 }, // the read at 4 min kept it, there and in the gate
    { at: at(14, 5), wrote: 2 },
    { at: at(14, 6), wrote: 0 }, // past its TTL: one wrote it again, the other waited and read it
  ]);
});

// which of two calls started together goes first: the first writes, and starts its response a
// second later
const race = async (first: Prefix | null, second: Prefix | null) =>
  run(
    Effect.gen(function* () {
      const order: string[] = [];
      const gate = makeGate();
      const a = gate.through(first, (begun) => Effect.sleep(RESPONSE).pipe(Effect.andThen(Effect.sync(() => void order.push("first started"))), Effect.andThen(begun)));
      const b = gate.through(second, () => Effect.sync(() => void order.push("second sent")));
      const both = yield* Effect.forkChild(Effect.all([a, b], { concurrency: "unbounded" }));
      yield* advance(RESPONSE);
      yield* Fiber.join(both);
      return order;
    }),
  );

test("priming and a claude-code compaction on the same model and effort share whole blocks of the view, so one waits on the other", async () => {
  const o = { effort: "high", instructions: "SYSTEM", model: "opus", tools: MASTER_TOOLS };
  const view = ["<chat>", ...Array.from({ length: 11 }, (_, k) => line(k)), "</chat>"].join("\n");
  const primed = claudePrefix(o, [...primeBlocks(view, "1h"), { text: "ok", type: "text" }], "1h");
  // compactions whose context is the view up to their node: the compaction view not merged further
  const shorter = claudePrefix(o, blocks(job(7), "1h"), "1h");
  const same = claudePrefix(o, blocks(job(11), "1h"), "1h");
  expect(primed?.marks).toEqual([2, 3]); // the last whole block and the view's end
  expect(shorter?.keys).toEqual(primed?.keys.slice(0, 2));
  expect(same?.keys).toEqual(primed?.keys.slice(0, 3));
  // on another model they share nothing
  expect(claudePrefix({ ...o, model: "haiku" }, blocks(job(7), "1h"), "1h")?.keys[0]).not.toBe(primed?.keys[0]);

  expect(await race(shorter, primed)).toEqual(["first started", "second sent"]); // priming reads what the compaction wrote
  expect(await race(primed, same)).toEqual(["first started", "second sent"]); // the compaction reads priming's whole-block entry
  expect(await race(primed, shorter)).toEqual(["second sent", "first started"]); // priming's entries end past it: nothing to wait for
});
