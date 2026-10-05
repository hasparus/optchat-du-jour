// Few tests, each a failure that has happened or plausibly will (ref §10). No model calls.
import { afterAll, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Layer, type Scope } from "effect";
import { TestClock } from "effect/testing";
import { tmpdir } from "node:os";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { openChat } from "../src/chat.ts";
import { CompactError, type Job, makePump } from "../src/compactor.ts";
import { importOptmem, parseOptmem } from "../src/import.ts";
import { loadChat, lock, Locked, newMsg } from "../src/store.ts";
import { built, getNode, type Mem, newMem, nodes } from "../src/tree.ts";
import { addMessage, addNode, cutBlocks, render, settle } from "../src/view.ts";

const made: string[] = [];
// short: socket paths stop at ~107 characters
function scratchDir() {
  const path = mkdtempSync(`${tmpdir()}/oc-`);
  made.push(path);
  return path;
}
afterAll(() => {
  for (const path of made) rmSync(path, { force: true, recursive: true });
});

const run = async <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const runScoped = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => run(Effect.scoped(effect));
const long = (n: number) => "w".repeat(n); // never a free node at level 0
const caughtUp = (mem: Mem) => nodes(mem.root.length).every((c) => built(mem, c));
const first = { i: 0, l: 0 };
// a report sink: the lines a pump reports, in order
const sink = (lines: string[]) => (line: string) => Effect.sync(() => lines.push(line));
// a test-clock run: TestClock.adjust moves time, and nothing waits for real
const virtual = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => runScoped(effect.pipe(Effect.provide(Layer.fresh(TestClock.layer()))));

test("the view is cut after the last line end before each mark, and marks past its end are skipped", () => {
  const rows = Array.from({ length: 40 }, (_, k) => `${k}+1|${"x".repeat(30)}`);
  const view = `<chat>\n${rows.join("\n")}\n</chat>`;
  const blocks = cutBlocks(view, [100, 500, 100_000]);
  expect(blocks).toHaveLength(3);
  expect(blocks.reduce((all, b) => all + b, "")).toBe(view);
  expect(blocks.slice(0, -1).filter((b) => !b.endsWith("\n"))).toEqual([]);
  expect(blocks[0]!.length).toBeLessThanOrEqual(100);
  expect(cutBlocks("<chat>\n</chat>")).toEqual(["<chat>\n</chat>"]);
});

test("settle waits for the last unbuilt view line, and a cancelled wait leaves no listener", async () => {
  const state = newMem();
  addMessage(state, newMsg(0, "echo", long(600)));
  addMessage(state, newMsg(1, "echo", long(600)));
  await run(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(settle(state));
      yield* Effect.yieldNow;
      expect(state.listeners.size).toBe(1);
      addNode(state, { i: 0, l: 0, text: "first" });
      yield* Effect.yieldNow;
      expect(fiber.pollUnsafe()).toBeUndefined(); // one line is still a placeholder
      addNode(state, { i: 1, l: 0, text: "second" });
      yield* Fiber.join(fiber);
      expect(state.listeners.size).toBe(0);

      addMessage(state, newMsg(2, "echo", long(600)));
      const cancelled = yield* Effect.forkChild(settle(state));
      yield* Effect.yieldNow;
      expect(state.listeners.size).toBe(1);
      yield* Fiber.interrupt(cancelled);
      expect(state.listeners.size).toBe(0);
    }),
  );
});

test("the pump compresses messages one at a time, in order, merges alongside, and never runs more than JOBS", async () => {
  const seen: Job[] = [];
  let widest = 0, live = 0;
  await runScoped(
    Effect.gen(function* () {
      const chat = yield* openChat(scratchDir(), {
        jobs: 3,
        summarize: (job) =>
          Effect.gen(function* () {
            seen.push(job);
            live++;
            widest = Math.max(widest, live);
            yield* Effect.sleep(2);
            live--;
            return `s${job.l}.${job.i} ${long(300)}`;
          }),
      });
      for (let k = 0; k < 16; k++) yield* chat.log("echo", long(600));
      while (!caughtUp(chat.mem)) yield* Effect.sleep(2);
    }),
  );
  // every message summarized once, in id order
  expect(seen.filter((j) => j.l === 0).map((j) => j.i)).toEqual([...Array.from({ length: 16 }).keys()]);
  // rule 3: no context line is ever the placeholder
  expect(seen.flatMap((j) => j.ctx).some((line) => line.includes("not summarized yet"))).toBe(false);
  expect(widest).toBeLessThanOrEqual(3);
  expect(seen.some((j) => j.l > 0)).toBe(true);
});

test("a failing node is reported once, retried after RETRY, and built", async () => {
  const said: string[] = [];
  let calls = 0;
  await virtual(
    Effect.gen(function* () {
      const done = yield* Deferred.make<true>();
      const chat = yield* openChat(scratchDir(), {
        report: sink(said),
        summarize: () =>
          Effect.suspend(() => {
            calls++;
            if (calls <= 3) return Effect.fail(new CompactError({ message: "overloaded" }));
            return Deferred.succeed(done, true).pipe(Effect.as(`line ${long(100)}`));
          }),
      });
      yield* Fiber.join(yield* Effect.forkChild(chat.log("echo", long(900))));
      for (let k = 0; k < 3 && calls < 4; k++) yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(done);
      while (!built(chat.mem, first)) yield* Effect.yieldNow;
    }),
  );
  expect(calls).toBe(4);
  expect(said).toEqual(["0+1: overloaded"]);
});

// let the pump's fibers run, and the test clock move by RETRY, until node 0+1 is built
const awaitFirst = (mem: Mem) =>
  Effect.gen(function* () {
    for (let round = 0; round < 4 && !built(mem, first); round++) {
      yield* TestClock.adjust("10 seconds");
      for (let y = 0; y < 50 && !built(mem, first); y++) yield* Effect.yieldNow;
    }
  });

test("a compactor that throws or dies is a failure like any other: reported once, retried, built", async () => {
  const said: string[] = [];
  let calls = 0;
  await virtual(
    Effect.gen(function* () {
      const chat = yield* openChat(scratchDir(), {
        report: sink(said),
        summarize: () => {
          calls++;
          if (calls === 1) throw new Error("summarizer crashed");
          if (calls === 2) return Effect.die(new Error("summarizer died"));
          return Effect.succeed(`line ${long(100)}`);
        },
      });
      yield* chat.log("echo", long(900));
      yield* awaitFirst(chat.mem);
      expect(built(chat.mem, first)).toBe(true);
    }),
  );
  expect(calls).toBe(3);
  expect(said).toEqual(["0+1: summarizer crashed"]);
});

test("a call that comes back interrupted fails its node: the node is freed, reported, retried and built", async () => {
  const said: string[] = [];
  let calls = 0;
  await virtual(
    Effect.gen(function* () {
      const chat = yield* openChat(scratchDir(), {
        jobs: 1, // a node that never left its slot would leave none for the retry
        report: sink(said),
        summarize: () => {
          calls++;
          return calls === 1 ? Effect.interrupt : Effect.succeed(`line ${long(100)}`);
        },
      });
      yield* chat.log("echo", long(900));
      yield* awaitFirst(chat.mem);
      expect(built(chat.mem, first)).toBe(true);
    }),
  );
  expect(calls).toBe(2);
  expect(said).toHaveLength(1);
});

test("a report that dies does not keep its node from the retry", async () => {
  let calls = 0;
  await virtual(
    Effect.gen(function* () {
      const chat = yield* openChat(scratchDir(), {
        jobs: 1,
        report: () => Effect.die(new Error("the report broke")),
        summarize: () => {
          calls++;
          return calls === 1 ? Effect.fail(new CompactError({ message: "no" })) : Effect.succeed(`line ${long(100)}`);
        },
      });
      yield* chat.log("echo", long(900));
      yield* awaitFirst(chat.mem);
      expect(built(chat.mem, first)).toBe(true);
    }),
  );
  expect(calls).toBe(2);
});

test("a summary is trimmed, and one that is only whitespace fails the node like any error", async () => {
  const said: string[] = [];
  let calls = 0;
  await virtual(
    Effect.gen(function* () {
      const chat = yield* openChat(scratchDir(), {
        report: sink(said),
        summarize: () => Effect.sync(() => (++calls === 1 ? " \n\t " : "  the gist of it\n")),
      });
      yield* chat.log("echo", long(900));
      yield* awaitFirst(chat.mem);
      expect(getNode(chat.mem, first)?.text).toBe("the gist of it");
    }),
  );
  expect(calls).toBe(2);
  expect(said).toEqual(["0+1: the compactor replied with nothing"]);
});

test("a defect in the kick that follows a job is reported, and the pump goes on to build the node", async () => {
  const said: string[] = [], state = newMem();
  let broken = true;
  await virtual(
    Effect.gen(function* () {
      const pump = yield* makePump({
        // the free merge of the two summaries, committed in the kick after the second job, dies once
        commit: (n) =>
          Effect.sync(() => {
            if (n.l === 1 && broken) {
              broken = false;
              throw new Error("commit blew up");
            }
            addNode(state, n);
          }),
        mem: state,
        report: sink(said),
        summarize: (job) => Effect.succeed(`s${job.i}`),
      });
      addMessage(state, newMsg(0, "echo", long(700)));
      addMessage(state, newMsg(1, "echo", long(700)));
      yield* pump.kick;
      for (let round = 0; round < 4 && !built(state, { i: 0, l: 1 }); round++) {
        for (let y = 0; y < 50 && !built(state, { i: 0, l: 1 }); y++) yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
      }
    }),
  );
  expect(broken).toBe(false);
  expect(said).toEqual(["commit blew up"]);
  expect(caughtUp(state)).toBe(true);
});

test("a stored message is logged even when the pump cannot start: that failure is reported", async () => {
  const dir = scratchDir(), said: string[] = [];
  await runScoped(
    Effect.gen(function* () {
      const chat = yield* openChat(dir, { report: sink(said), summarize: () => Effect.never });
      mkdirSync(`${dir}/chat`, { recursive: true });
      writeFileSync(`${dir}/chat/tree`, ""); // a file where the tree's directory goes: no node can be saved
      const logged = yield* chat.log("user", "short enough to be its own summary");
      expect(logged.i).toBe(0);
    }),
  );
  rmSync(`${dir}/chat/tree`);
  const reread = await run(loadChat(dir, { repair: false }));
  expect(reread.mem.root).toHaveLength(1);
  expect(said).toHaveLength(1);
  expect(said[0]).toStartWith("cannot save node 0+1: ");
});

test("a torn last line is skipped quietly by readers, and repaired by the lock holder", async () => {
  const dir = scratchDir(), day = `${dir}/chat/main`;
  mkdirSync(day, { recursive: true });
  const jsonl = `${day}/2026-09-30.jsonl`;
  const hi = { date: "2026-09-30T08:00:00.000Z", i: 0, kind: "user", size: 8, text: "hi" };
  writeFileSync(jsonl, `${JSON.stringify(hi)}\n{"i":1,"kind":"us`);
  const reader = await run(loadChat(dir, { repair: false }));
  expect(reader.mem.root.map((m) => m.text)).toEqual(["hi"]);
  expect(reader.problems).toHaveLength(0);
  expect(readFileSync(jsonl, "utf8").at(-1)).not.toBe("\n");
  const writer = await runScoped(Effect.andThen(lock(dir), loadChat(dir)));
  expect(writer.problems).toEqual(["main/2026-09-30.jsonl line 2: unreadable, ignored"]);
  const yo = { date: "2026-09-30T08:01:00.000Z", i: 1, kind: "talk", size: 8, text: "yo" };
  appendFileSync(jsonl, `${JSON.stringify(yo)}\n`);
  const after = await run(loadChat(dir, { repair: false }));
  expect(after.mem.root.map((m) => m.text)).toEqual(["hi", "yo"]);
});

test("the lock refuses a second owner and takes over a stale socket", async () => {
  const dir = scratchDir();
  // the owner is another process holding the lock as the chat does
  const owner = Bun.spawn(["bun", `${import.meta.dir}/hold-lock.ts`, dir], { stdout: "pipe" });
  const said = await owner.stdout.getReader().read();
  expect(new TextDecoder().decode(said.value)).toBe("held\n");
  const refused = await run(Effect.flip(Effect.scoped(lock(dir))));
  expect(refused).toBeInstanceOf(Locked);
  // killed with SIGKILL, it leaves its socket file behind, refusing connections
  owner.kill("SIGKILL");
  await owner.exited;
  const socket = `${dir}/lock`;
  expect(existsSync(socket)).toBeTrue();
  await runScoped(lock(dir));
});

const augustDay = (n: number) => String(1 + (n % 28)).padStart(2, "0");

test("an OptMem import folds the view once, to what the next start loads", async () => {
  const dir = scratchDir();
  const lines = Array.from({ length: 40 }, (_, n) => `#${n} 2026-08-${augustDay(n)} ${"n".repeat(n % 3 === 0 ? 600 : 20)}`);
  writeFileSync(`${dir}/LOG.txt`, `${lines.join("\n")}\n`);
  const mem = await run(importOptmem(`${dir}/data`, `${dir}/LOG.txt`));
  const next = await run(loadChat(`${dir}/data`, { repair: false }));
  expect(mem.root).toHaveLength(40);
  expect(mem.tree.size).toBeGreaterThan(0);
  expect(mem.view).toEqual(next.mem.view);
  expect(render(mem)).toBe(render(next.mem));
});

test("OptMem notes must be contiguous from 0 and dated", () => {
  const ok = parseOptmem(`#0 2026-08-08 first note   \n#1 2026-08-09 ünïcödé\n`);
  expect(ok.map((n) => [n.n, n.text, n.date.getHours()])).toEqual([[0, "first note", 12], [1, "ünïcödé", 12]]);
  expect(() => parseOptmem("#0 2026-08-08 a\n#2 2026-08-09 b\n")).toThrow("note #2 where #1 should be");
  expect(() => parseOptmem("#0 2026-02-30 a\n")).toThrow("not a calendar date");
});
