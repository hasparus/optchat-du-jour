// The memory view as this page holds it (E46, E47; SPEC "Web UI", Memory): the view's lines, read a
// page at a time from /api/memory/view and kept live by the CUSTOM `memory` frames, which say where
// lines changed (a message's line appended, lines a batch merged, a summary written into a line),
// numbered one after the other. A frame that names a change this page can't follow on from (one
// missed, a server restarted) reads the view again. What the reader opened, the halves of a summary
// and the messages under a line, is read when first opened and kept: a written node never changes.
// The chat's Memory mode and the Memory screen draw the same store (../memory/memory-view.tsx).
import { EventType } from "@ag-ui/core";
import type { MemoryChange, MemoryLine, MemoryPage, Msg } from "@wire";
import { api } from "./api.ts";
import type { Link, LinkStatus } from "./connection.ts";
import { entryRows, type Row } from "./rows.ts";

export const MEMORY_PAGE = 100; // lines per read, older ones on the reader's ask
const MOST_PER_READ = 500; // the server's own limit

// A node opened in place: its descendants `depth` levels down (2^depth of them), as far as read
export type Opened = { readonly depth: number; readonly total: number; readonly lines: readonly (MemoryLine | null)[]; readonly error: string | null };

export type Memory = {
  // the change the lines are as of; null until the first page is in
  readonly rev: number | null;
  // every line of the view, null where not read yet
  readonly lines: readonly (MemoryLine | null)[];
  // the first line the reader wants to see: those below it are neither read nor shown
  readonly want: number;
  readonly error: string | null;
  // open or closed, as the reader chose, by node (`l:i`); the rest are as defaultOpen says
  readonly choices: ReadonlyMap<string, boolean>;
  readonly opened: ReadonlyMap<string, Opened>;
  // the message under a level-0 line that isn't its own summary, read when the line opens
  readonly messages: ReadonlyMap<number, Msg | "error">;
};

export const emptyMemory: Memory = { choices: new Map(), error: null, lines: [], messages: new Map(), opened: new Map(), rev: null, want: 0 };

export const nodeKey = (line: Pick<MemoryLine, "l" | "i">) => `${line.l}:${line.i}`;

// A message summarized at level 0 that was said in the conversation, yours or a reply, reads
// whole until the reader closes it, as the log shows it (UniiChat opens these too); its summary is
// a tap away. Everything else shows its summary: what the model reads.
export const defaultOpen = (line: MemoryLine) => line.l === 0 && line.entry === undefined && (line.kind === "user" || line.kind === "talk");
export const isOpen = (m: Memory, line: MemoryLine) => m.choices.get(nodeKey(line)) ?? defaultOpen(line);

// Change `c` applied to `m`: "gap" when it doesn't follow on from what `m` is as of (a change was
// missed: read again), `m` itself when it is one `m` has already
export function applyChange(m: Memory, c: MemoryChange): Memory | "gap" {
  if (m.rev === null || c.rev <= m.rev) return m;
  if (c.rev !== m.rev + 1) return "gap";
  let { lines, want } = m;
  for (const h of c.hunks) {
    lines = lines.toSpliced(h.at, h.removed, ...(h.lines ?? Array.from({ length: h.added }, () => null)));
    if (h.at + h.removed <= want) want += h.added - h.removed;
    else if (h.at < want) want = h.at;
  }
  if (lines.length !== c.total) return "gap";
  return { ...m, lines, rev: c.rev, want: Math.max(0, Math.min(want, lines.length)) };
}

// A page read from /api/memory/view, kept only when it is as of the change `m` is (else null: read
// it again once the changes in between are in)
export function applyPage(m: Memory, page: MemoryPage): Memory | null {
  if (page.rev !== m.rev || page.total !== m.lines.length) return null;
  const lines = [...m.lines];
  for (const [k, line] of page.lines.entries()) lines[page.from + k] = line;
  return { ...m, lines };
}

// the first page: the view's newest lines, the rest to be read as the reader goes up
export const firstPage = (m: Memory, page: MemoryPage): Memory => ({
  ...m,
  error: null,
  lines: Array.from({ length: page.total }, (_, k) => (k >= page.from ? (page.lines[k - page.from] ?? null) : null)),
  rev: page.rev,
  want: page.from,
});

// The reads that fill what the reader wants to see and isn't read: `before` and `limit` of each,
// the newest first
export function unread(m: Memory): { readonly before: number; readonly limit: number }[] {
  const out: { before: number; limit: number }[] = [];
  for (let k = m.lines.length - 1; k >= m.want; k--) {
    if (m.lines[k] !== null) continue;
    const end = k + 1;
    while (k - 1 >= m.want && m.lines[k - 1] === null && end - k < MOST_PER_READ) k--;
    out.push({ before: end, limit: end - k });
  }
  return out;
}

// What the view shows from the line the reader wants on: runs of lines that are their own messages
// as the log's rows (a tool call and its output pair up as there), every other line as a summary
// block, and what isn't read yet as a gap
export type MemoryItem =
  | { readonly kind: "row"; readonly key: string; readonly row: Row }
  | { readonly kind: "line"; readonly key: string; readonly line: MemoryLine }
  | { readonly kind: "gap"; readonly key: string; readonly count: number };
export function memoryItems(lines: readonly (MemoryLine | null)[], from = 0): MemoryItem[] {
  const out: MemoryItem[] = [];
  let run: Msg[] = [];
  const flush = () => {
    for (const row of entryRows(run)) out.push({ key: row.key, kind: "row", row });
    run = [];
  };
  let gap = 0;
  for (let k = from; k <= lines.length; k++) {
    const line = k < lines.length ? lines[k] : undefined;
    if (line === null) {
      flush();
      gap++;
      continue;
    }
    if (gap > 0) {
      out.push({ count: gap, key: `gap${k - gap}`, kind: "gap" });
      gap = 0;
    }
    if (line === undefined) break;
    if (line.entry === undefined) {
      flush();
      out.push({ key: `m${nodeKey(line)}`, kind: "line", line });
    } else run.push(line.entry);
  }
  flush();
  return out;
}

export type MemoryOptions = {
  readonly view?: typeof api.memoryView;
  readonly children?: typeof api.memoryChildren;
  readonly messages?: (before: number, limit: number) => Promise<{ readonly entries: readonly Msg[] }>;
};


export function makeMemory(link: Pick<Link, "listen" | "onStatus" | "status">, options: MemoryOptions = {}) {
  const readView = options.view ?? api.memoryView;
  const readChildren = options.children ?? api.memoryChildren;
  const readMessages = options.messages ?? api.messages;
  let m: Memory = emptyMemory;
  const subscribers = new Set<() => void>();
  const set = (next: Memory) => {
    if (next === m) return;
    m = next;
    for (const f of subscribers) f();
  };
  // shown somewhere now: only then is the view read; once read it is kept live
  let active = 0;
  // the first page is being read: changes wait here until it is in
  let waiting: MemoryChange[] | null = null;
  let filling = false;
  let round = 0; // each read of the view from the start; a slower older one is dropped

  // read anew across awaits (a change may have come meanwhile)
  const revNow = () => m.rev;
  const fill = async () => {
    if (filling || m.rev === null) return;
    filling = true;
    try {
      for (let misses = 0; misses < 3; ) {
        const next = unread(m)[0];
        if (next === undefined) break;
        const page = await readView(next.before, next.limit);
        const kept = applyPage(m, page);
        if (kept === null) {
          // as of another change than the one held: a newer one comes next on the socket and
          // fills again; an older one is read again now
          if (page.rev > (revNow() ?? Number.POSITIVE_INFINITY)) break;
          misses++;
          continue;
        }
        set(kept);
      }
    } catch (error) {
      set({ ...m, error: error instanceof Error ? error.message : String(error) });
    } finally {
      filling = false;
    }
  };

  const load = async () => {
    const mine = ++round;
    waiting = [];
    try {
      const page = await readView(null, MEMORY_PAGE);
      if (mine !== round) return;
      let next = firstPage({ ...m, rev: null }, page);
      const held = waiting;
      waiting = null;
      for (const c of held) {
        const after = applyChange(next, c);
        if (after === "gap") {
          void load();
          return;
        }
        next = after;
      }
      set(next);
      void fill();
    } catch (error) {
      if (mine !== round) return;
      waiting = null;
      set({ ...m, error: error instanceof Error ? error.message : String(error) });
    }
  };

  const change = (c: MemoryChange) => {
    if (waiting !== null) {
      waiting.push(c);
      return;
    }
    if (m.rev === null) return; // never read: the first read will be as of now
    const next = applyChange(m, c);
    if (next === "gap") void load();
    else {
      set(next);
      if (next !== m || unread(next).length > 0) void fill();
    }
  };

  const unlisten = link.listen((e) => {
    if (e.type === EventType.CUSTOM && e.name === "memory") change(e.value);
  });
  // a socket that dropped may have missed changes: read the view again on the next one
  let last: LinkStatus = link.status();
  const unstatus = link.onStatus((status) => {
    const back = status === "open" && last !== "open";
    last = status;
    if (back && (m.rev !== null || active > 0)) void load();
  });

  // a node's descendants `depth` levels down, the next page of them; one read of a node at a time
  const reading = new Set<string>();
  const readOpened = async (line: MemoryLine, depth: number) => {
    const key = nodeKey(line);
    if (reading.has(key)) return;
    reading.add(key);
    const had = m.opened.get(key);
    const from = had?.depth === depth && had.error === null ? had.lines.length : 0;
    try {
      const page = await readChildren(line.l, line.i, depth, from, depth === 1 ? 2 : MEMORY_PAGE);
      const before = m.opened.get(key);
      const kept = before?.depth === depth ? before.lines.slice(0, page.from) : [];
      set({ ...m, opened: new Map(m.opened).set(key, { depth, error: null, lines: [...kept, ...page.lines], total: page.total }) });
    } catch (error) {
      set({ ...m, opened: new Map(m.opened).set(key, { depth, error: error instanceof Error ? error.message : String(error), lines: had?.depth === depth ? had.lines : [], total: had?.total ?? 2 ** depth }) });
    } finally {
      reading.delete(key);
    }
  };
  const readMessage = async (i: number) => {
    try {
      const page = await readMessages(i + 1, 1);
      const found = page.entries.find((e) => e.i === i);
      set({ ...m, messages: new Map(m.messages).set(i, found ?? "error") });
    } catch {
      set({ ...m, messages: new Map(m.messages).set(i, "error") });
    }
  };

  return {
    get: () => m,
    subscribe: (f: () => void) => {
      subscribers.add(f);
      return () => {
        subscribers.delete(f);
      };
    },
    // a screen shows the view: read it the first time, and keep it live from then on
    show: () => {
      active++;
      if (m.rev === null && waiting === null) void load();
      return () => {
        active--;
      };
    },
    // the reader asks for older lines
    earlier: () => {
      if (m.want <= 0) return;
      set({ ...m, want: Math.max(0, m.want - MEMORY_PAGE) });
      void fill();
    },
    // read again after an error
    retry: () => {
      set({ ...m, error: null });
      void (m.rev === null ? load() : fill());
    },
    // open or close a line in place; opened for the first time, what is under it is read
    toggle: (line: MemoryLine, open: boolean) => {
      set({ ...m, choices: new Map(m.choices).set(nodeKey(line), open) });
      if (open) void ensure(line);
    },
    // what a line shows open, read when it shows open the first time (also when open by default)
    ensure: async (line: MemoryLine) => ensure(line),
    // a node opened down to its messages, the next page of them
    more: async (line: MemoryLine) => readOpened(line, line.l),
    // down to its messages (`all`), or one level: its two halves
    deepen: async (line: MemoryLine, all: boolean) => readOpened(line, all ? line.l : 1),
    dispose: () => {
      unlisten();
      unstatus();
    },
  };

  async function ensure(line: MemoryLine) {
    if (line.l > 0) {
      const had = m.opened.get(nodeKey(line));
      if (had === undefined || (had.error !== null && had.lines.length === 0)) await readOpened(line, 1);
    } else if (line.entry === undefined) {
      const had = m.messages.get(line.id);
      if (had === undefined || had === "error") await readMessage(line.id);
    }
  }
}
export type MemoryStore = ReturnType<typeof makeMemory>;
