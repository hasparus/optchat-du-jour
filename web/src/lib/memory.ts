// The memory view as this page holds it (E46, E47; SPEC "Web UI", Memory): the view's lines, read a
// page at a time from /api/memory/view and kept live by the CUSTOM `memory` frames, which say where
// lines changed (a message's line appended, lines a batch merged, a summary written into a line),
// numbered one after the other within the server's run (`boot`). A frame this page can't follow on
// from (one missed, another run) or a socket that came back reads the view again, from the lines
// the reader had gone up to. What the reader opened, the halves of a summary and the messages under
// its lines, is read when first opened and kept: a written node never changes. The chat's Memory
// mode and the Memory screen draw the same store (../memory/memory-view.tsx).
import { EventType } from "@ag-ui/core";
import { MEMORY_MAX_LINES, MEMORY_PAGE_LINES, type MemoryChange, type MemoryLine, type MemoryPage, type Msg } from "@wire";
import { api } from "./api.ts";
import type { Link, LinkStatus } from "./connection.ts";
import { entryRows, type Row } from "./rows.ts";

// A node opened in place: its descendants `depth` levels down (2^depth of them), as far as read
export type Opened = { readonly depth: number; readonly total: number; readonly lines: readonly (MemoryLine | null)[]; readonly error: string | null };

export type Memory = {
  // the server's run and the change the lines are as of; null until the first page is in
  readonly boot: string | null;
  readonly rev: number | null;
  // every line of the view, null where not read yet
  readonly lines: readonly (MemoryLine | null)[];
  // the first line the reader wants to see: those below it are neither read nor shown
  readonly want: number;
  // after a re-read, the message the reader's first line held, until a line read again holds it:
  // a batch that merged meanwhile moves lines, so the place goes by message, not by index
  readonly anchor: number | null;
  // why the last read failed (it is tried again by itself, and on the reader's ask)
  readonly error: string | null;
  // open or closed, as the reader chose, by node (`l:i`); the rest are as defaultOpen says
  readonly choices: ReadonlyMap<string, boolean>;
  readonly opened: ReadonlyMap<string, Opened>;
  // the message under a level-0 line that isn't its own summary, read when the line opens
  readonly messages: ReadonlyMap<number, Msg | "error">;
};

export const emptyMemory: Memory = { anchor: null, boot: null, choices: new Map(), error: null, lines: [], messages: new Map(), opened: new Map(), rev: null, want: 0 };

export const nodeKey = (line: Pick<MemoryLine, "l" | "i">) => `${line.l}:${line.i}`;

// A message summarized at level 0 that was said in the conversation, yours or a reply, reads
// whole until the reader closes it, as the log shows it (UniiChat opens these too); its summary is
// a tap away. Everything else shows its summary: what the model reads.
export const defaultOpen = (line: MemoryLine) => line.l === 0 && line.entry === undefined && (line.kind === "user" || line.kind === "talk");
export const isOpen = (m: Memory, line: MemoryLine) => m.choices.get(nodeKey(line)) ?? defaultOpen(line);

// Change `c` applied to `m`: "gap" when it doesn't follow on from what `m` is as of (a change was
// missed, or it is another run's: read again), `m` itself when it is one `m` has already
export function applyChange(m: Memory, c: MemoryChange): Memory | "gap" {
  if (m.rev === null) return m;
  if (c.boot !== m.boot) return "gap";
  if (c.rev <= m.rev) return m;
  if (c.rev !== m.rev + 1) return "gap";
  let { lines, want } = m;
  for (const h of c.hunks) {
    // the whole list replaced, its lines left to be read (a change too big for a frame): read the
    // view again, which keeps the reader's place, rather than every line from the first
    if (h.lines === undefined && h.at === 0 && h.removed > 0 && h.removed === lines.length) return "gap";
    lines = lines.toSpliced(h.at, h.removed, ...(h.lines ?? Array.from({ length: h.added }, () => null)));
    // lines that were wholly below the reader's first one move it; new lines put right at it (an
    // append to a view the reader has whole) are shown, as is anything that replaced it
    if (h.at < want && h.at + h.removed <= want) want += h.added - h.removed;
    else if (h.at < want) want = h.at;
  }
  if (lines.length !== c.total) return "gap";
  return { ...m, lines, rev: c.rev, want: Math.max(0, Math.min(want, lines.length)) };
}

// A page read from /api/memory/view, kept only when it is as of the change `m` is, in the same run,
// over as many lines (else null: read it again once the changes in between are in)
export function applyPage(m: Memory, page: MemoryPage): Memory | null {
  if (page.boot !== m.boot || page.rev !== m.rev || page.total !== m.lines.length) return null;
  const lines = [...m.lines];
  for (const [k, line] of page.lines.entries()) lines[page.from + k] = line;
  return anchored({ ...m, lines });
}

// The reader's place after a re-read (`anchor`): the read line whose messages hold it becomes the
// first one shown; while the line at `want` is read and starts after it, the place is higher up,
// so a page more is wanted. Done once found, or at the view's first line.
export function anchored(m: Memory): Memory {
  const { anchor } = m;
  if (anchor === null) return m;
  const at = m.lines.findIndex((l) => l !== null && l.id <= anchor && anchor < l.id + l.n);
  if (at !== -1) return { ...m, anchor: null, want: at };
  const first = m.lines[m.want];
  if (m.want === 0) return { ...m, anchor: null };
  if (first !== null && first !== undefined && first.id > anchor) return { ...m, want: Math.max(0, m.want - MEMORY_PAGE_LINES) };
  return m;
}

// A first page: the view's newest lines, the rest read as the reader goes up. Read again (a gap, a
// socket back), the reader keeps their place: as far up as they had gone, at most the whole view,
// is read again, and what they opened stays open.
export function firstPage(m: Memory, page: MemoryPage): Memory {
  const want = m.boot === null ? page.from : Math.max(0, Math.min(m.want, page.from, page.total));
  // the message the reader's first line held (the first read line from it): their place
  const held = m.boot === null ? undefined : m.lines.slice(m.want).find((l) => l !== null);
  return anchored({
    ...m,
    anchor: held?.id ?? null,
    boot: page.boot,
    error: null,
    lines: Array.from({ length: page.total }, (_, k) => (k >= page.from ? (page.lines[k - page.from] ?? null) : null)),
    rev: page.rev,
    want,
  });
}

// The reads that fill what the reader wants to see and isn't read: `before` and `limit` of each,
// the newest first
export function unread(m: Memory): { readonly before: number; readonly limit: number }[] {
  const out: { before: number; limit: number }[] = [];
  for (let k = m.lines.length - 1; k >= m.want; k--) {
    if (m.lines[k] !== null) continue;
    const end = k + 1;
    while (k - 1 >= m.want && m.lines[k - 1] === null && end - k < MEMORY_MAX_LINES) k--;
    out.push({ before: end, limit: end - k });
  }
  return out;
}

// What the view shows from the line the reader wants on: runs of lines that are their own messages
// as the log's rows (a tool call and its output pair up as there), every other line as a summary
// block, and what isn't read yet as a gap
export type MemoryItem =
  // `followed`: the row is the last of a run that a summary block follows, so a tool call there
  // has its output in that block (its echo, summarized), not cut short
  | { readonly kind: "row"; readonly key: string; readonly row: Row; readonly followed: boolean }
  | { readonly kind: "line"; readonly key: string; readonly line: MemoryLine }
  | { readonly kind: "gap"; readonly key: string; readonly count: number };
export function memoryItems(lines: readonly (MemoryLine | null)[], from = 0): MemoryItem[] {
  const out: MemoryItem[] = [];
  let run: Msg[] = [];
  const flush = (followed = false) => {
    const rows = entryRows(run);
    for (const [k, row] of rows.entries()) out.push({ followed: followed && k === rows.length - 1, key: row.key, kind: "row", row });
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
      flush(true);
      out.push({ key: `m${nodeKey(line)}`, kind: "line", line });
    } else run.push(line.entry);
  }
  flush();
  return out;
}

// the consecutive runs of indexes in `ids`, each `most` long at most: one read of the log each
export function runsOf(ids: readonly number[], most: number = MEMORY_PAGE_LINES): { readonly first: number; readonly count: number }[] {
  const out: { first: number; count: number }[] = [];
  for (const i of [...new Set(ids)].toSorted((a, b) => a - b)) {
    const last = out.at(-1);
    if (last !== undefined && last.first + last.count === i && last.count < most) last.count++;
    else out.push({ count: 1, first: i });
  }
  return out;
}

export type MemoryOptions = {
  readonly view?: typeof api.memoryView;
  readonly children?: typeof api.memoryChildren;
  readonly messages?: (before: number, limit: number) => Promise<{ readonly entries: readonly Msg[] }>;
  // the first wait before a failed read is tried again, doubling up to RETRY_MOST
  readonly retryMs?: number;
};
const RETRY_MOST = 30_000;

// Where the store is: not shown yet (frames are dropped: the first read will be as of now); reading
// a first page (`round`, so a slower older read is dropped; frames held until it is in); or live
// (frames applied as they come; `filling` while it reads what the reader lacks)
type Phase = { readonly tag: "idle" } | { readonly tag: "loading"; readonly round: number; readonly held: MemoryChange[] } | { readonly tag: "live"; filling: boolean };

export function makeMemory(link: Pick<Link, "listen" | "onStatus" | "status">, options: MemoryOptions = {}) {
  const readView = options.view ?? api.memoryView;
  const readChildren = options.children ?? api.memoryChildren;
  const readMessages = options.messages ?? api.messages;
  const retryMs = options.retryMs ?? 1000;
  let m: Memory = emptyMemory;
  let phase: Phase = { tag: "idle" };
  let rounds = 0;
  let failures = 0; // failed reads in a row, for the next wait
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false; // nothing is read or scheduled after dispose(), a read in flight included
  const gone = () => disposed; // read anew after an await
  const subscribers = new Set<() => void>();
  const set = (next: Memory) => {
    if (next === m) return;
    m = next;
    for (const f of subscribers) f();
  };
  const later = (ms: number, then: () => void) => {
    if (gone()) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      then();
    }, ms);
  };
  const backoff = () => Math.min(RETRY_MOST, retryMs * 2 ** failures++);
  // the current state, read anew after an await (a frame may have come meanwhile)
  const now = () => m;

  const load = async (): Promise<void> => {
    if (gone()) return;
    const round = ++rounds;
    const held: MemoryChange[] = [];
    const loading = { held, round, tag: "loading" as const };
    phase = loading;
    try {
      const page = await readView(null, MEMORY_PAGE_LINES);
      if (phase !== loading || gone()) return; // a newer read took over, or the store is gone
      let next = firstPage(now(), page);
      for (const c of loading.held) {
        const after = applyChange(next, c);
        if (after === "gap") {
          await load();
          return;
        }
        next = after;
      }
      failures = 0;
      phase = { filling: false, tag: "live" };
      set(next);
      void fill();
    } catch (error) {
      if (phase !== loading || gone()) return;
      set({ ...now(), error: (error instanceof Error ? error.message : String(error)) });
      later(backoff(), () => void load());
    }
  };

  // what the reader wants to see and isn't read, a page at a time; a page as of an older change is
  // read again, one as of a newer one waits for the frames between; a failed read is tried again
  // after a wait that doubles, and at once on the reader's ask (`retry`)
  const fill = async (): Promise<void> => {
    if (gone() || phase.tag !== "live" || phase.filling) return;
    const live = phase;
    live.filling = true;
    try {
      for (let stale = 0; phase === live; ) {
        const next = unread(now())[0];
        if (next === undefined) break;
        const page = await readView(next.before, next.limit);
        if (phase !== live || gone()) return;
        const kept = applyPage(now(), page);
        if (kept !== null) {
          failures = 0;
          set(kept.error === null ? kept : { ...kept, error: null });
          continue;
        }
        if (page.boot !== now().boot) {
          void load(); // another run: read the view again
          return;
        }
        // as of a newer change: the frames between are on their way, and each fills again
        if (page.rev > (now().rev ?? 0)) break;
        // as of an older one: again, at once a few times, then after a wait
        if (++stale > 3) {
          later(backoff(), () => void fill());
          break;
        }
      }
    } catch (error) {
      // a fill a re-read took over from leaves the re-read's own retry alone
      if (phase !== live || gone()) return;
      set({ ...now(), error: (error instanceof Error ? error.message : String(error)) });
      later(backoff(), () => void fill());
    } finally {
      live.filling = false;
    }
  };

  const change = (c: MemoryChange) => {
    switch (phase.tag) {
      case "idle":
        return; // never read: the first read will be as of now
      case "loading":
        phase.held.push(c);
        return;
      case "live": {
        const next = applyChange(m, c);
        if (next === "gap") {
          void load();
          return;
        }
        set(next);
        if (unread(next).length > 0) void fill();
      }
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
    if (back && phase.tag !== "idle") void load();
  });

  // a node's descendants `depth` levels down, the next page of them (another depth starts over);
  // one read of a node at a time
  const reading = new Set<string>();
  const readOpened = async (line: MemoryLine, depth: number) => {
    const key = nodeKey(line);
    if (reading.has(key)) return;
    reading.add(key);
    const had = m.opened.get(key);
    const from = had?.depth === depth && had.error === null ? had.lines.length : 0;
    try {
      const page = await readChildren(line.l, line.i, depth, from, depth === 1 ? 2 : MEMORY_PAGE_LINES);
      const before = now().opened.get(key);
      const kept = before?.depth === depth ? before.lines.slice(0, page.from) : [];
      set({ ...now(), opened: new Map(now().opened).set(key, { depth, error: null, lines: [...kept, ...page.lines], total: page.total }) });
    } catch (error) {
      set({ ...now(), opened: new Map(now().opened).set(key, { depth, error: (error instanceof Error ? error.message : String(error)), lines: had?.depth === depth ? had.lines : [], total: had?.total ?? 2 ** depth }) });
    } finally {
      reading.delete(key);
    }
  };

  // The messages under the level-0 lines that show open: every line that asks in one turn (a page
  // drawn, a node opened down to its messages) is one read of the log per run of them, not one each
  const wanted = new Set<number>();
  const inFlight = new Set<number>();
  let flushing = false;
  const readWanted = async () => {
    flushing = false;
    const ids = [...wanted];
    wanted.clear();
    await Promise.all(
      runsOf(ids).map(async ({ count, first }) => {
        const run = Array.from({ length: count }, (_, k) => first + k);
        for (const i of run) inFlight.add(i);
        try {
          const page = await readMessages(first + count, count);
          const found = new Map(page.entries.map((e) => [e.i, e]));
          const messages = new Map(now().messages);
          for (const i of run) messages.set(i, found.get(i) ?? "error");
          set({ ...now(), messages });
        } catch {
          const messages = new Map(now().messages);
          for (const i of run) messages.set(i, "error");
          set({ ...now(), messages });
        } finally {
          for (const i of run) inFlight.delete(i);
        }
      }),
    );
  };
  const wantMessage = (i: number) => {
    const had = m.messages.get(i);
    if ((had !== undefined && had !== "error") || inFlight.has(i)) return;
    wanted.add(i);
    if (flushing) return;
    flushing = true;
    queueMicrotask(() => void readWanted());
  };

  const ensure = async (line: MemoryLine) => {
    if (line.l > 0) {
      const had = m.opened.get(nodeKey(line));
      if (had === undefined || (had.error !== null && had.lines.length === 0)) await readOpened(line, 1);
    } else if (line.entry === undefined) wantMessage(line.id);
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
      if (phase.tag === "idle") void load();
      return () => {
        // kept live while hidden: frames are cheap, and the view is there when shown again
      };
    },
    // the reader asks for older lines
    earlier: () => {
      if (m.want <= 0) return;
      set({ ...m, anchor: null, want: Math.max(0, m.want - MEMORY_PAGE_LINES) });
      void fill();
    },
    // read again now, after an error
    retry: () => {
      failures = 0;
      set({ ...m, error: null });
      void (phase.tag === "live" ? fill() : load());
    },
    // open or close a line in place; opened for the first time, what is under it is read
    toggle: (line: MemoryLine, open: boolean) => {
      set({ ...m, choices: new Map(m.choices).set(nodeKey(line), open) });
      if (open) void ensure(line);
    },
    // what a line shows open, read when it shows open the first time (also when open by default)
    ensure,
    // a node opened down to its messages, the next page of them
    more: async (line: MemoryLine) => readOpened(line, line.l),
    // down to its messages (`all`), or back to its two halves
    deepen: async (line: MemoryLine, all: boolean) => readOpened(line, all ? line.l : 1),
    dispose: () => {
      disposed = true;
      unlisten();
      unstatus();
      if (timer !== null) clearTimeout(timer);
    },
  };
}
export type MemoryStore = ReturnType<typeof makeMemory>;
