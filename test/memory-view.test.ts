// The live memory view (E46, E47): what the server tells a client about the view's lines. A client
// that applies every CUSTOM `memory` frame, in order, to what it read holds the view as the server
// does, whatever batches merged and summaries were written in between; no frame is over its cap,
// and a line it had no room for is read from /api/memory/view; a summary written into a line is a
// change of that line alone; the pages and the children of a node read as the tree has them. No
// model calls: summaries are written by the test.
import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Effect, Fiber, Layer, Schema } from "effect";
import { HttpRouter } from "effect/http";
import { openStream } from "../server/agui.ts";
import { watchMemory } from "../server/memory-feed.ts";
import { memoryRoutes } from "../server/routes/memory.ts";
import { NODE } from "../src/config.ts";
import { mount } from "../src/http.ts";
import { childrenPage, type Counted, memoryChange, memoryLine, viewHunks, viewLine, viewPage } from "../src/memory-view.ts";
import type { SessionEvent } from "../src/session-events.ts";
import { newMsg, newNode } from "../src/store.ts";
import { built, type Coord, localTime, type Marks, type Mem, newMem, nodes, ready } from "../src/tree.ts";
import { addMessage, addNode, PLACEHOLDER } from "../src/view.ts";
import { type MemoryChange, MemoryChildren, type MemoryLine, MemoryPage, type SessionState } from "../src/wire.ts";
import { freePort } from "./ports.ts";

const ignore = () => {
  // a feed whose frames go nowhere
};
const MARKS: Marks = { high: 6000, low: 3000 };
const COMPACTION: Marks = { high: 3000, low: 1500 };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 2 ** 32;
  };
}

// a chat whose messages come with summaries written in a random order between them, some at once,
// some much later: what a pump with slow calls does
function chat(seed: number) {
  const random = rng(seed);
  const mem = newMem(MARKS, COMPACTION);
  const kinds = ["user", "talk", "tool", "echo", "note"] as const;
  const message = () => {
    const i = mem.root.length;
    const size = random() < 0.5 ? 20 + Math.floor(random() * 200) : 600 + Math.floor(random() * 2000);
    addMessage(mem, newMsg(i, kinds[i % kinds.length] ?? "user", `${i} ${"x".repeat(size)}`));
  };
  const summarize = () => {
    const open = [...nodes(mem.root.length)].filter((c) => !built(mem, c) && ready(mem, c));
    const c = open[Math.floor(random() * open.length)];
    if (c === undefined) return false;
    addNode(mem, newNode(c.l, c.i, `${c.l}:${c.i} ${"s".repeat(Math.floor(random() * (NODE - 20)))}`));
    return true;
  };
  return { mem, message, random, summarize };
}

// A client: the lines it holds (null: told of, not read yet), the frames it got, and what it does
// with them, as web/src/lib/memory.ts does: each hunk spliced in order, then what it lacks read
function client(mem: Mem, start: Counted) {
  const first = viewPage(mem, start, undefined, 100_000);
  let { rev } = first;
  let lines: (MemoryLine | null)[] = [...first.lines];
  const apply = (c: MemoryChange) => {
    expect(c.rev).toBe(rev + 1); // numbered one after another
    rev = c.rev;
    for (const h of c.hunks) {
      expect(h.lines === undefined || h.lines.length === h.added).toBe(true);
      lines = lines.toSpliced(h.at, h.removed, ...(h.lines ?? Array.from({ length: h.added }, () => null)));
    }
    expect(lines.length).toBe(c.total);
  };
  const fill = () => {
    const page = viewPage(mem, { boot: first.boot, rev }, undefined, 100_000);
    lines = lines.map((l, k) => l ?? page.lines[k] ?? null);
  };
  return { apply, fill, lines: () => lines };
}

test("a client that applies every frame in order holds the view as the server does, after batches and late summaries", () => {
  for (const seed of [1, 2, 3, 42, 777]) {
    const c = chat(seed);
    const frames: MemoryChange[] = [];
    const feed = watchMemory(c.mem, (e) => {
      if (e.type === "memory") frames.push(e.change);
    }, { cap: 1500 });
    const reader = client(c.mem, feed.at());
    let merged = false, inline = 0, bare = 0;
    for (let step = 0; step < 400; step++) {
      const before = c.mem.view.length;
      if (c.random() < 0.4) c.message();
      else c.summarize();
      if (c.mem.view.length < before) merged = true;
      for (const f of frames.splice(0)) {
        reader.apply(f);
        for (const h of f.hunks) if (h.lines === undefined) bare++;
        else inline++;
      }
      if (step % 7 === 0) reader.fill();
    }
    reader.fill();
    expect([...reader.lines()]).toEqual([...viewPage(c.mem, feed.at(), undefined, 100_000).lines]);
    expect(merged).toBe(true); // batches did merge lines
    expect(inline).toBeGreaterThan(0);
    expect(bare).toBeGreaterThan(0); // and some changes were too big for a 1.5 KB frame
    feed.close();
  }
});

test("no frame is over its cap, and a hunk carries its lines whole or not at all", () => {
  for (const cap of [512, 2048, 16 * 1024]) {
    const c = chat(cap);
    const frames: MemoryChange[] = [];
    const feed = watchMemory(c.mem, (e) => {
      if (e.type === "memory") frames.push(e.change);
    }, { cap });
    for (let step = 0; step < 300; step++) {
      if (c.random() < 0.4) c.message();
      else c.summarize();
    }
    feed.close();
    expect(frames.length).toBeGreaterThan(100);
    for (const f of frames) {
      expect(Buffer.byteLength(JSON.stringify({ name: "memory", type: "CUSTOM", value: f }))).toBeLessThanOrEqual(cap);
      for (const h of f.hunks) if (h.lines !== undefined) expect(h.lines.length).toBe(h.added);
    }
  }
});

test("a message's line goes out with it, numbered from 1 in the run, a short one with the message itself", () => {
  const mem = newMem(MARKS, COMPACTION);
  const out: SessionEvent[] = [];
  const feed = watchMemory(mem, (e) => {
    out.push(e);
  }, { boot: "b1" });
  addMessage(mem, newMsg(0, "user", "hello there"));
  addMessage(mem, newMsg(1, "talk", `a long reply ${"y".repeat(800)}`));
  expect(out.map((e) => (e.type === "memory" ? `${e.change.boot}:${e.change.rev}` : ""))).toEqual(["b1:1", "b1:2"]);
  expect(feed.at()).toEqual({ boot: "b1", rev: 2 });
  // another run is another boot, by default a random one
  const other = watchMemory(newMem(MARKS, COMPACTION), ignore);
  expect(other.at().boot).not.toBe(watchMemory(newMem(MARKS, COMPACTION), ignore).at().boot);
  const [first, second] = out;
  if (first?.type !== "memory" || second?.type !== "memory") throw new Error("no change");
  expect(first.change.hunks[0]?.lines?.[0]?.entry).toMatchObject({ i: 0, kind: "user", text: "hello there" });
  const appended = second.change.hunks[0];
  expect(appended).toMatchObject({ added: 1, at: 1, removed: 0 });
  // the long message is a line to summarize: its kind, no summary yet, and not itself
  expect(appended?.lines?.[0]).toMatchObject({ built: false, id: 1, kind: "talk", l: 0, text: null });
  expect(appended?.lines?.[0]?.entry).toBeUndefined();
  feed.close();
});

test("a summary written into an unbuilt line replaces that line, with its text", () => {
  const mem = newMem(MARKS, COMPACTION);
  const out: MemoryChange[] = [];
  const feed = watchMemory(mem, (e) => {
    if (e.type === "memory") out.push(e.change);
  }, { boot: "b" });
  addMessage(mem, newMsg(0, "user", "hello there"));
  addMessage(mem, newMsg(1, "talk", `a long reply ${"y".repeat(800)}`));
  out.length = 0;
  addNode(mem, newNode(0, 1, "talk: a short summary"));
  expect(out).toEqual([{ boot: "b", hunks: [{ added: 1, at: 1, lines: [memoryLine(mem, { i: 1, l: 0 })], removed: 1 }], rev: 3, total: 2 }]);
  expect(out[0]?.hunks[0]?.lines?.[0]).toMatchObject({ built: true, size: 21, text: "talk: a short summary" });
  // the merge of 0 and 1 is no line of the view: nothing to tell
  addNode(mem, newNode(0, 0, "user: hello there"));
  out.length = 0;
  addNode(mem, newNode(1, 0, "user: hello there\ntalk: a short summary"));
  expect(out).toEqual([]);
  feed.close();
  addMessage(mem, newMsg(2, "user", "after the feed closed"));
  expect(out).toEqual([]);
});

test("a level-0 line carries its message when the message is its own summary, and its kind always", () => {
  const mem = newMem(MARKS, COMPACTION);
  addMessage(mem, newMsg(0, "user", "short"));
  addMessage(mem, newMsg(1, "echo", "z".repeat(NODE))); // "echo: " + NODE bytes: past NODE
  const short = memoryLine(mem, { i: 0, l: 0 });
  expect(short.entry).toMatchObject({ i: 0, kind: "user", text: "short" });
  expect(short.kind).toBe("user");
  const long = memoryLine(mem, { i: 1, l: 0 });
  expect(long.entry).toBeUndefined();
  expect(long.kind).toBe("echo");
  expect(Object.hasOwn(long, "clipped")).toBe(false); // absent, never undefined
  addNode(mem, newNode(0, 1, "echo: zzz", true));
  expect(memoryLine(mem, { i: 1, l: 0 })).toMatchObject({ built: true, clipped: true, text: "echo: zzz" });
  const merge = memoryLine(mem, { i: 0, l: 1 });
  expect(merge).toMatchObject({ built: false, id: 0, l: 1, n: 2 });
  expect(Object.hasOwn(merge, "kind") || Object.hasOwn(merge, "entry")).toBe(false);
});

const c = (l: number, i: number): Coord => ({ i, l });
const pick = ({ built: b, i, id, l, n, size }: MemoryLine) => ({ built: b, i, id, l, n, size });
const isBuilt = () => true;

test("/api/view's line is the memory view's, in local time and with the placeholder until summarized", () => {
  const mem = newMem(MARKS, COMPACTION);
  addMessage(mem, newMsg(0, "talk", "z".repeat(NODE)));
  addMessage(mem, newMsg(1, "user", "short"));
  expect(viewLine(mem, { i: 0, l: 0 })).toEqual({ ...pick(memoryLine(mem, { i: 0, l: 0 })), from: localTime(mem.root[0]?.date ?? ""), text: PLACEHOLDER, to: localTime(mem.root[0]?.date ?? "") });
  addNode(mem, newNode(0, 0, "talk: zz"));
  expect(viewLine(mem, { i: 0, l: 0 })).toMatchObject({ built: true, size: 8, text: "talk: zz" });
});

test("viewHunks: an append, a merge and a fill, each where it happened", () => {
  const before = [c(1, 0), c(0, 2), c(0, 3), c(0, 4)];
  expect(viewHunks(before, [true, true, true, true], [...before, c(0, 5)], isBuilt)).toEqual([{ added: [c(0, 5)], at: 4, removed: 0 }]);
  // 2 and 3 merged into 1:1, and a message appended: two hunks, in the old list's places
  expect(viewHunks(before, [true, true, true, true], [c(1, 0), c(1, 1), c(0, 4), c(0, 5)], isBuilt)).toEqual([
    { added: [c(1, 1)], at: 1, removed: 2 },
    { added: [c(0, 5)], at: 4, removed: 0 },
  ]);
  // two levels at once: 0:0..0:3 into 2:0
  expect(viewHunks([c(0, 0), c(0, 1), c(0, 2), c(0, 3)], [true, true, true, true], [c(2, 0)], isBuilt)).toEqual([{ added: [c(2, 0)], at: 0, removed: 4 }]);
  // line 2 was written since
  expect(viewHunks(before, [true, true, false, true], before, isBuilt)).toEqual([{ added: [c(0, 3)], at: 2, removed: 1 }]);
  // adjacent ones are one hunk: line 3 written since and a message appended after it
  expect(viewHunks(before, [true, true, true, false], [...before, c(0, 5)], isBuilt)).toEqual([{ added: [c(0, 4), c(0, 5)], at: 3, removed: 1 }]);
});

test("memoryChange moves each hunk to where it applies after the ones before it", () => {
  const mem = newMem(MARKS, COMPACTION);
  for (let i = 0; i < 6; i++) addMessage(mem, newMsg(i, "user", `m${i}`));
  const change = memoryChange(mem, { boot: "b", rev: 5 }, [
    { added: [{ i: 0, l: 1 }], at: 0, removed: 2 },
    { added: [{ i: 1, l: 1 }], at: 2, removed: 2 },
  ]);
  expect(change.hunks.map(({ added, at, removed }) => ({ added, at, removed }))).toEqual([
    { added: 1, at: 0, removed: 2 },
    { added: 1, at: 1, removed: 2 },
  ]);
});

test("a change whose hunks alone don't fit is one hunk that replaces the whole list, under the cap", () => {
  const mem = newMem({ high: 1e9, low: 5e8 }, { high: 1e9, low: 5e8 });
  for (let i = 0; i < 200; i++) addMessage(mem, newMsg(i, "user", `m${i}`));
  // 100 one-line fills, far apart: more hunks than 600 bytes can name
  const hunks = Array.from({ length: 100 }, (_, k) => ({ added: [{ i: 2 * k, l: 0 }], at: 2 * k, removed: 1 }));
  const change = memoryChange(mem, { boot: "b", rev: 7 }, hunks, 600);
  expect(change).toEqual({ boot: "b", hunks: [{ added: 200, at: 0, removed: 200 }], rev: 7, total: 200 });
  expect(Buffer.byteLength(JSON.stringify({ name: "memory", type: "CUSTOM", value: change }))).toBeLessThanOrEqual(600);
  // the old list's length is what the hunks took and gave: a merge of 4 into 2 and a line appended
  const merged = memoryChange(mem, { boot: "b", rev: 8 }, [...hunks.slice(0, 99), { added: [{ i: 0, l: 1 }], at: 0, removed: 3 }], 600);
  expect(merged.hunks).toEqual([{ added: 200, at: 0, removed: 202 }]);
});

test("pages of the view, and a node opened a level or more down, a page at a time", () => {
  const mem = newMem(MARKS, COMPACTION);
  for (let i = 0; i < 8; i++) addMessage(mem, newMsg(i, "user", `m${i}`));
  const at = { boot: "b", rev: 3 };
  expect(viewPage(mem, at)).toMatchObject({ boot: "b", from: 0, rev: 3, total: 8 });
  expect(viewPage(mem, at, 6, 2)).toMatchObject({ from: 4, total: 8 });
  expect(viewPage(mem, at, 6, 2).lines.map((l) => l.id)).toEqual([4, 5]);
  expect(viewPage(mem, at, 99, 3).lines.map((l) => l.id)).toEqual([5, 6, 7]);
  const halves = childrenPage(mem, { i: 0, l: 3 }, 1);
  expect(halves?.lines.map(({ i, l, n }) => ({ i, l, n }))).toEqual([
    { i: 0, l: 2, n: 4 },
    { i: 1, l: 2, n: 4 },
  ]);
  const messages = childrenPage(mem, { i: 0, l: 3 }, 3, 2, 3);
  expect(messages).toMatchObject({ depth: 3, from: 2, total: 8 });
  expect(messages?.lines.map((l) => l.entry?.text)).toEqual(["m2", "m3", "m4"]);
  expect(childrenPage(mem, { i: 1, l: 3 }, 1)).toBeNull(); // past the log
  expect(childrenPage(mem, { i: 0, l: 1 }, 2)).toBeNull(); // deeper than its level
});

// the routes alone, served in this process on a port of their own
function routes(mem: Mem, at = () => ({ boot: "b9", rev: 9 })) {
  const port = freePort();
  const served = HttpRouter.serve(mount((router) => memoryRoutes(router, { at, mem }))).pipe(
    Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port })),
    Layer.provide(BunServices.layer),
  );
  const fiber = Effect.runFork(Layer.launch(served));
  const get = async (path: string) => {
    for (let tries = 0; ; tries++) {
      try {
        return await fetch(`http://127.0.0.1:${port}${path}`);
      } catch (error) {
        if (tries > 50) throw error;
        await Bun.sleep(20); // not listening yet
      }
    }
  };
  const json = async (path: string) => {
    const res = await get(path);
    return res.json();
  };
  const status = async (path: string) => {
    const res = await get(path);
    return res.status;
  };
  return { dispose: async () => Effect.runPromise(Fiber.interrupt(fiber)), json, status };
}

test("GET /api/memory/view and /api/memory/children: pages as the schemas have them; a bad query is a 400, a node past the log a 404", async () => {
  const mem = newMem(MARKS, COMPACTION);
  for (let i = 0; i < 8; i++) addMessage(mem, newMsg(i, i % 2 === 0 ? "user" : "talk", `m${i}`));
  addNode(mem, newNode(0, 0, "user: m0"));
  const { dispose, json, status } = routes(mem);
  try {
    const page = Schema.decodeUnknownSync(MemoryPage)(await json("/api/memory/view?before=4&limit=2"));
    expect(page).toMatchObject({ boot: "b9", from: 2, rev: 9, total: 8 });
    expect(page.lines.map((l) => l.entry?.text)).toEqual(["m2", "m3"]);
    const tail = Schema.decodeUnknownSync(MemoryPage)(await json("/api/memory/view"));
    expect(tail.lines.map((l) => l.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(tail.lines[0]).toMatchObject({ built: true, text: "user: m0" });
    const open = Schema.decodeUnknownSync(MemoryChildren)(await json("/api/memory/children?l=2&i=1&depth=2&from=1&limit=2"));
    expect(open).toMatchObject({ depth: 2, from: 1, i: 1, l: 2, total: 4 });
    expect(open.lines.map((l) => l.id)).toEqual([5, 6]);
    const halves = Schema.decodeUnknownSync(MemoryChildren)(await json("/api/memory/children?l=3&i=0"));
    expect(halves.lines.map((l) => [l.l, l.i])).toEqual([
      [2, 0],
      [2, 1],
    ]);
    for (const bad of ["/api/memory/view?limit=0", "/api/memory/view?limit=501", "/api/memory/view?before=-1", "/api/memory/view?before=x", "/api/memory/children?l=1", "/api/memory/children?l=1&i=0&depth=2", "/api/memory/children?l=0&i=0", "/api/memory/children?l=53&i=0", "/api/memory/children?l=1&i=0.5", "/api/memory/children?l=2&i=0&from=-1", "/api/memory/children?l=2&i=0&limit=501"])
      expect([bad, await status(bad)]).toEqual([bad, 400]);
    expect(await status("/api/memory/children?l=3&i=1")).toBe(404);
    expect(await status("/api/memory/children?l=4&i=0")).toBe(404);
  } finally {
    await dispose();
  }
});

const STATE: SessionState = { budget: 128_000, device: "mini", down: [], effort: null, engine: null, engines: [], followUp: "steer", messages: 0, phase: "idle", pending: [], stopped: null, viewBytes: 0, waiting: 0 };

test("a change goes to a connection as a CUSTOM `memory` frame, as the feed made it", () => {
  const { translate } = openStream({ entries: [], live: null, state: STATE, thread: "mini", window: 10 });
  const change: MemoryChange = { boot: "b", hunks: [{ added: 1, at: 0, removed: 0 }], rev: 4, total: 1 };
  expect(translate({ change, type: "memory" })).toEqual([{ name: "memory", type: EventType.CUSTOM, value: change }]);
});
