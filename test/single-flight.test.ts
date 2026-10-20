// Single flight on every block prefix, with TTLs (E50; docs/optchat.md §3.3, after UniiChat's
// AskAI.keys and AskAI.wait). Real api-key compactor calls against a fake vendor whose prompt
// cache works as §3.3 says Anthropic's does: an entry only at a marked block, found from a mark by
// looking back at most LOOKBACK blocks, there once the response begins (message_start, onStart),
// kept five minutes from its last read. The fake counts the requests and the blocks each one
// writes to the cache. Time is the TestClock's.
import { expect, test } from "bun:test";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import type { Job } from "../src/compactor.ts";
import { LOOKBACK, MASTER_TOOLS } from "../src/config.ts";
import { ModelError } from "../src/engines/errors.ts";
import { type Gate, makeGate, type Prefix } from "../src/engines/inflight.ts";
import { isPicture } from "../src/media/part.ts";
import type { Provider } from "../src/providers/provider.ts";
import { newMsg } from "../src/store.ts";
import { apiKeyCompactor } from "../src/summarize/api-key.ts";
import { blocks, claudePrefix } from "../src/summarize/claude-code.ts";

const TTL = Duration.toMillis(Duration.minutes(5));
const RESPONSE = Duration.toMillis(Duration.seconds(1)); // from a request to its first response event

// One request as the vendor saw it: when it came, how many blocks it wrote to the cache, and when
// its answer was done (null: it never was)
type Seen = { readonly at: number; readonly wrote: number; done: number | null };

// `hangs`: the requests (by their number, from 0) whose response never begins; `fails`: those that
// fail before it begins; `answer`: how long an answer takes after its response begins
const vendor = (o: { readonly hangs?: readonly number[]; readonly fails?: readonly number[]; readonly answer?: number } = {}) => {
  const entries = new Map<string, number>(); // a marked prefix, by its blocks, and until when it is kept
  const seen: Seen[] = [];
  const now = Effect.clockWith((clock) => Effect.sync(() => clock.currentTimeMillisUnsafe()));
  const provider: Provider = {
    auth: "api-key",
    call: (c) =>
      Effect.gen(function* () {
        const first = c.history[0];
        const parts = first?.type === "user" ? first.parts.flatMap((p) => (isPicture(p) ? [] : [p])) : [];
        const mark = first?.type === "user" ? (first.mark ?? -1) : -1;
        const key = (k: number) => parts.slice(0, k + 1).join("\u0000");
        const sent = yield* now;
        const n = seen.length;
        if (o.fails?.includes(n)) {
          // turned away before the cache is looked at (an overload, say)
          seen.push({ at: sent, done: null, wrote: 0 });
          yield* Effect.sleep(RESPONSE);
          return yield* new ModelError({ message: "overloaded before the response began" });
        }
        // the longest entry on one of its block boundaries within the lookback; a read keeps it longer
        let hit = mark;
        while (hit >= Math.max(0, mark - LOOKBACK) && (entries.get(key(hit)) ?? 0) <= sent) hit--;
        if (hit < Math.max(0, mark - LOOKBACK)) hit = -1;
        if (hit >= 0) entries.set(key(hit), sent + TTL);
        const request: Seen = { at: sent, done: null, wrote: mark - hit };
        seen.push(request);
        if (o.hangs?.includes(n)) return yield* Effect.never;
        yield* Effect.sleep(RESPONSE);
        if (mark >= 0) entries.set(key(mark), sent + RESPONSE + TTL); // written once the response begins
        yield* c.onStart ?? Effect.void;
        yield* Effect.sleep(o.answer ?? 0);
        request.done = yield* now;
        return { items: [{ text: "user: a line", type: "text" }], model: "fake", usage: { cacheRead: 0, cacheWrite: 0, input: 1, output: 1 } };
      }),
    engine: "api-key",
  };
  return { provider, seen };
};
const sent = (seen: readonly Seen[]) => seen.map(({ at, wrote }) => ({ at, wrote }));
// when the last of them was answered
const last = (seen: readonly Seen[]) => Math.max(...seen.map((s) => s.done ?? Infinity));

// <chat>, then n lines of the same chat, then </chat>: (n + 1) / 4 whole blocks when n + 1 is a
// multiple of 4, the last of them marked
const line = (k: number) => `${k}+1|user: line ${k} ${"z".repeat(200)}`;
const job = (lines: number, i = lines): Job => ({ ctx: Array.from({ length: lines }, (_, k) => line(k)), i, l: 0, msg: newMsg(i, "user", "squeeze me") });

// compactions of `jobs`, all at once, in their order, on `gate`; a failed one is let be
const compact = (gate: Gate, provider: Provider, jobs: readonly Job[]) => {
  const summarize = apiKeyCompactor({ effort: "medium", gate, instructions: "SYSTEM", log: () => Effect.void, model: "fake", provider, tools: [] });
  return Effect.forEach(jobs, (j) => Effect.ignore(summarize(j)), { concurrency: "unbounded", discard: true });
};

// the forked fibers run until they wait on the clock or on each other
const settle = Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true });
const advance = (d: Duration.Input) => Effect.andThen(settle, Effect.andThen(TestClock.adjust(d), settle));
const run = async <A>(eff: Effect.Effect<A, unknown>) => Effect.runPromise(Effect.scoped(eff).pipe(Effect.provide(TestClock.layer())));
// minutes and seconds on the TestClock, in ms
const at = (m: number, s: number) => (m * 60 + s) * 1000;

// no single flight at all, and the old one, which waited only on a call writing the very same prefix
const none: Gate = { through: (_prefix, call) => call(Effect.void) };
const exactOnly = (gate: Gate): Gate => ({
  through: (prefix, call) => gate.through(prefix && { keys: prefix.keys.slice(-1), marks: [0], ttl: prefix.ttl }, call),
});

// the requests of compactions of `jobs` started together, run until all are answered or failed
const together = async (gate: Gate, jobs: readonly Job[], o: Parameters<typeof vendor>[0] = {}) =>
  run(
    Effect.gen(function* () {
      const v = vendor(o);
      const all = yield* Effect.forkChild(compact(gate, v.provider, jobs));
      for (let s = 0; s < 3 * jobs.length + 4; s++) yield* advance(RESPONSE);
      yield* Fiber.join(all);
      return v.seen;
    }),
  );

test("compactions whose contexts extend each other wait once, on the first writer, then each writes only past what it wrote", async () => {
  // contexts of 7, 11, 15 and 19 lines, marked on blocks 1, 2, 3 and 4: each a prefix of the next
  const jobs = [7, 11, 15, 19].map((n) => job(n));
  // the shortest went at once; the others once its response began, together, each reading its blocks
  expect(sent(await together(makeGate(), jobs))).toEqual([
    { at: 0, wrote: 2 },
    { at: RESPONSE, wrote: 1 },
    { at: RESPONSE, wrote: 2 },
    { at: RESPONSE, wrote: 3 },
  ]);
  // without single flight, or with the old one (no two of them share their whole prefix), all go
  // at once and each writes its whole context: 14 blocks instead of 8
  for (const gate of [none, exactOnly(makeGate())]) expect(sent(await together(gate, jobs))).toEqual([2, 3, 4, 5].map((wrote) => ({ at: 0, wrote })));
});

test("eight compactions on nested contexts are all answered within one first-response time of no single flight at all", async () => {
  // a merge batch: contexts of 7 to 35 lines, each extending the one before; an answer takes 3 s
  // after its response begins
  const jobs = [7, 11, 15, 19, 23, 27, 31, 35].map((n) => job(n));
  const free = await together(none, jobs, { answer: 3 * RESPONSE });
  const gated = await together(makeGate(), jobs, { answer: 3 * RESPONSE });
  expect(last(free)).toBe(4 * RESPONSE);
  expect(last(gated)).toBe(last(free) + RESPONSE);
  // and it wrote 2 + 7 × (its own tail) blocks, against 2 + 3 + … + 9
  expect(gated.reduce((n, s) => n + s.wrote, 0)).toBe(2 + [1, 2, 3, 4, 5, 6, 7].reduce((a, b) => a + b, 0));
  expect(free.reduce((n, s) => n + s.wrote, 0)).toBe([2, 3, 4, 5, 6, 7, 8, 9].reduce((a, b) => a + b, 0));
});

test("a prefix beyond the lookback is no reason to wait: only a call that can read the writer's entry waits for it", async () => {
  // the 79-line context's mark (block 19) reaches back to block 1, the 99-line one's (block 24) to block 4
  expect(sent(await together(makeGate(), [job(7), job(79), job(99)]))).toEqual([
    { at: 0, wrote: 2 },
    { at: 0, wrote: 25 }, // the 99-line one went at once: it could never read block 1
    { at: RESPONSE, wrote: 18 }, // the 79-line one waited, then wrote blocks 2 to 19
  ]);
});

test("a writer stuck before its response holds its prefix for FLIGHT_WAIT at most; then the next call writes it, and later ones wait on that one", async () => {
  const seen = await run(
    Effect.gen(function* () {
      const v = vendor({ hangs: [0] }); // the first request never gets a response
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
      // the stuck one's own prefix, asked for again: its lapsed claim holds nothing, so one call
      // writes it and the other waits for that one
      const again = yield* Effect.forkChild(compact(gate, v.provider, [job(7, 8), job(7, 9)]));
      yield* advance(RESPONSE);
      yield* advance(RESPONSE);
      yield* Fiber.join(again);
      yield* Fiber.interrupt(first);
      return v.seen;
    }),
  );
  expect(sent(seen)).toEqual([
    { at: 0, wrote: 2 }, // stuck: it wrote nothing anyone could read
    { at: 30_000, wrote: 3 }, // the waiter, once the claim lapsed: blocks 0 to 2
    { at: 30_000 + RESPONSE, wrote: 1 }, // came while that one wrote, waited for it, wrote block 3
    { at: 30_000 + 2 * RESPONSE, wrote: 2 },
    { at: 30_000 + 3 * RESPONSE, wrote: 0 },
  ]);
});

test("a call that fails before its response begins books nothing: the calls after it find the prefix unwritten, and one writes it while the other waits", async () => {
  const seen = await run(
    Effect.gen(function* () {
      const v = vendor({ fails: [0] });
      const gate = makeGate();
      const failing = yield* Effect.forkChild(compact(gate, v.provider, [job(7)]));
      yield* advance(RESPONSE);
      yield* Fiber.join(failing);
      const next = yield* Effect.forkChild(compact(gate, v.provider, [job(7, 8), job(7, 9)]));
      yield* advance(RESPONSE);
      yield* advance(RESPONSE);
      yield* Fiber.join(next);
      return v.seen;
    }),
  );
  expect(sent(seen)).toEqual([
    { at: 0, wrote: 0 }, // turned away
    { at: RESPONSE, wrote: 2 }, // writes the prefix
    { at: 2 * RESPONSE, wrote: 0 }, // waited for it: had the failure been booked as written, both would have written it
  ]);
});

test("a writer that fails before its response begins: of the calls that waited on it, one writes the prefix and the others wait for that one, and again when that one fails too", async () => {
  // the next writer fails as well: those left look again
  expect(sent(await together(makeGate(), [8, 9, 10, 11].map((i) => job(7, i)), { fails: [0, 1] }))).toEqual([
    { at: 0, wrote: 0 },
    { at: RESPONSE, wrote: 0 },
    { at: 2 * RESPONSE, wrote: 2 },
    { at: 3 * RESPONSE, wrote: 0 },
  ]);
  for (const n of [3, 8]) {
    const jobs = Array.from({ length: n }, (_, k) => job(7, 8 + k));
    expect(sent(await together(makeGate(), jobs, { fails: [0] }))).toEqual([
      { at: 0, wrote: 0 }, // turned away: it wrote nothing
      { at: RESPONSE, wrote: 2 }, // one of the waiters writes it
      ...Array.from({ length: n - 2 }, () => ({ at: 2 * RESPONSE, wrote: 0 })), // the rest wait for that one and read it
    ]);
  }
});

test("a writer whose claim lapses: of the calls that waited on it, one writes the prefix and the others wait for that one, and again when that one lapses too", async () => {
  const seen = await run(
    Effect.gen(function* () {
      const v = vendor({ hangs: [0, 1] });
      const gate = makeGate();
      const stuck = yield* Effect.forkChild(compact(gate, v.provider, [job(7)]));
      yield* settle;
      const waiting = yield* Effect.forkChild(compact(gate, v.provider, [job(7, 8), job(7, 9), job(7, 10)]));
      yield* advance("30 seconds");
      yield* advance("30 seconds");
      yield* advance(RESPONSE);
      yield* advance(RESPONSE);
      yield* Fiber.interrupt(waiting);
      yield* Fiber.interrupt(stuck);
      return v.seen;
    }),
  );
  expect(sent(seen)).toEqual([
    { at: 0, wrote: 2 }, // stuck
    { at: 30_000, wrote: 2 }, // stuck too
    { at: 60_000, wrote: 2 },
    { at: 60_000 + RESPONSE, wrote: 0 },
  ]);
});

test("a call never takes over a key another call is writing: one marked beyond its lookback stays that call's, read as soon as it is written", async () => {
  const short: Prefix = { keys: ["a"], marks: [0], ttl: "5m" };
  // marks block 0 and block 25; block 0 is beyond the lookback of 25, so it never waits on it
  const long: Prefix = { keys: ["a", ...Array.from({ length: 25 }, (_, k) => `b${k}`)], marks: [0, 25], ttl: "5m" };
  const times = await run(
    Effect.gen(function* () {
      const gate = makeGate();
      const went: number[] = [];
      const now = Effect.clockWith((clock) => Effect.sync(() => clock.currentTimeMillisUnsafe()));
      const go = (p: Prefix, begins: number) =>
        gate.through(p, (begun) =>
          Effect.gen(function* () {
            went.push(yield* now);
            yield* Effect.sleep(begins);
            yield* begun;
          }),
        );
      const writer = yield* Effect.forkChild(go(short, RESPONSE));
      yield* settle;
      const slow = yield* Effect.forkChild(go(long, 10 * RESPONSE)); // goes at once, begins at 10 s
      yield* advance(RESPONSE); // the writer begins: block 0 is written
      const reader = yield* Effect.forkChild(go(short, RESPONSE));
      yield* advance(RESPONSE);
      yield* Fiber.join(writer);
      yield* Fiber.join(reader);
      yield* Fiber.interrupt(slow);
      return went;
    }),
  );
  expect(times).toEqual([0, 0, RESPONSE]); // the reader went at 1 s, not when the slow call began
});

test("two calls on one context that waited on a shorter writer: one writes the tail, the other waits for it once more and reads it", async () => {
  // the 11-line context extends the 7-line one by block 2
  expect(sent(await together(makeGate(), [job(7), job(11, 12), job(11, 13)]))).toEqual([
    { at: 0, wrote: 2 },
    { at: RESPONSE, wrote: 1 },
    { at: 2 * RESPONSE, wrote: 0 }, // without the second wait it would write block 2 again
  ]);
});

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
      yield* pair("4 minutes"); // read at 4 min 1 s, its response at 4 min 2 s: kept to 9 min 2 s
      yield* pair("4 minutes"); // read again at 8 min 3 s
      yield* pair("6 minutes"); // at 14 min 5 s: gone
      return v.seen;
    }),
  );
  expect(sent(seen)).toEqual([
    { at: at(0, 0), wrote: 2 },
    { at: at(4, 1), wrote: 0 },
    { at: at(4, 1), wrote: 0 }, // both at once: the gate knew the prefix was there
    { at: at(8, 3), wrote: 0 },
    { at: at(8, 3), wrote: 0 }, // the read at 4 min kept it, there and in the gate
    { at: at(14, 5), wrote: 2 },
    { at: at(14, 6), wrote: 0 }, // past its TTL: one wrote it again, the other waited and read it
  ]);
});

test("a read keeps an entry longer only once the reader's response begins: one that fails first keeps nothing", async () => {
  const seen = await run(
    Effect.gen(function* () {
      const v = vendor({ fails: [1] });
      const gate = makeGate();
      const once = yield* Effect.forkChild(compact(gate, v.provider, [job(7)]));
      yield* advance(RESPONSE);
      yield* Fiber.join(once); // kept to 5 min 1 s
      yield* advance("4 minutes");
      const failed = yield* Effect.forkChild(compact(gate, v.provider, [job(7, 8)])); // reads at 4 min 1 s, then fails
      yield* advance(RESPONSE);
      yield* Fiber.join(failed);
      yield* advance("2 minutes"); // 6 min 2 s: had the failed read counted, it would be kept to 9 min
      const both = yield* Effect.forkChild(compact(gate, v.provider, [job(7, 9), job(7, 10)]));
      yield* advance(RESPONSE);
      yield* advance(RESPONSE);
      yield* Fiber.join(both);
      return v.seen;
    }),
  );
  expect(sent(seen).slice(2)).toEqual([
    { at: at(6, 2), wrote: 2 }, // gone in the gate as at the vendor (whose read at 4 min kept it to 9 min 1 s
    { at: at(6, 3), wrote: 0 }, // but whose kept entry this one only reads): one writes, the other waits once
  ]);
});

// calls on one gate, each beginning its response RESPONSE after it is let through; when each was
const onGate = async (script: (go: (p: Prefix | null) => Effect.Effect<void>) => Effect.Effect<void>) =>
  run(
    Effect.gen(function* () {
      const gate = makeGate();
      const times: number[] = [];
      const now = Effect.clockWith((clock) => Effect.sync(() => clock.currentTimeMillisUnsafe()));
      const go = (p: Prefix | null) =>
        gate.through(p, (begun) =>
          Effect.gen(function* () {
            times.push(yield* now);
            yield* Effect.sleep(RESPONSE);
            yield* begun;
          }),
        );
      yield* script(go);
      return times;
    }),
  );
// `calls` started together, run until each has begun its response
const all = (calls: readonly Effect.Effect<void>[]) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.all(calls, { concurrency: "unbounded" }));
    yield* advance(RESPONSE);
    yield* advance(RESPONSE);
    yield* Fiber.join(fiber);
  });

test("a claude-code compaction's entry is kept an hour, the subscription's TTL (E6), and a read renews it by its own TTL, not the reader's", async () => {
  const o = { effort: "high", instructions: "SYSTEM", model: "haiku", tools: MASTER_TOOLS };
  const hour = claudePrefix(o, blocks(job(7), "1h"), "1h");
  const brief = claudePrefix(o, blocks(job(7, 8), "1h"), "5m"); // the same prefix, read by a call that would mark 5 minutes
  expect(brief?.keys).toEqual(hour?.keys);
  // 50 minutes on it is still there: two calls go at once
  const later = await onGate((go) => Effect.andThen(all([go(hour)]), Effect.andThen(advance("50 minutes"), all([go(hour), go(hour)]))));
  expect(later[1]).toBe(later[2]);
  // read at 50 minutes, it is kept an hour from then, its own TTL: at 1 h 40 two calls still go at once
  const kept = await onGate((go) =>
    Effect.gen(function* () {
      yield* all([go(hour)]);
      yield* advance("50 minutes");
      yield* all([go(brief)]);
      yield* advance("50 minutes");
      yield* all([go(hour), go(hour)]);
    }),
  );
  expect(kept[2]).toBe(kept[3]);
  // on another model a compaction shares nothing
  expect(claudePrefix({ ...o, model: "sonnet" }, blocks(job(7), "1h"), "1h")?.keys[0]).not.toBe(hour?.keys[0]);
});
