// Compactions as docs/optchat.md §4 has them: the task texts byte for byte, the compaction view's
// sawtooth and what each call sees of it, the start rule kept in queues (held to the kernel's
// offers, and linear on a long backlog), a failed call tried again at the next message, and the
// wait on a call writing the same marked prefix (§3.3).
import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { readFileSync } from "node:fs";
import { CompactError, type Job, makeJob, makePump } from "../src/compactor.ts";
import { AHEAD, NODE } from "../src/config.ts";
import { makeGate } from "../src/engines/inflight.ts";
import * as K from "../src/kernel.ts";
import { newMsg, newNode } from "../src/store.ts";
import { RULER, retryText, task } from "../src/summarize/step.ts";
import { built, bytes, type Coord, end, label, type Marks, type Mem, newMem, nodes, ready, setNode } from "../src/tree.ts";
import { addMessage, addNode, compactionContext, PLACEHOLDER } from "../src/view.ts";

const long = (n: number) => "w".repeat(n);

// docs/optchat.md §4's three texts, as its code blocks give them
const spec = readFileSync(`${import.meta.dir}/../docs/optchat.md`, "utf8");
const section = spec.slice(spec.indexOf("## 4. Compactions"), spec.indexOf("## 5. The prompt"));
const blocks = [...section.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1] ?? "");
const verbatim = (start: string) => {
  const found = blocks.find((b) => b.startsWith(start));
  if (found === undefined) throw new Error(`docs/optchat.md §4 has no block starting ${start}`);
  return found.replace("------------…------------", RULER); // "the ruler is 512 dashes"
};

test("the task texts are docs/optchat.md §4's, byte for byte, with a ruler of 512 dashes", () => {
  expect(bytes(RULER)).toBe(NODE);
  expect(RULER).toMatch(/^-+$/);
  const msg: Job = { ctx: [], i: 37, l: 0, msg: newMsg(37, "echo", "line one\nline two") };
  expect(task(msg)).toBe(verbatim("Compaction: compress").replace("{id}", "37").replace("{kind}: {the message, whole}", "echo: line one\nline two"));
  // node 40+8 merges 40+4 and 44+4: messages 40 to 47, each line as the view shows it
  const merge: Job = { a: "user: a\nb", b: "talk: c", ctx: [], i: 5, l: 3 };
  expect(task(merge)).toBe(
    verbatim("Compaction: merge")
      .replace("{a}", "40+4")
      .replace("{b}", "44+4")
      .replace("{id}", "40")
      .replace("{end}", "47")
      .replace("{line a}", "40+4|user: a b")
      .replace("{line b}", "44+4|talk: c"),
  );
  const over = `${"x".repeat(511)}ä${"y".repeat(87)}`;
  expect(retryText(over)).toBe(verbatim("Too long:").replace("{N}", "600").replace("{its first 512 bytes}", "x".repeat(511)));
  // what made the old sample line obsolete: no line of any summary is shown as the ruler
  expect(task(msg)).not.toContain("For scale");
});

// A chat whose compactor keeps up: every message's node built at once, every merge as soon as both
// halves are, so the views merge on their own marks.
function caughtUp(marks: Marks, compaction: Marks) {
  const mem = newMem(marks, compaction);
  const build = () => {
    for (const c of nodes(mem.root.length)) if (!built(mem, c) && ready(mem, c)) addNode(mem, newNode(c.l, c.i, `s ${long(380 + ((c.i * 7) % 100))}`));
  };
  return { build, mem };
}
// every line of `fine` lies inside one line of `coarse`: `coarse` is `fine` merged further
const coarsens = (coarse: readonly Coord[], fine: readonly Coord[]) =>
  fine.every((f) => coarse.some((c) => end(c) - 2 ** c.l <= end(f) - 2 ** f.l && end(f) <= end(c)));
const sizeOf = (mem: Mem, view: readonly Coord[]) => view.reduce((n, c) => n + (mem.tree.get(`${c.l}:${c.i}`)?.size ?? NODE), 0);

test("the compaction view: the view merged further, on its own sawtooth, merged again whenever the view merges", () => {
  const marks = { high: 40_000, low: 20_000 }, cmarks = { high: 10_000, low: 5000 };
  const { build, mem } = caughtUp(marks, cmarks);
  let ownBatches = 0, withView = 0, appends = 0;
  const sizes: number[] = [];
  for (let t = 0; t < 1500; t++) {
    const [view, cv] = [mem.view, mem.compaction.view];
    addMessage(mem, newMsg(t, "echo", long(700)));
    const line = { i: t, l: 0 };
    const viewMerged = mem.view.length < view.length + 1;
    if (viewMerged) {
      // merged again, down to its low mark, from the view
      withView++;
      expect(mem.compaction).toEqual(K.batch(mem, mem.view, cmarks, NODE));
    } else if (mem.compaction.view.length === cv.length + 1) {
      // between batches it only grows at its end: a compaction reads the one before it from the cache
      appends++;
      expect(mem.compaction.view).toEqual([...cv, line]);
    } else {
      ownBatches++; // past its high mark: merged down to its low one
      expect(sizeOf(mem, cv) + NODE).toBeGreaterThan(cmarks.high);
      expect(sizeOf(mem, mem.compaction.view)).toBeLessThanOrEqual(cmarks.low);
    }
    expect(coarsens(mem.compaction.view, mem.view)).toBe(true);
    build();
    sizes.push(sizeOf(mem, mem.compaction.view));
  }
  expect([withView > 3, ownBatches > 3, appends > 1000]).toEqual([true, true, true]);
  // a sawtooth between its marks: once it has filled up, never above the high one
  const settled = sizes.slice(500);
  expect(Math.max(...settled)).toBeLessThanOrEqual(cmarks.high);
  expect(Math.min(...settled)).toBeGreaterThan(cmarks.low / 2);
});

test("what a compaction sees: the compaction view up to its node, stopping at the first unbuilt line, never a placeholder", () => {
  const mem = newMem({ high: 40_000, low: 20_000 }, { high: 10_000, low: 5000 });
  for (let t = 0; t < 40; t++) addMessage(mem, newMsg(t, "echo", long(700)));
  for (let i = 0; i < 40; i++) if (i !== 20 && i !== 30) setNode(mem, newNode(0, i, `s${i}`));
  for (let i = 0; i < 8; i++) setNode(mem, newNode(1, i, `m${i}`));
  // a message's node: the lines before it
  expect(compactionContext(mem, 12)).toEqual(Array.from({ length: 12 }, (_, i) => `${i}+1|s${i}`));
  // up to the first unbuilt line (message 20), however far the node is
  expect(compactionContext(mem, 25)).toEqual(compactionContext(mem, 20));
  expect(compactionContext(mem, 35)).toHaveLength(20);
  // a merge: the lines up to its last message
  const job = makeJob(mem, { i: 3, l: 1 });
  expect(job.ctx).toEqual(Array.from({ length: 8 }, (_, i) => `${i}+1|s${i}`));
  expect(job.ctx.some((l) => l.includes(PLACEHOLDER))).toBe(false);
});

// A pump whose calls each wait for the test: `calls` holds each started call's answer by node.
const harness = (mem: Mem, jobs = 1000) =>
  Effect.gen(function* () {
    const calls = new Map<string, Deferred.Deferred<string, CompactError>>();
    const said: string[] = [];
    const pump = yield* makePump({
      commit: (n) =>
        Effect.sync(() => {
          addNode(mem, n);
        }),
      jobs,
      mem,
      report: (m) => Effect.sync(() => void said.push(m)),
      summarize: (job) =>
        Effect.suspend(() => {
          const d = Deferred.makeUnsafe<string, CompactError>();
          calls.set(label(job), d);
          return Deferred.await(d);
        }),
    });
    const quiet = Effect.gen(function* () {
      for (let k = 0; k < 30; k++) yield* Effect.yieldNow;
    });
    return { calls, pump, quiet, said };
  });

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

test("the queues start exactly what the start rule allows: a message's node with fewer than AHEAD unbuilt lines before it, a merge once both halves are built", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        for (const seed of [1, 2, 3]) {
          const r = rng(seed), mem = newMem({ high: 6000, low: 3000 }, { high: 2000, low: 1000 });
          const h = yield* harness(mem);
          const failed = new Set<string>();
          yield* h.pump.kick;
          for (let step = 0; step < 600; step++) {
            const roll = r(), open = [...h.calls.keys()];
            if (roll < 0.4 || open.length === 0) {
              const i = mem.root.length;
              addMessage(mem, newMsg(i, "echo", r() < 0.3 ? "short" : long(600)));
              failed.clear(); // the next message: what failed is tried again
              yield* h.pump.logged(i);
            } else {
              const name = open[Math.floor(r() * open.length)] ?? "";
              const d = h.calls.get(name);
              h.calls.delete(name);
              if (d === undefined) continue;
              if (roll < 0.9) yield* Deferred.succeed(d, `line ${name} ${long(Math.floor(r() * 300))}`);
              else {
                failed.add(name);
                yield* Deferred.fail(d, new CompactError({ message: "no" }));
              }
            }
            yield* h.quiet;
            // what runs, and what failed and waits for the next message, is what the rule allows
            const started = [...h.calls.keys(), ...failed].toSorted();
            expect(started).toEqual(K.offers(mem).map(label).toSorted());
          }
        }
      }),
    ),
  );
});

test("no scan: 16,000 messages are queued and built in linear time, JOBS at a time, AHEAD messages ahead", async () => {
  // small marks, so the view's own sawtooth stays cheap and the time is the pump's
  const T = 16_000, mem = newMem({ high: 16_000, low: 8000 }, { high: 4000, low: 2000 });
  let widest = 0, live = 0, ahead = 0;
  const t0 = performance.now();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pump = yield* makePump({
          commit: (n) =>
        Effect.sync(() => {
          addNode(mem, n);
        }),
          mem,
          report: () => Effect.void,
          summarize: (job) =>
            Effect.gen(function* () {
              widest = Math.max(widest, ++live);
              // a message's node never starts with AHEAD unbuilt lines before it
              if (job.l === 0) ahead = Math.max(ahead, mem.view.filter((c) => end(c) <= job.i && !built(mem, c)).length);
              yield* Effect.yieldNow;
              live--;
              return `s ${long(400)}`;
            }),
        });
        yield* pump.kick;
        for (let i = 0; i < T; i++) {
          addMessage(mem, newMsg(i, "echo", long(600)));
          yield* pump.logged(i);
          for (let k = 0; k < 20; k++) yield* Effect.yieldNow; // the compactor works while the chat goes on
        }
        while (!nodes(T).every((c) => built(mem, c))) yield* Effect.sleep(1);
      }),
    ),
  );
  expect(widest).toBeLessThanOrEqual(8);
  expect(ahead).toBeLessThan(AHEAD);
  // ~32,000 nodes: a scan of the tree for each start would be ~5·10^8 steps; the queues take ~5 s
  expect(performance.now() - t0).toBeLessThan(25_000);
}, 60_000);

test("a failed call waits for the next message, not for a timer", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const mem = newMem();
        const h = yield* harness(mem);
        yield* h.pump.kick;
        addMessage(mem, newMsg(0, "echo", long(600)));
        yield* h.pump.logged(0);
        yield* h.quiet;
        yield* Deferred.fail(h.calls.get("0+1")!, new CompactError({ message: "overloaded" }));
        h.calls.clear();
        yield* Effect.sleep("30 millis");
        expect([...h.calls.keys()]).toEqual([]); // no retry by itself
        expect(h.said).toEqual(["0+1: overloaded"]);
        addMessage(mem, newMsg(1, "user", "hi")); // free: no call of its own
        yield* h.pump.logged(1);
        yield* h.quiet;
        expect([...h.calls.keys()]).toEqual(["0+1"]);
        // a message that only comes to the session (chat.retry) does it too
        yield* Deferred.fail(h.calls.get("0+1")!, new CompactError({ message: "overloaded" }));
        h.calls.clear();
        yield* h.quiet;
        yield* h.pump.retry;
        yield* h.quiet;
        expect([...h.calls.keys()]).toEqual(["0+1"]);
        expect(h.said).toEqual(["0+1: overloaded"]); // reported once
      }),
    ),
  );
});

test("the in-flight gate: one call writes a prefix, the others wait for its response to start; a writer that fails first hands over", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const gate = makeGate();
        const order: string[] = [];
        const go = yield* Deferred.make<true>();
        const call = (name: string, key: string | null, before: Effect.Effect<void> = Effect.void) =>
          gate.through(key, (started) =>
            Effect.gen(function* () {
              order.push(`${name} sent`);
              yield* before;
              order.push(`${name} started`); // its response starts
              yield* started;
            }),
          );
        const writer = yield* Effect.forkChild(call("a", "k", Deferred.await(go)));
        yield* Effect.yieldNow;
        const waiters = yield* Effect.forkChild(Effect.all([call("b", "k"), call("c", "k")], { concurrency: "unbounded" }));
        const other = yield* Effect.forkChild(call("d", "other"));
        const none = yield* Effect.forkChild(call("e", null));
        yield* Fiber.join(other);
        yield* Fiber.join(none);
        for (let k = 0; k < 20; k++) yield* Effect.yieldNow;
        expect(order).toEqual(["a sent", "d sent", "d started", "e sent", "e started"]); // b and c wait for a
        yield* Deferred.succeed(go, true);
        yield* Fiber.join(writer);
        yield* Fiber.join(waiters);
        // b and c sent their requests only once a's response had started
        expect(order[5]).toBe("a started");
        expect(order.slice(6).toSorted()).toEqual(["b sent", "b started", "c sent", "c started"]);

        // a writer that fails before its response starts: the next waiter writes instead
        const seen: string[] = [];
        const failing = gate.through("f", () => Effect.fail("refused"));
        const first = yield* Effect.forkChild(Effect.flip(failing));
        const next = yield* Effect.forkChild(gate.through("f", (started) => Effect.andThen(started, Effect.sync(() => void seen.push("next")))));
        expect(yield* Fiber.join(first)).toBe("refused");
        yield* Fiber.join(next);
        expect(seen).toEqual(["next"]);
      }),
    ),
  );
});
