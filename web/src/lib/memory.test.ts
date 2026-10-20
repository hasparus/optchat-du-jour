// The memory view this page holds (E46, E47), against the server's own memory and feed in this
// process: the frames are server/memory-feed.ts's, as the link decodes them; /api/memory/view is
// src/memory-view.ts's viewPage. Whatever batches and summaries come, and changes that come while the
// first page is read, the store ends with the view's lines as the server has them; a change it can't
// follow on from, or a socket that dropped, reads the view again.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { Option } from "effect";
import { watchMemory } from "../../../server/memory-feed.ts";
import { NODE } from "../../../src/config.ts";
import { viewPage } from "../../../src/memory-view.ts";
import { newMsg, newNode } from "../../../src/store.ts";
import { built, type Mem, newMem, nodes, ready } from "../../../src/tree.ts";
import { addMessage, addNode } from "../../../src/view.ts";
import type { MemoryChange, MemoryLine, MemoryPage } from "@wire";
import type { LinkStatus } from "./connection";
import { applyChange, applyPage, emptyMemory, makeMemory, type Memory, memoryItems, unread } from "./memory";
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

// the server: a memory with small marks, and its feed's frames as they would cross the socket
function server(seed: number) {
  const random = rng(seed);
  const mem = newMem({ high: 5000, low: 2500 }, { high: 2500, low: 1250 });
  const listeners = new Set<(e: Inbound) => void>();
  const statuses = new Set<(s: LinkStatus) => void>();
  let status: LinkStatus = "open";
  const feed = watchMemory(
    mem,
    (e) => {
      if (e.type !== "memory") return;
      const frame = Option.getOrThrow(parseFrame(JSON.stringify({ name: "memory", type: EventType.CUSTOM, value: e.change })));
      for (const l of listeners) l(frame);
    },
    { cap: 2048, start: 100 },
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
  const message = () => {
    const i = mem.root.length;
    addMessage(mem, newMsg(i, (["user", "talk", "tool", "echo"] as const)[i % 4] ?? "user", `${i} ${"x".repeat(random() < 0.5 ? 30 : 700)}`));
  };
  const summarize = () => {
    const open = [...nodes(mem.root.length)].filter((c) => !built(mem, c) && ready(mem, c));
    const c = open[Math.floor(random() * open.length)];
    if (c !== undefined) addNode(mem, newNode(c.l, c.i, `${c.l}:${c.i} ${"s".repeat(Math.floor(random() * (NODE - 20)))}`));
  };
  const reads: string[] = [];
  let delay = 0;
  const view = async (before: number | null, limit: number): Promise<MemoryPage> => {
    reads.push(`${before}:${limit}`);
    // the page is as of when the server reads it; the changes made while it is on its way come
    // over the socket before it arrives
    const page = viewPage(mem, feed.rev(), before ?? undefined, limit);
    await tick(delay);
    return page;
  };
  const deliver = (e: Inbound) => {
    for (const l of listeners) l(e);
  };
  return { deliver, feed, link, mem, message, random, reads, setDelay: (ms: number) => (delay = ms), setStatus, summarize, view };
}

const theirs = (mem: Mem, rev: number) => viewPage(mem, rev, undefined, 100_000).lines;

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
    expect(store.get().rev).toBe(s.feed.rev());
    expect(store.get().lines).toEqual(theirs(s.mem, s.feed.rev()));
    store.dispose();
  }
});

test("changes that come while the first page is read are applied after it, those it holds already skipped", async () => {
  const s = server(5);
  for (let k = 0; k < 20; k++) s.message();
  s.setDelay(30);
  const store = makeMemory(s.link, { view: s.view });
  store.show();
  // while the read is on its way: the page is read after these, so it holds some and not others
  for (let k = 0; k < 6; k++) s.message();
  await tick(60);
  for (let k = 0; k < 4; k++) s.summarize();
  s.setDelay(0);
  await tick(40);
  expect(store.get().rev).toBe(s.feed.rev());
  expect(store.get().lines.slice(store.get().want)).toEqual(theirs(s.mem, s.feed.rev()).slice(store.get().want));
  expect(s.reads.length).toBe(1); // nothing read twice
  store.dispose();
});

test("a change that doesn't follow on, or a socket that came back, reads the view again", async () => {
  const s = server(9);
  for (let k = 0; k < 10; k++) s.message();
  const store = makeMemory(s.link, { view: s.view });
  store.show();
  await tick(20);
  expect(s.reads).toEqual(["null:100"]);
  // a frame from far ahead (the server restarted, or one was lost): read again
  const rev = store.get().rev ?? 0;
  s.deliver({ name: "memory", type: EventType.CUSTOM, value: { hunks: [], rev: rev + 5, total: 10 } });
  await tick(20);
  expect(s.reads).toEqual(["null:100", "null:100"]);
  expect(store.get().rev).toBe(rev);
  // the socket dropped and came back: changes may have been missed while it was down
  s.message();
  s.setStatus("closed");
  s.setStatus("open");
  await tick(20);
  expect(s.reads).toEqual(["null:100", "null:100", "null:100"]);
  expect(store.get().lines).toEqual(theirs(s.mem, s.feed.rev()));
  store.dispose();
});

const ignore = () => {
  // nothing goes over a socket in this test: the store reads pages only
};

test("a view longer than a page: the newest lines first, older ones a page at a time as the reader goes up", async () => {
  const s = server(13);
  const mem = newMem({ high: 1e9, low: 5e8 }, { high: 1e9, low: 5e8 }); // never merges: a line per message
  const feed = watchMemory(mem, ignore, { start: 0 });
  for (let i = 0; i < 250; i++) addMessage(mem, newMsg(i, "user", `m${i}`));
  const reads: string[] = [];
  const store = makeMemory(s.link, {
    view: async (before, limit) => {
      reads.push(`${before}:${limit}`);
      return viewPage(mem, feed.rev(), before ?? undefined, limit);
    },
  });
  store.show();
  await tick(20);
  expect(store.get().want).toBe(150);
  expect(store.get().lines.slice(0, 150).every((l) => l === null)).toBe(true);
  store.earlier();
  await tick(20);
  expect(store.get().want).toBe(50);
  store.earlier();
  await tick(20);
  expect(store.get().want).toBe(0);
  expect(reads).toEqual(["null:100", "150:100", "50:50"]);
  expect(store.get().lines).toEqual(theirs(mem, feed.rev()));
  store.dispose();
  feed.close();
});

const line = (id: number, o: Partial<MemoryLine> = {}): MemoryLine => ({ built: true, from: null, i: id, id, l: 0, n: 1, size: 5, text: `t${id}`, to: null, ...o });

test("applyChange splices each hunk in order, keeps where the reader is, and refuses one out of turn", () => {
  const m: Memory = { ...emptyMemory, lines: [line(0), line(1), line(2), line(3), null], rev: 7, want: 2 };
  const merged = { built: true, from: null, i: 0, id: 0, l: 1, n: 2, size: 9, text: "pair", to: null };
  const c: MemoryChange = {
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
  // a page as of another change is not kept
  expect(applyPage(next, { from: 3, lines: [line(9)], rev: 7, total: 5 })).toBeNull();
  expect(applyPage(next, { from: 3, lines: [line(9)], rev: 8, total: 5 })?.lines[3]).toEqual(line(9));
  expect(unread(next)).toEqual([{ before: 5, limit: 2 }]);
  expect(unread({ ...next, want: 4 })).toEqual([{ before: 5, limit: 1 }]);
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
});
