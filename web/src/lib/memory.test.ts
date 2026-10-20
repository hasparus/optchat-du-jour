// The memory view this page holds (E46, E47), against the server's own memory and feed in this
// process: the frames are server/memory-feed.ts's, as the link decodes them; /api/memory/view is
// src/memory-view.ts's viewPage. Whatever batches and summaries come, and changes that come while the
// first page is read, the store ends with the view's lines as the server has them; a change it can't
// follow on from, another run, or a socket that came back reads the view again and keeps the
// reader's place; a read that fails says so and is tried again.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { Option } from "effect";
import { watchMemory } from "../../../server/memory-feed.ts";
import { NODE } from "../../../src/config.ts";
import { type Counted, viewPage } from "../../../src/memory-view.ts";
import { newMsg, newNode } from "../../../src/store.ts";
import { built, type Mem, newMem, nodes, ready } from "../../../src/tree.ts";
import { addMessage, addNode } from "../../../src/view.ts";
import type { MemoryChange, MemoryLine, MemoryPage } from "@wire";
import type { LinkStatus } from "./connection";
import { applyChange, applyPage, emptyMemory, firstPage, makeMemory, type Memory, memoryItems, runsOf, unread } from "./memory";
import { type Inbound, parseFrame } from "./protocol";

const tick = async (ms = 5) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

const NEVER = { high: 1e9, low: 5e8 }; // marks no view reaches: a line per message

// the server: a memory, its feed's frames as they would cross the socket, and /api/memory/view
const MARKS = { high: 5000, low: 2500 };
// what a test turns on the fake server: which change pages are as of, how late they come, a failure
type Knobs = { at: () => Counted; delay: number; failing: string | null };
function server(seed: number, marks = MARKS) {
  const random = rng(seed);
  const mem: Mem = newMem(marks, { high: marks.high / 2, low: marks.low / 2 });
  const listeners = new Set<(e: Inbound) => void>();
  const statuses = new Set<(s: LinkStatus) => void>();
  let status: LinkStatus = "open";
  // frames reach the page only while its socket is open, as a real one's do
  const deliver = (e: Inbound) => {
    if (status !== "open") return;
    for (const l of listeners) l(e);
  };
  const feed = watchMemory(
    mem,
    (e) => {
      if (e.type === "memory") deliver(Option.getOrThrow(parseFrame(JSON.stringify({ name: "memory", type: EventType.CUSTOM, value: e.change }))));
    },
    { cap: 2048 },
  );
  const link = {
    listen: (l: (e: Inbound) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onStatus: (l: (s: LinkStatus) => void) => {
      statuses.add(l);
      return () => statuses.delete(l);
    },
    status: () => status,
  };
  const setStatus = (s: LinkStatus) => {
    status = s;
    for (const l of statuses) l(s);
  };
  const message = (size = random() < 0.5 ? 30 : 700) => {
    const i = mem.root.length;
    addMessage(mem, newMsg(i, (["user", "talk", "tool", "echo"] as const)[i % 4] ?? "user", `${i} ${"x".repeat(size)}`));
  };
  const summarize = () => {
    const open = [...nodes(mem.root.length)].filter((c) => !built(mem, c) && ready(mem, c));
    const c = open[Math.floor(random() * open.length)];
    if (c !== undefined) addNode(mem, newNode(c.l, c.i, `${c.l}:${c.i} ${"s".repeat(Math.floor(random() * (NODE - 20)))}`));
  };
  const reads: string[] = [];
  const o: Knobs = { at: () => feed.at(), delay: 0, failing: null };
  const failed = (): string | null => o.failing; // read anew after an await
  const view = async (before: number | null, limit: number): Promise<MemoryPage> => {
    reads.push(`${before}:${limit}`);
    const failingNow = failed();
    if (failingNow !== null) throw new Error(failingNow);
    // the page is as of when the server reads it; the changes made while it is on its way come
    // over the socket before it arrives
    const page = viewPage(mem, o.at(), before ?? undefined, limit);
    await tick(o.delay);
    const failingLater = failed(); // the network went while it was on its way
    if (failingLater !== null) throw new Error(failingLater);
    return page;
  };
  return { deliver, feed, link, mem, message, o, random, reads, setStatus, summarize, view };
}

const theirs = (s: { mem: Mem; feed: { at: () => Counted } }) => viewPage(s.mem, s.feed.at(), undefined, 100_000).lines;

test("the store follows the server's view through batches and late summaries, reading only what frames left out", async () => {
  for (const seed of [3, 11, 2024]) {
    const s = server(seed);
    for (let k = 0; k < 30; k++) s.message();
    const store = makeMemory(s.link, { view: s.view });
    store.show();
    await tick(20);
    for (let step = 0; step < 250; step++) {
      if (s.random() < 0.4) s.message();
      else s.summarize();
      if (step % 10 === 0) await tick();
    }
    // the reader goes up to the oldest line
    for (let k = 0; k < 20 && store.get().want > 0; k++) {
      store.earlier();
      await tick(10);
    }
    await tick(30);
    expect(store.get().rev).toBe(s.feed.at().rev);
    expect(store.get().lines).toEqual(theirs(s));
    store.dispose();
  }
});

test("changes that come while the first page is read are applied after it, those it holds already skipped", async () => {
  const s = server(5);
  for (let k = 0; k < 20; k++) s.message();
  s.o.delay = 30;
  const store = makeMemory(s.link, { view: s.view });
  store.show();
  // while the read is on its way: the page is as of before these
  for (let k = 0; k < 6; k++) s.message();
  await tick(60);
  for (let k = 0; k < 4; k++) s.summarize();
  s.o.delay = 0;
  await tick(40);
  expect(store.get().rev).toBe(s.feed.at().rev);
  expect(store.get().lines.slice(store.get().want)).toEqual(theirs(s).slice(store.get().want));
  expect(s.reads.length).toBe(1); // nothing read twice
  store.dispose();
});

test("a frame held during the first read that skips a change reads the view again, and ends as the server's", async () => {
  const s = server(6);
  for (let k = 0; k < 10; k++) s.message();
  s.o.delay = 30;
  const store = makeMemory(s.link, { view: s.view });
  store.show();
  await tick(1);
  // held while the page is on its way: the next change, then one that skips a number
  const at = s.feed.at();
  s.deliver({ name: "memory", type: EventType.CUSTOM, value: { boot: at.boot, hunks: [], rev: at.rev + 2, total: s.mem.view.length } });
  await tick(50);
  s.o.delay = 0;
  await tick(50);
  expect(s.reads).toEqual(["null:100", "null:100"]);
  expect(store.get().lines).toEqual(theirs(s));
  store.dispose();
});

test("a change that doesn't follow on, another run's, or a socket that came back reads the view again", async () => {
  const s = server(9);
  for (let k = 0; k < 10; k++) s.message();
  const store = makeMemory(s.link, { view: s.view });
  store.show();
  await tick(20);
  expect(s.reads).toEqual(["null:100"]);
  const { boot, rev } = s.feed.at();
  // a frame from far ahead (one was lost): read again
  s.deliver({ name: "memory", type: EventType.CUSTOM, value: { boot, hunks: [], rev: rev + 5, total: 10 } });
  await tick(20);
  expect(s.reads.length).toBe(2);
  // the next number, of another run (the server restarted and counts from 0 again): read again
  s.deliver({ name: "memory", type: EventType.CUSTOM, value: { boot: "another", hunks: [], rev: rev + 1, total: 10 } });
  await tick(20);
  expect(s.reads.length).toBe(3);
  expect(store.get().boot).toBe(boot);
  // the socket dropped and came back: changes may have been missed while it was down
  s.message();
  s.setStatus("closed");
  s.setStatus("open");
  await tick(20);
  expect(s.reads.length).toBe(4);
  expect(store.get().lines).toEqual(theirs(s));
  store.dispose();
});

test("a view longer than a page: the newest lines first, older ones a page at a time as the reader goes up; a reconnect keeps the reader's place", async () => {
  const s = server(13, NEVER);
  for (let i = 0; i < 350; i++) s.message(5);
  const store = makeMemory(s.link, { view: s.view });
  store.show();
  await tick(20);
  expect(store.get().want).toBe(250);
  expect(store.get().lines.slice(0, 250).every((l) => l === null)).toBe(true);
  store.earlier();
  await tick(20);
  store.earlier();
  await tick(20);
  expect(store.get().want).toBe(50);
  expect(s.reads).toEqual(["null:100", "250:100", "150:100"]);
  // back from the background: the view is read again, as far up as the reader had gone
  s.setStatus("closed");
  s.setStatus("open");
  await tick(30);
  expect(store.get().want).toBe(50);
  expect(store.get().lines.slice(50)).toEqual(theirs(s).slice(50));
  expect(s.reads.slice(3)).toEqual(["null:100", "250:200"]);
  store.earlier();
  await tick(20);
  expect(store.get().want).toBe(0);
  expect(store.get().lines).toEqual(theirs(s));
  store.dispose();
});

test("a read of older lines that fails says why, is tried again after a wait, and at once on the reader's ask", async () => {
  const s = server(17, NEVER);
  for (let i = 0; i < 150; i++) s.message(5);
  const store = makeMemory(s.link, { retryMs: 40, view: s.view });
  store.show();
  await tick(20);
  s.o.failing = "offline";
  store.earlier();
  await tick(10);
  expect(store.get().error).toBe("offline");
  const failed = s.reads.length;
  await tick(60); // the wait: tried again by itself, and failed again
  expect(s.reads.length).toBeGreaterThan(failed);
  s.o.failing = null;
  store.retry();
  await tick(20);
  expect(store.get().error).toBeNull();
  expect(store.get().lines).toEqual(theirs(s));
  store.dispose();
});

test("a fill a re-read took over from fails without cancelling the re-read's retry: the store recovers", async () => {
  const s = server(21, NEVER);
  for (let i = 0; i < 250; i++) s.message(5);
  const store = makeMemory(s.link, { retryMs: 30, view: s.view });
  store.show();
  await tick(20);
  // an older page's read on its way, slowly
  s.o.delay = 50;
  store.earlier();
  await tick(5);
  // the network goes and the socket comes back: the re-read fails at once, then the old read does
  s.o.failing = "offline";
  s.setStatus("closed");
  s.setStatus("open");
  await tick(60);
  // the network is back: the re-read's own retry reads the view again
  s.o.failing = null;
  s.o.delay = 0;
  s.message(5);
  await tick(400);
  expect(store.get().error).toBeNull();
  expect(store.get().rev).toBe(s.feed.at().rev);
  expect(store.get().lines.slice(store.get().want)).toEqual(theirs(s).slice(store.get().want));
  store.dispose();
});

test("dispose() leaves nothing behind: no timer pending, and a read in flight schedules nothing", async () => {
  const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const pending = new Set<unknown>();
  // the store's timers, counted while it lives: those set from memory.ts only, since a link an
  // earlier test file left open may set its own meanwhile (its watchdog, connection.ts)
  const counted = Object.assign(
    (f: () => void, ms?: number) => {
      const id: unknown = realSet(() => {
        pending.delete(id);
        f();
      }, ms);
      if (new Error("where").stack?.includes("/lib/memory.ts") === true) pending.add(id);
      return id;
    },
    { __promisify__: realSet.__promisify__ },
  );
  try {
    // a failed read waiting for its retry
    const a = server(22);
    for (let i = 0; i < 5; i++) a.message(5);
    a.o.failing = "offline";
    const clear = (id: ReturnType<typeof setTimeout>) => {
      pending.delete(id);
      realClear(id);
    };
    Object.assign(globalThis, { clearTimeout: clear, setTimeout: counted });
    const first = makeMemory(a.link, { retryMs: 50, view: a.view });
    first.show();
    await tick(10);
    expect(first.get().error).toBe("offline");
    expect(pending.size).toBe(1); // the retry
    first.dispose();
    expect(pending.size).toBe(0);
    Object.assign(globalThis, { clearTimeout: realClear, setTimeout: realSet });
    await tick(150);
    expect(a.reads.length).toBe(1);
    // a read on its way when the store is disposed, failing after
    const b = server(23);
    for (let i = 0; i < 5; i++) b.message(5);
    b.o.delay = 30;
    const second = makeMemory(b.link, { retryMs: 10, view: b.view });
    second.show();
    await tick(5);
    b.o.failing = "offline";
    second.dispose();
    await tick(200);
    expect(b.reads.length).toBe(1);
  } finally {
    Object.assign(globalThis, { clearTimeout: realClear, setTimeout: realSet });
  }
});

test("a change that replaces the whole list with lines left to read is read again as a gap, keeping the reader's place", async () => {
  const s = server(24, NEVER);
  for (let i = 0; i < 250; i++) s.message(5);
  const store = makeMemory(s.link, { view: s.view });
  store.show();
  await tick(20);
  store.earlier();
  await tick(20);
  expect(store.get().want).toBe(50);
  const { boot, rev } = s.feed.at();
  // as the feed sends a change whose hunks alone pass the cap (src/memory-view.ts memoryChange)
  s.deliver({ name: "memory", type: EventType.CUSTOM, value: { boot, hunks: [{ added: 250, at: 0, removed: 250 }], rev: rev + 1, total: 250 } });
  await tick(30);
  expect(s.reads.slice(2)).toEqual(["null:100", "150:100"]); // read again from the reader's place, not from line 0
  expect(store.get().want).toBe(50);
  store.dispose();
});

test("a batch that merged while the socket was down: the reader's place goes by message, not by index", async () => {
  // marks a few hundred short lines reach: messages merge oldest first once past them
  const s = server(25, { high: 4000, low: 2000 });
  const all = () => {
    for (let more = true; more; ) {
      more = false;
      for (const c of nodes(s.mem.root.length))
        if (!built(s.mem, c) && ready(s.mem, c)) {
          addNode(s.mem, newNode(c.l, c.i, `s${c.l}:${c.i}`));
          more = true;
        }
    }
  };
  for (let i = 0; i < 300; i++) {
    s.message(5);
    all();
  }
  const store = makeMemory(s.link, { view: s.view });
  store.show();
  await tick(20);
  for (let k = 0; k < 20 && store.get().want > 100; k++) {
    store.earlier();
    await tick(10);
  }
  const before = store.get();
  const placeLine = before.lines[before.want];
  if (placeLine === null || placeLine === undefined) throw new Error("no line at the reader's place");
  const place = placeLine.id;
  // offline: messages enough for a batch, which merges lines below the reader's place
  s.setStatus("closed");
  const lines = s.mem.view.length;
  for (let k = 0; k < 400 && s.mem.view.length >= lines; k++) {
    s.message(5);
    all();
  }
  expect(s.mem.view.length).toBeLessThan(lines);
  const k = s.mem.view.findIndex((c) => c.i * 2 ** c.l <= place && place < (c.i + 1) * 2 ** c.l);
  expect(k).toBeLessThan(before.want); // by index, the place would have slid to newer messages
  s.setStatus("open");
  await tick(100);
  const after = store.get();
  const shown = after.lines[after.want];
  expect(after.want).toBe(k);
  expect(shown !== null && shown !== undefined && shown.id <= place && place < shown.id + shown.n).toBe(true);
  expect(after.lines.slice(after.want)).toEqual(theirs(s).slice(after.want));
  store.dispose();
});

const line = (id: number, o: Partial<MemoryLine> = {}): MemoryLine => ({ built: true, from: null, i: id, id, l: 0, n: 1, size: 5, text: `t${id}`, to: null, ...o });

test("applyChange splices each hunk in order, keeps where the reader is, and refuses one out of turn or of another run", () => {
  const m: Memory = { ...emptyMemory, boot: "b", lines: [line(0), line(1), line(2), line(3), null], rev: 7, want: 2 };
  const merged = { built: true, from: null, i: 0, id: 0, l: 1, n: 2, size: 9, text: "pair", to: null };
  const c: MemoryChange = {
    boot: "b",
    hunks: [
      { added: 1, at: 0, lines: [merged], removed: 2 },
      { added: 1, at: 3, removed: 0 },
    ],
    rev: 8,
    total: 5,
  };
  const next = applyChange(m, c);
  if (next === "gap") throw new Error("gap");
  expect(next.lines).toEqual([merged, line(2), line(3), null, null]);
  expect(next.want).toBe(1); // the merged lines were below it: it moves with what it showed
  expect(next.rev).toBe(8);
  expect(applyChange(next, c)).toBe(next); // had it already
  expect(applyChange(next, { ...c, rev: 10 })).toBe("gap");
  expect(applyChange(m, { ...c, total: 9 })).toBe("gap"); // doesn't add up: read again
  expect(applyChange(m, { ...c, boot: "c" })).toBe("gap");
  // the whole list replaced with its lines left to read: a gap; with its lines: applied
  expect(applyChange(m, { boot: "b", hunks: [{ added: 3, at: 0, removed: 5 }], rev: 8, total: 3 })).toBe("gap");
  const replaced = applyChange(m, { boot: "b", hunks: [{ added: 1, at: 0, lines: [merged], removed: 5 }], rev: 8, total: 1 });
  expect(replaced === "gap" ? null : replaced.lines).toEqual([merged]);
  // a line appended to a view the reader has whole (want at its end) is shown, not hidden under it
  const whole: Memory = { ...emptyMemory, boot: "b", lines: [], rev: 1, want: 0 };
  const appended = applyChange(whole, { boot: "b", hunks: [{ added: 1, at: 0, lines: [line(0)], removed: 0 }], rev: 2, total: 1 });
  expect(appended === "gap" ? null : appended.want).toBe(0);
  // a page as of another change, another run or another length is not kept
  const page = { boot: "b", from: 3, lines: [line(9)], rev: 8, total: 5 };
  expect(applyPage(next, { ...page, rev: 7 })).toBeNull();
  expect(applyPage(next, { ...page, boot: "c" })).toBeNull();
  expect(applyPage(next, { ...page, total: 6 })).toBeNull();
  expect(applyPage(next, page)?.lines[3]).toEqual(line(9));
  expect(unread(next)).toEqual([{ before: 5, limit: 2 }]);
  expect(unread({ ...next, want: 4 })).toEqual([{ before: 5, limit: 1 }]);
});

test("firstPage: a first read shows its page; a read again keeps the reader's place, clamped to the view", () => {
  const page: MemoryPage = { boot: "b", from: 300, lines: [line(300)], rev: 1, total: 301 };
  expect(firstPage(emptyMemory, page).want).toBe(300);
  const read = { ...emptyMemory, boot: "a", want: 40 };
  expect(firstPage(read, page).want).toBe(40);
  expect(firstPage({ ...read, want: 999 }, page).want).toBe(300);
  expect(firstPage({ ...read, want: 40 }, { ...page, from: 0, lines: [], total: 20 }).want).toBe(0);
});

const entry = (i: number, kind: "user" | "tool" | "echo" | "talk", text: string) => ({ date: "2026-10-05T10:00:00Z", i, kind, text });

test("memoryItems: a run of lines that are their own messages are the log's rows, a tool call with its output as one; the rest blocks or gaps", () => {
  const lines = [
    line(0, { l: 1, n: 2 }),
    line(2, { entry: entry(2, "user", "hi"), kind: "user" }),
    line(3, { entry: entry(3, "tool", 'Read {"file_path":"a"}'), kind: "tool" }),
    line(4, { entry: entry(4, "echo", "contents"), kind: "echo" }),
    null,
    null,
    line(7, { built: false, kind: "talk", text: null }),
  ];
  const items = memoryItems(lines);
  expect(items.map((x) => [x.kind, x.key])).toEqual([
    ["line", "m1:0"],
    ["row", "e2"],
    ["row", "e3"],
    ["gap", "gap4"],
    ["line", "m0:7"],
  ]);
  const tool = items[2];
  expect(tool?.kind === "row" && tool.row.kind === "tool" ? tool.row.output : null).toBe("contents");
  expect(memoryItems(lines, 6).map((x) => x.key)).toEqual(["m0:7"]);
  // a tool call whose output is a summary block of its own: the row before the block is `followed`
  const split = memoryItems([line(3, { entry: entry(3, "tool", 'Read {"file_path":"a"}'), kind: "tool" }), line(4, { kind: "echo" })]);
  expect(split.map((x) => (x.kind === "row" ? [x.key, x.followed] : [x.key]))).toEqual([["e3", true], ["m0:4"]]);
  expect(items.flatMap((x) => (x.kind === "row" && x.followed ? [x.key] : []))).toEqual([]);
});

test("runsOf: the messages under open lines, read a run at a time", () => {
  expect(runsOf([5, 3, 4, 9, 10, 4, 20])).toEqual([
    { count: 3, first: 3 },
    { count: 2, first: 9 },
    { count: 1, first: 20 },
  ]);
  expect(runsOf(Array.from({ length: 250 }, (_, k) => k), 100).map((r) => r.count)).toEqual([100, 100, 50]);
});
