// Few tests, each a failure that has happened or plausibly will (ref §10). No model calls.
import { afterAll, expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Layer, type Scope } from "effect";
import { TestClock } from "effect/testing";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import { CompactError, type Job } from "../src/compactor.ts";
import { parseOptmem } from "../src/import.ts";
import { loadChat, lock, Locked } from "../src/store.ts";
import { built } from "../src/tree.ts";
import { cutBlocks } from "../src/view.ts";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(`${tmpdir()}/oc-`); // short: socket paths stop at ~107 characters
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

const run = async <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const runScoped = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => run(Effect.scoped(effect));
const long = (n: number) => "w".repeat(n); // never a free node at level 0
const allBuilt = (T: number, has: (l: number, i: number) => boolean) => {
  for (let l = 0; 2 ** l <= T; l++) for (let i = 0; (i + 1) * 2 ** l <= T; i++) if (!has(l, i)) return false;
  return true;
};

test("the view is cut after the last line end before each mark, and marks past its end are skipped", () => {
  const view = ["<chat>", ...Array.from({ length: 40 }, (_, k) => `${k}+1|${"x".repeat(30)}`), "</chat>"].join("\n");
  const blocks = cutBlocks(view, [100, 500, 100_000]);
  expect(blocks.join("")).toBe(view);
  expect(blocks).toHaveLength(3);
  for (const b of blocks.slice(0, -1)) expect(b.endsWith("\n")).toBe(true);
  expect(blocks[0]!.length).toBeLessThanOrEqual(100);
  expect(cutBlocks("<chat>\n</chat>")).toEqual(["<chat>\n</chat>"]);
});

test("the pump compresses messages one at a time, in order, merges alongside, and never runs more than JOBS", async () => {
  const dir = tmp(), started: Job[] = [];
  let most = 0, running = 0;
  await runScoped(
    Effect.gen(function* () {
      const chat = yield* openChat(dir, {
        jobs: 3,
        summarize: (job) =>
          Effect.gen(function* () {
            started.push(job);
            most = Math.max(most, ++running);
            yield* Effect.sleep(2);
            running--;
            return `s${job.l}.${job.i} ${long(300)}`;
          }),
      });
      for (let k = 0; k < 16; k++) yield* chat.log("echo", long(600));
      while (!allBuilt(chat.mem.root.length, (l, i) => built(chat.mem, l, i))) yield* Effect.sleep(2);
    }),
  );
  const leaves = started.filter((j) => j.l === 0).map((j) => j.i);
  expect(leaves).toEqual(Array.from({ length: 16 }, (_, i) => i)); // in order, each once
  for (const j of started) {
    // rule 3: every line of its context is a summary, never the placeholder
    expect(j.ctx.every((l) => !l.includes("not summarized yet"))).toBe(true);
  }
  expect(started.some((j) => j.l > 0)).toBe(true);
  expect(most).toBeLessThanOrEqual(3);
});

test("a failing node is reported once, retried after RETRY, and built", async () => {
  const dir = tmp(), reports: string[] = [];
  let calls = 0;
  await runScoped(
    Effect.gen(function* () {
      const done = yield* Deferred.make<true>();
      const chat = yield* openChat(dir, {
        report: (m) => Effect.sync(() => reports.push(m)),
        summarize: () =>
          Effect.suspend(() => {
            calls++;
            if (calls <= 3) return Effect.fail(new CompactError({ message: "overloaded" }));
            return Deferred.succeed(done, true).pipe(Effect.as(`line ${long(100)}`));
          }),
      });
      const fiber = yield* Effect.forkChild(chat.log("echo", long(900)));
      yield* Fiber.join(fiber);
      for (let k = 0; k < 3 && calls < 4; k++) yield* TestClock.adjust("10 seconds");
      yield* Deferred.await(done);
      while (!built(chat.mem, 0, 0)) yield* Effect.yieldNow;
    }).pipe(Effect.provide(Layer.fresh(TestClock.layer()))),
  );
  expect(calls).toBe(4);
  expect(reports).toEqual(["0+1: overloaded"]);
});

test("a torn last line is skipped quietly by readers, and repaired by the lock holder", async () => {
  const dir = tmp();
  mkdirSync(`${dir}/chat/main`, { recursive: true });
  const file = `${dir}/chat/main/2026-10-05.jsonl`;
  writeFileSync(file, `${JSON.stringify({ date: "2026-10-05T10:00:00.000Z", i: 0, kind: "user", size: 8, text: "hi" })}\n{"i":1,"kind":"us`);
  const reader = await run(loadChat(dir, { repair: false }));
  expect(reader.mem.root).toHaveLength(1);
  expect(reader.problems).toEqual([]);
  expect(readFileSync(file, "utf8").endsWith("\n")).toBe(false);
  const writer = await runScoped(Effect.andThen(lock(dir), loadChat(dir)));
  expect(writer.problems).toEqual(["main/2026-10-05.jsonl:2: not a valid record, skipped"]);
  appendFileSync(file, `${JSON.stringify({ date: "2026-10-05T10:01:00.000Z", i: 1, kind: "talk", size: 8, text: "yo" })}\n`);
  const again = await run(loadChat(dir, { repair: false }));
  expect(again.mem.root.map((m) => m.text)).toEqual(["hi", "yo"]);
});

test("the lock refuses a second owner and takes over a stale socket", async () => {
  const dir = tmp();
  await runScoped(
    Effect.gen(function* () {
      yield* lock(dir);
      const second = yield* Effect.flip(Effect.scoped(lock(dir)));
      expect(second).toBeInstanceOf(Locked);
    }),
  );
  // an owner killed with SIGKILL leaves its socket file behind, refusing connections
  const stale = tmp();
  const owner = Bun.spawn(["bun", "-e", `require("node:net").createServer().listen(${JSON.stringify(`${stale}/lock`)}, () => console.log("up"))`], { stdout: "pipe" });
  await owner.stdout.getReader().read();
  owner.kill("SIGKILL");
  await owner.exited;
  expect(existsSync(`${stale}/lock`)).toBe(true);
  await runScoped(lock(stale));
});

test("OptMem notes must be contiguous from 0 and dated", () => {
  const ok = parseOptmem(`#0 2026-08-08 first note   \n#1 2026-08-09 ünïcödé\n`);
  expect(ok.map((n) => [n.n, n.text, n.date.getHours()])).toEqual([[0, "first note", 12], [1, "ünïcödé", 12]]);
  expect(() => parseOptmem("#0 2026-08-08 a\n#2 2026-08-09 b\n")).toThrow("expected #1, found #2");
  expect(() => parseOptmem("#0 2026-02-30 a\n")).toThrow("bad date");
});
