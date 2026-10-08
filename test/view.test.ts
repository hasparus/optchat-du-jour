// The view's sawtooth and its saved copy (docs/optchat.md §3.2, §3.3; SPEC "Storage, tree, view
// and compactor ordering"): between batches the view only grows at its end; past the high mark one
// batch takes it to the low mark, or as far as built parents allow and on at later messages; and
// a restart loads the view it saved instead of rebuilding it. No model calls.
import { afterAll, expect, test } from "bun:test";
import { Effect, type Scope } from "effect";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import * as K from "../src/kernel.ts";
import { appendMessage, appendNode, loadChat, lock, newMsg, saveView } from "../src/store.ts";
import { built, type Coord, getNode, type Marks, type Mem, newMem } from "../src/tree.ts";
import { addMessage, addNode, render, UNBUILT, viewSize } from "../src/view.ts";

const made: string[] = [];
function scratchDir() {
  const path = mkdtempSync(`${tmpdir()}/oc-v-`);
  made.push(path);
  return path;
}
afterAll(() => {
  for (const path of made) rmSync(path, { force: true, recursive: true });
});
const run = async <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const runScoped = async <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => run(Effect.scoped(effect));

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

const MARKS: Marks = { high: 6000, low: 3000 };
// what the sawtooth weighs: the lines' texts, an unbuilt one at the most its summary may take
const weight = (mem: Mem) => mem.view.reduce((sum, c) => sum + (getNode(mem, c)?.size ?? UNBUILT), 0);
const long = (n: number) => "w".repeat(n); // over NODE: never its own summary
const summary = (c: Coord, n: number) => `${c.l}+${c.i} ${"s".repeat(n)}`;
// what rendering puts before the closing tag: the view minus "</chat>"
const opened = (mem: Mem) => render(mem).slice(0, -"</chat>".length);
// a pair of adjacent siblings whose parent is built: what a batch could still merge
const mergeable = (mem: Mem) =>
  mem.view.some((a, k) => {
    const b = mem.view[k + 1];
    return b !== undefined && a.l === b.l && a.i % 2 === 0 && b.i === a.i + 1 && built(mem, { i: a.i / 2, l: a.l + 1 });
  });
// every node of a chat of T messages that has its sources and is not built yet
function ready(mem: Mem): Coord[] {
  const out: Coord[] = [];
  const T = mem.root.length;
  for (let l = 0, w = 1; w <= T; l++, w *= 2)
    for (let i = 0; i < Math.floor(T / w); i++) {
      const c = { i, l };
      const sources = l === 0 || (built(mem, { i: 2 * i, l: l - 1 }) && built(mem, { i: 2 * i + 1, l: l - 1 }));
      if (!built(mem, c) && sources) out.push(c);
    }
  return out;
}

// A seeded chat: messages arrive, and a compactor that builds now all, now some, now none of
// what is ready. Every message is checked against the sawtooth.
function sawtooth(seed: number, keepUp: number, messages: number) {
  const r = rng(seed), mem = newMem(MARKS);
  let batches = 0, owed = 0, appends = 0;
  for (let t = 0; t < messages; t++) {
    // the new line weighs a whole summary until its own is built
    const before = { folding: mem.folding, grown: weight(mem) + UNBUILT, text: opened(mem), view: mem.view };
    addMessage(mem, newMsg(t, "echo", long(600)));
    const size = weight(mem);
    const appended = [...before.view, { i: t, l: 0 }];
    if (!before.folding && before.grown <= MARKS.high) {
      // between batches: the line goes at the end and nothing else changes, so the last call's
      // whole view is a prefix of this one's (docs/optchat.md §3.3)
      expect(mem.view).toEqual(appended);
      expect(mem.folding).toBe(false);
      expect(render(mem).startsWith(before.text)).toBe(true);
      appends++;
    } else {
      // a batch: down to low, or as far as built parents go, owing the rest
      batches++;
      expect(size <= MARKS.low || !mergeable(mem)).toBe(true);
      expect(mem.folding).toBe(size > MARKS.low);
      if (mem.folding) owed++;
    }
    // the compactor: everything ready, level by level (kept up), or a share of what is ready now
    for (let more = ready(mem); more.length > 0; more = keepUp === 1 ? ready(mem) : [])
      for (const c of more) if (r() < keepUp) addNode(mem, { ...c, text: summary(c, 150 + Math.floor(r() * 300)) });
    // summaries built since the last message never take a view that owes no batch past its high mark
    if (!mem.folding) expect(viewSize(mem)).toBeLessThanOrEqual(MARKS.high);
  }
  return { appends, batches, mem, owed };
}

test("between batches the view only grows at its end; past the high mark a batch goes to the low one", () => {
  // the compactor keeps up: every batch reaches low at once, so none is owed
  const caught = sawtooth(1, 1, 600);
  expect(caught.batches).toBeGreaterThan(5);
  expect(caught.owed).toBe(0);
  expect(caught.appends).toBeGreaterThan(caught.batches * 5); // a sawtooth: many appends per batch
  // it lags: batches stop on unbuilt parents and go on at later messages
  let owed = 0;
  for (const seed of [2, 3, 4, 5]) {
    const lag = sawtooth(seed, 0.3, 600);
    expect(lag.batches).toBeGreaterThan(0);
    owed += lag.owed;
  }
  expect(owed).toBeGreaterThan(0);
});

// leaves built as messages come, parents never: the view passes high with nothing to merge
function stuck(mem: Mem, count: number) {
  for (let t = mem.root.length; t < count; t++) {
    addMessage(mem, newMsg(t, "echo", long(600)));
    addNode(mem, { i: t, l: 0, text: summary({ i: t, l: 0 }, 400) });
  }
}

test("a batch stopped by unbuilt parents waits for the next message, then goes on down to low", () => {
  const mem = newMem(MARKS);
  stuck(mem, 16);
  // 16 lines of 404 bytes: past high, and no parent to merge into
  expect(viewSize(mem)).toBeGreaterThan(MARKS.high);
  expect(mem.folding).toBe(true);
  expect(mem.view.every((c) => c.l === 0)).toBe(true);
  // parents built between messages change no line
  const { view } = mem;
  for (let i = 0; i < 4; i++) addNode(mem, { i, l: 1, text: summary({ i, l: 1 }, 400) });
  expect(mem.view).toBe(view);
  // the next message's batch merges them; still over low, it owes the rest
  addMessage(mem, newMsg(16, "echo", long(600)));
  expect(mem.view.slice(0, 4)).toEqual([0, 1, 2, 3].map((i) => ({ i, l: 1 })));
  expect(viewSize(mem)).toBeGreaterThan(MARKS.low);
  expect(mem.folding).toBe(true);
  // with every parent there, one more message ends the batch at low
  for (let i = 4; i < 8; i++) addNode(mem, { i, l: 1, text: summary({ i, l: 1 }, 400) });
  for (let i = 0; i < 4; i++) addNode(mem, { i, l: 2, text: summary({ i, l: 2 }, 400) });
  addNode(mem, { i: 16, l: 0, text: summary({ i: 16, l: 0 }, 400) });
  addMessage(mem, newMsg(17, "echo", long(600)));
  expect(viewSize(mem)).toBeLessThanOrEqual(MARKS.low);
  expect(mem.folding).toBe(false);
  // and from there the view grows by appending again
  const before = mem.view;
  addMessage(mem, newMsg(18, "echo", long(600)));
  expect(mem.view).toEqual([...before, { i: 18, l: 0 }]);
});

// On disk, as openChat's log and the pump's commit do it: the line synced, the view updated and saved.
const logOn = async (dir: string, mem: Mem, text: string) =>
  run(
    Effect.gen(function* () {
      const entry = newMsg(mem.root.length, "echo", text);
      yield* appendMessage(dir, entry);
      addMessage(mem, entry);
      yield* saveView(dir, mem);
    }),
  );
const buildOn = async (dir: string, mem: Mem, c: Coord, n: number) => {
  const node = { ...c, text: summary(c, n) };
  await run(appendNode(dir, node));
  addNode(mem, node);
};
const load = async (dir: string, writer = true) =>
  writer ? runScoped(Effect.andThen(lock(dir), loadChat(dir, { marks: MARKS }))) : run(loadChat(dir, { marks: MARKS, writer: false }));
const savedText = (dir: string) => readFileSync(`${dir}/chat/view.json`, "utf8");

test("a restart loads the saved view byte for byte, owed batch and all, where a rebuild would differ", async () => {
  const dir = scratchDir(), mem = newMem(MARKS);
  for (let t = 0; t < 16; t++) {
    await logOn(dir, mem, long(600));
    await buildOn(dir, mem, { i: t, l: 0 }, 400);
  }
  for (let i = 0; i < 2; i++) await buildOn(dir, mem, { i, l: 1 }, 400);
  await logOn(dir, mem, long(600)); // merges what it can: two pairs
  expect(mem.folding).toBe(true);
  // summaries built since: a rebuild would merge with them from the start, so it differs
  for (let i = 2; i < 8; i++) await buildOn(dir, mem, { i, l: 1 }, 400);
  expect(K.refold(mem, MARKS, UNBUILT).view).not.toEqual(mem.view);
  for (const writer of [false, true]) {
    const { mem: again, problems } = await load(dir, writer);
    expect(problems).toEqual([]);
    expect(again.view).toEqual(mem.view);
    expect(again.folding).toBe(true);
    expect(render(again)).toBe(render(mem));
  }
  // the owed batch goes on at the next message, after the restart as before it
  const { mem: again } = await load(dir);
  await logOn(dir, again, long(600));
  addMessage(mem, newMsg(17, "echo", long(600)));
  expect(again.view).toEqual(mem.view);
  expect(again.view.filter((c) => c.l === 1).length).toBeGreaterThan(2);
  expect(JSON.parse(savedText(dir))).toEqual({ folding: again.folding, view: again.view.map((c) => [c.l, c.i]) });
});

test("a missing, unreadable or illegal view.json is rebuilt from the log once, said so, and saved", async () => {
  const dir = scratchDir(), mem = newMem(MARKS);
  for (let t = 0; t < 20; t++) {
    await logOn(dir, mem, long(600));
    await buildOn(dir, mem, { i: t, l: 0 }, 400);
  }
  const rebuilt = K.refold(mem, MARKS, UNBUILT);
  const cases: readonly (readonly [string | null, string])[] = [
    [null, "missing"],
    ['{"folding":false,"view":[[0,0],[0,1]', "unreadable"],
    ['{"folding":false,"view":[[0,1]]}', "1+1 does not start at 0"],
    ['{"folding":false,"view":[[1,0]]}', "0+2 is a merge whose summary is not in the tree"],
    [JSON.stringify({ folding: false, view: Array.from({ length: 21 }, (_, i) => [0, i]) }), "20+1 runs past the log's 20 messages"],
  ];
  for (const [text, why] of cases) {
    if (text === null) rmSync(`${dir}/chat/view.json`);
    else writeFileSync(`${dir}/chat/view.json`, text);
    // a reader rebuilds for itself and writes nothing
    const read = await load(dir, false);
    expect(read.problems).toHaveLength(1);
    expect(read.problems[0]).toStartWith("chat/view.json: ");
    expect(read.problems[0]).toEndWith("; the view was rebuilt from the log");
    expect(existsSync(`${dir}/chat/view.json`) ? savedText(dir) : null).toBe(text);
    // the lock holder rebuilds and saves; the next start loads that, quietly
    const first = await load(dir);
    expect(first.problems).toEqual([`chat/view.json: ${why}; the view was rebuilt from the log`]);
    expect({ folding: first.mem.folding, view: first.mem.view }).toEqual(rebuilt);
    const next = await load(dir);
    expect(next.problems).toEqual([]);
    expect(next.mem.view).toEqual(rebuilt.view);
  }
});

test("a view saved one message behind the log (a crash in between) gets that message appended", async () => {
  const dir = scratchDir(), mem = newMem(MARKS);
  for (let t = 0; t < 20; t++) {
    await logOn(dir, mem, long(600));
    await buildOn(dir, mem, { i: t, l: 0 }, 400);
  }
  const before = savedText(dir);
  const entry = newMsg(20, "echo", long(600));
  await run(appendMessage(dir, entry)); // logged, and the process dies before the view is saved
  addMessage(mem, entry);
  const { mem: again, problems } = await load(dir);
  expect(problems).toEqual(["chat/view.json: 1 messages behind the log; appended them"]);
  expect(again.view).toEqual(mem.view);
  expect(savedText(dir)).not.toBe(before);
  expect(getNode(again, { i: 19, l: 0 })).toBeDefined();
});

test("openChat saves the view with every message, and a reopened chat starts from it", async () => {
  const dir = scratchDir();
  const views = await runScoped(
    Effect.gen(function* () {
      const chat = yield* openChat(dir, { marks: { high: 2000, low: 1000 }, report: () => Effect.void, summarize: () => Effect.never });
      const seen: string[] = [];
      for (let t = 0; t < 6; t++) {
        yield* chat.log("user", long(700));
        seen.push(savedText(dir));
        expect(JSON.parse(savedText(dir))).toEqual({ folding: chat.mem.folding, view: chat.mem.view.map((c) => [c.l, c.i]) });
      }
      return seen;
    }),
  );
  expect(new Set(views).size).toBe(6);
  const again = await runScoped(
    Effect.gen(function* () {
      const chat = yield* openChat(dir, { marks: { high: 2000, low: 1000 }, report: () => Effect.void, summarize: () => Effect.never });
      return { folding: chat.mem.folding, problems: chat.problems, view: chat.mem.view };
    }),
  );
  expect(again.problems).toEqual([]);
  expect([`${JSON.stringify({ folding: again.folding, view: again.view.map((c) => [c.l, c.i]) })}\n`]).toEqual(views.slice(-1));
});

test("a compactor outage: the lines it builds late never take an un-owed view past its high mark", () => {
  // forty messages while the compactor is down: each line weighs a whole summary, so the view is
  // known to be over its high mark although it shows forty placeholders, and a batch is owed
  const mem = newMem(MARKS);
  for (let t = 0; t < 40; t++) addMessage(mem, newMsg(t, "echo", long(600)));
  expect(viewSize(mem)).toBeLessThan(MARKS.low);
  expect(mem.folding).toBe(true);
  // it comes back and builds every node, each the most a summary may be
  for (let l = 0; l <= 5; l++) for (let i = 0; i < 40 / 2 ** l; i++) if ((i + 1) * 2 ** l <= 40) addNode(mem, { i, l, text: "x".repeat(UNBUILT) });
  // the next message's batch takes it to low; from then on, built lines keep it within high
  addMessage(mem, newMsg(40, "echo", long(600)));
  expect(mem.folding).toBe(false);
  addNode(mem, { i: 40, l: 0, text: "x".repeat(UNBUILT) });
  expect(viewSize(mem)).toBeLessThanOrEqual(MARKS.low);
  for (let t = 41; t < 60; t++) {
    addMessage(mem, newMsg(t, "echo", long(600)));
    if (!mem.folding) addNode(mem, { i: t, l: 0, text: "x".repeat(UNBUILT + 8) }); // a stubborn one, a few bytes over
    expect(viewSize(mem)).toBeLessThanOrEqual(MARKS.high + UNBUILT);
  }
});

// a data dir written in one go: `count` messages, every leaf summarized, no parent
function bulkDir(count: number) {
  const dir = scratchDir(), at = "2026-10-08T12:00:00.000Z";
  mkdirSync(`${dir}/chat/main`, { recursive: true });
  mkdirSync(`${dir}/chat/tree`, { recursive: true });
  const msgs = Array.from({ length: count }, (_, i) => JSON.stringify(newMsg(i, "echo", long(600), new Date(at))));
  const nodes = Array.from({ length: count }, (_, i) => JSON.stringify({ i, l: 0, size: 404, text: summary({ i, l: 0 }, 400) }));
  writeFileSync(`${dir}/chat/main/2026-10-08.jsonl`, `${msgs.join("\n")}\n`);
  writeFileSync(`${dir}/chat/tree/2026-10-08.jsonl`, `${nodes.join("\n")}\n`);
  return dir;
}

test("a saved view far behind the log catches up as fast as a rebuild, to what appending gives", async () => {
  const dir = bulkDir(3200);
  // saved after message 199, owing nothing: two hundred lines, no parent to merge into
  writeFileSync(`${dir}/chat/view.json`, JSON.stringify({ folding: false, view: Array.from({ length: 200 }, (_, i) => [0, i]) }));
  const t0 = performance.now();
  const { mem, problems } = await load(dir);
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(problems).toEqual(["chat/view.json: 3000 messages behind the log; appended them"]);
  // with nothing to merge, appending from message 0 gives the same view
  expect({ folding: mem.folding, view: mem.view }).toEqual(K.refold(mem, MARKS, UNBUILT));
  expect(mem.folding).toBe(true);
});

test("something other than a file where view.json goes is rebuilt around, and moved aside by the writer", async () => {
  const dir = bulkDir(30);
  mkdirSync(`${dir}/chat/view.json`);
  const read = await load(dir, false);
  expect(read.problems).toEqual(["chat/view.json: not a file; the view was rebuilt from the log"]);
  const first = await load(dir);
  expect(first.problems[0]).toBe("chat/view.json: not a file; the view was rebuilt from the log");
  expect(first.problems[1]).toStartWith(`chat/view.json: moved aside to ${dir}/chat/view.json.broken-`);
  expect(readdirSync(`${dir}/chat`).filter((n) => n.startsWith("view.json.broken-"))).toHaveLength(1);
  const next = await load(dir);
  expect(next.problems).toEqual([]);
  expect(next.mem.view).toEqual(first.mem.view);
});
