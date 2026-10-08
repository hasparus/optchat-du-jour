// Few tests, each a failure that has happened or plausibly will (ref §10). No model calls.
import { afterAll, expect, test } from "bun:test";
import { Effect, Fiber, Queue, type Scope, Stream } from "effect";
import { tmpdir } from "node:os";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { openChat } from "../src/chat.ts";
import { CompactError, type Job, makePump } from "../src/compactor.ts";
import { importOptmem, parseOptmem } from "../src/import.ts";
import { loadChat, lock, Locked, newMsg } from "../src/store.ts";
import { built, getNode, type Mem, newMem, nodes } from "../src/tree.ts";
import { addMessage, addNode, render, settle } from "../src/view.ts";
import { cap } from "../src/cap.ts";
import { CAP } from "../src/config.ts";
import { requestBody } from "../src/apikey/anthropic.ts";
import { makeClaude } from "../src/claude/process.ts";
import { handleMcp, noAttached } from "../src/mcp.ts";
import { body as responsesBody } from "../src/openai/responses.ts";
import { contextBlocks, task } from "../src/summarize/step.ts";
import { headOf, tailOf } from "../src/text.ts";

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

// A surrogate pair split by a cut leaves a lone half in the permanent log; the provider refuses
// the compactor's input on every try, and every turn waited on that node.
test("cap() never splits a surrogate pair, and says how much it left out", () => {
  const rocket = "\u{1F680}";
  // the cut after the head would fall between the rocket's halves: the head stops before it
  const full = `${"a".repeat(14_999)}${rocket}${"b".repeat(20_000)}`;
  const capped = cap(full);
  expect(capped.isWellFormed()).toBe(true);
  expect(capped).toBe(`${"a".repeat(14_999)}\n[… ${full.length - 14_999 - CAP / 2} chars cut …]\n${"b".repeat(CAP / 2)}`);
  expect(JSON.stringify(newMsg(7, "echo", capped))).not.toMatch(/\\ud83d/i);
  // and the tail's start would fall between them: the tail starts after it
  const late = `${"a".repeat(20_000)}${rocket}${"b".repeat(14_999)}`;
  expect(cap(late)).toBe(`${"a".repeat(CAP / 2)}\n[… ${late.length - CAP / 2 - 14_999} chars cut …]\n${"b".repeat(14_999)}`);
  // plain text is cut exactly as the reference cuts it (the parity fixtures are ASCII)
  const ascii = `${"x".repeat(20_000)}${"y".repeat(20_000)}`;
  expect(cap(ascii)).toBe(`${"x".repeat(CAP / 2)}\n[… ${40_000 - CAP} chars cut …]\n${"y".repeat(CAP / 2)}`);
  expect(cap("short")).toBe("short");
  // a lone half the tool itself wrote is not logged as one
  expect(cap("a\uD83Db").isWellFormed()).toBe(true);
  expect(headOf(`x${rocket}`, 2)).toBe("x");
  expect(headOf(`x${rocket}`, 3)).toBe(`x${rocket}`);
  expect(tailOf(`${rocket}x`, 2)).toBe("x");
  expect(tailOf(`${rocket}x`, 3)).toBe(`${rocket}x`);
});

// what each encoder of a model's input sent, checked for a lone surrogate: none may hold one as
// an escape, and the line's text must arrive with U+FFFD in its place
const wellFormedOnWire = (wire: string) => {
  expect(wire).not.toMatch(/\\ud83d/i);
  expect(wire).toContain("rocket \uFFFD then text");
};

test("a line logged with a lone surrogate reaches no model as one: every wire encoder makes it well-formed; optchat view prints it as stored", async () => {
  const bad = "rocket \uD83D then text"; // what cap() wrote before it kept pairs whole
  const msg = newMsg(7, "echo", bad);
  const job = { ctx: ["older", `echo: ${bad}`], i: 7, l: 0, msg };
  const asked = task(job);
  // Anthropic's request body, as a compactor's or a turn's, a tool result included
  wellFormedOnWire(requestBody({ history: [{ parts: [...contextBlocks(job).blocks, asked], type: "user" }, { id: "t", output: bad, type: "result" }], model: "m", system: "s" }));
  // the Responses API's
  wellFormedOnWire(responsesBody({ input: [{ parts: [asked], role: "user" }, { id: "c", output: bad, role: "output" }], instructions: "s", model: "m" }));
  // claude's stream-json input (a turn's or a compactor's message)
  const sent = await run(
    Effect.scoped(
      Effect.gen(function* () {
        const stdin = yield* Queue.unbounded<string>();
        const claude = yield* makeClaude({ exit: Effect.succeed("ended"), lines: Stream.empty, stdin });
        yield* claude.send([{ text: asked, type: "text" }]);
        return yield* Queue.take(stdin);
      }),
    ),
  );
  wellFormedOnWire(sent);
  // zoom over MCP: a short message is its own free node, so the lone half is in the view too
  const mem = newMem();
  addMessage(mem, newMsg(0, "echo", bad));
  addNode(mem, { i: 0, l: 0, size: msg.size, text: `echo: ${bad}` });
  const zoomed = handleMcp(mem, JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: { id: 0, n: 1 }, name: "zoom" } }), noAttached);
  wellFormedOnWire(zoomed.body ?? "");
  // what is stored is shown as stored: optchat view (and parity) see the log's own bytes
  expect(render(mem)).toContain(bad);
  // well-formed text is not touched, so nothing cached changes
  expect(requestBody({ history: [{ parts: ["ok \u{1F680}"], type: "user" }], model: "m", system: "s" })).toContain("ok \u{1F680}");
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
  // a compaction view stops at the first unbuilt line: no context line is ever the placeholder
  expect(seen.flatMap((j) => j.ctx).some((line) => line.includes("not summarized yet"))).toBe(false);
  expect(widest).toBeLessThanOrEqual(3);
  expect(seen.some((j) => j.l > 0)).toBe(true);
});

test("a failing node is reported once, tried again at each next message, and built", async () => {
  const said: string[] = [];
  let calls = 0;
  await runScoped(
    Effect.gen(function* () {
      const chat = yield* openChat(scratchDir(), {
        report: sink(said),
        summarize: () =>
          Effect.sync(() => ++calls).pipe(
            Effect.flatMap((n) => (n <= 3 ? Effect.fail(new CompactError({ message: "overloaded" })) : Effect.succeed(`line ${long(100)}`))),
          ),
      });
      yield* chat.log("echo", long(900));
      yield* awaitCalls(() => calls, 1);
      // no message, no new try, however long it waits
      yield* Effect.sleep("50 millis");
      expect(calls).toBe(1);
      for (let n = 2; n <= 4; n++) {
        yield* chat.log("user", `next ${n}`); // a short message: its own free node, no call
        yield* awaitCalls(() => calls, n);
      }
      yield* awaitFirst(chat);
    }),
  );
  expect(calls).toBe(4);
  expect(said).toEqual(["0+1: overloaded"]);
});

test("a message the session holds for its turn tries failed calls again too (chat.retry), so a turn waiting for summaries is not left waiting", async () => {
  let calls = 0;
  await runScoped(
    Effect.gen(function* () {
      const chat = yield* openChat(scratchDir(), {
        report: () => Effect.void,
        summarize: () => Effect.sync(() => ++calls).pipe(Effect.flatMap((n) => (n === 1 ? Effect.fail(new CompactError({ message: "no" })) : Effect.succeed("line")))),
      });
      yield* chat.log("echo", long(900));
      yield* awaitCalls(() => calls, 1);
      const waiting = yield* Effect.forkChild(settle(chat.mem));
      yield* chat.retry;
      yield* Fiber.join(waiting);
      expect(calls).toBe(2);
    }),
  );
});

// the pump's fibers run until `count()` reaches n
const awaitCalls = (count: () => number, n: number) =>
  Effect.gen(function* () {
    for (let k = 0; k < 2000 && count() < n; k++) yield* Effect.sleep(1);
    expect(count()).toBe(n);
  });

// message 0's node, failed once or more: each round logs a short message, which tries it again
const awaitFirst = (chat: { readonly mem: Mem; readonly log: (kind: "user", body: string) => Effect.Effect<unknown, unknown> }) =>
  Effect.gen(function* () {
    for (let round = 0; round < 4 && !built(chat.mem, first); round++) {
      for (let y = 0; y < 200 && !built(chat.mem, first); y++) yield* Effect.sleep(1);
      if (!built(chat.mem, first)) yield* Effect.orDie(chat.log("user", `again ${round}`));
    }
  });

test("a compactor that throws or dies is a failure like any other: reported once, retried, built", async () => {
  const said: string[] = [];
  let calls = 0;
  await runScoped(
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
      yield* awaitFirst(chat);
      expect(built(chat.mem, first)).toBe(true);
    }),
  );
  expect(calls).toBe(3);
  expect(said).toEqual(["0+1: summarizer crashed"]);
});

test("a call that comes back interrupted fails its node: the node is freed, reported, retried and built", async () => {
  const said: string[] = [];
  let calls = 0;
  await runScoped(
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
      yield* awaitFirst(chat);
      expect(built(chat.mem, first)).toBe(true);
    }),
  );
  expect(calls).toBe(2);
  expect(said).toHaveLength(1);
});

test("a report that dies does not keep its node from the retry", async () => {
  let calls = 0;
  await runScoped(
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
      yield* awaitFirst(chat);
      expect(built(chat.mem, first)).toBe(true);
    }),
  );
  expect(calls).toBe(2);
});

test("a summary is trimmed, and one that is only whitespace fails the node like any error", async () => {
  const said: string[] = [];
  let calls = 0;
  await runScoped(
    Effect.gen(function* () {
      const chat = yield* openChat(scratchDir(), {
        report: sink(said),
        summarize: () => Effect.sync(() => (++calls === 1 ? " \n\t " : "  the gist of it\n")),
      });
      yield* chat.log("echo", long(900));
      yield* awaitFirst(chat);
      expect(getNode(chat.mem, first)?.text).toBe("the gist of it");
    }),
  );
  expect(calls).toBe(2);
  expect(said).toEqual(["0+1: the compactor replied with nothing"]);
});

test("a defect in the free merge that follows a job is reported, and the merge is built at the next message", async () => {
  const said: string[] = [], state = newMem();
  let broken = true;
  await runScoped(
    Effect.gen(function* () {
      const pump = yield* makePump({
        // the free merge of the two summaries, committed after the second job, dies once
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
      for (let y = 0; y < 200 && broken; y++) yield* Effect.sleep(1);
      expect(said).toEqual(["commit blew up"]);
      expect(built(state, { i: 0, l: 1 })).toBe(false);
      addMessage(state, newMsg(2, "user", "next"));
      yield* pump.logged(2);
      for (let y = 0; y < 200 && !built(state, { i: 0, l: 1 }); y++) yield* Effect.sleep(1);
    }),
  );
  expect(broken).toBe(false);
  expect(said).toEqual(["commit blew up"]);
  expect(built(state, { i: 0, l: 1 })).toBe(true);
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
  const reread = await run(loadChat(dir, { writer: false }));
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
  // a log written by hand has no saved view: each load says it rebuilt one, and only the writer saves it
  const rebuilt = "chat/view.json: missing; the view was rebuilt from the log";
  const reader = await run(loadChat(dir, { writer: false }));
  expect(reader.mem.root.map((m) => m.text)).toEqual(["hi"]);
  expect(reader.problems).toEqual([rebuilt]);
  expect(readFileSync(jsonl, "utf8").at(-1)).not.toBe("\n");
  expect(existsSync(`${dir}/chat/view.json`)).toBe(false);
  const writer = await runScoped(Effect.andThen(lock(dir), loadChat(dir)));
  expect(writer.problems).toEqual(["main/2026-09-30.jsonl line 2: unreadable, ignored", rebuilt]);
  const yo = { date: "2026-09-30T08:01:00.000Z", i: 1, kind: "talk", size: 8, text: "yo" };
  appendFileSync(jsonl, `${JSON.stringify(yo)}\n`);
  const after = await run(loadChat(dir, { writer: false }));
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
  const next = await run(loadChat(`${dir}/data`, { writer: false }));
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
