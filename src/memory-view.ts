// The memory view as clients read it (E46, E47; SPEC "Web UI", Memory): the view's lines, each a
// node of the tree with its summary, a page at a time; a node opened in place, its descendants a
// level or more down, a page at a time; and what changed in the view's lines since a client last
// looked, as hunks small enough for one frame. Pure: the server's feed (server/memory-feed.ts)
// keeps the count of changes and sends them, the routes (server/routes/memory.ts) answer the reads.
import { MEMORY_BYTES, NODE } from "./config.ts";
import { built, bytes, type Coord, end, getNode, localTime, type Mem, msgText } from "./tree.ts";
import { MEMORY_PAGE_LINES, type MemoryChange, type MemoryChildren, type MemoryHunk, type MemoryLine, type MemoryPage, span, type ViewLine } from "./wire.ts";
import { PLACEHOLDER } from "./view.ts";

// Node c as a line: its summary and its span, and at level 0 its message's kind and, when the
// message is its own summary (it fits in NODE: a free node), the message. Optional keys are left
// out, never undefined (the /api JSON codec would write those as null).
export function memoryLine(mem: Mem, c: Coord): MemoryLine {
  const node = getNode(mem, c);
  const { id, n } = span(c);
  const first = mem.root[id], last = mem.root[id + n - 1];
  const line: MemoryLine = {
    built: node !== undefined,
    from: first?.date ?? null,
    i: c.i,
    id,
    l: c.l,
    n,
    size: node?.size ?? null,
    text: node?.text ?? null,
    to: last?.date ?? null,
  };
  const clipped = node?.clipped === true ? { ...line, clipped: true } : line;
  if (c.l !== 0 || first === undefined) return clipped;
  const kinded = { ...clipped, kind: first.kind };
  return bytes(msgText(first)) <= NODE ? { ...kinded, entry: first } : kinded;
}

const same = (a: Coord, b: Coord) => a.l === b.l && a.i === b.i;

// Where the view's lines changed, from `before` (with whether each line was built then) to `after`:
// spans of the old list each replaced by new lines, at their places in the old list, oldest first.
// Both tile the log from message 0 (the new one maybe further, by messages appended), so the walk
// goes line by line while they agree, and where they don't, takes from both until their ends
// meet: lines merged by a batch, or a message's line appended. A line in both whose summary was
// written since is replaced by itself.
export type Hunk = { readonly at: number; readonly removed: number; readonly added: readonly Coord[] };
export function viewHunks(before: readonly Coord[], wasBuilt: readonly boolean[], after: readonly Coord[], isBuilt: (c: Coord) => boolean): Hunk[] {
  const out: Hunk[] = [];
  const push = (h: Hunk) => {
    const last = out.at(-1);
    if (last !== undefined && last.at + last.removed === h.at) out[out.length - 1] = { added: [...last.added, ...h.added], at: last.at, removed: last.removed + h.removed };
    else out.push(h);
  };
  let a = 0, b = 0;
  while (a < before.length || b < after.length) {
    const x = before[a], y = after[b];
    if (x !== undefined && y !== undefined && same(x, y)) {
      if ((wasBuilt[a] ?? false) !== isBuilt(y)) push({ added: [y], at: a, removed: 1 });
      a++;
      b++;
      continue;
    }
    // Here both lists start at the same message: take a line from the one that ends sooner until
    // they end at the same message again. The old one may run out first: it ended where the new
    // one goes on, with the messages appended since.
    const at = a, added: Coord[] = [];
    let endA = 0, endB = 0;
    do {
      const old = before[a], next = after[b];
      if (next !== undefined && (endB <= endA || old === undefined)) {
        added.push(next);
        endB = end(next);
        b++;
      } else if (old === undefined) break;
      else {
        endA = end(old);
        a++;
      }
    } while (endA !== endB);
    push({ added, at, removed: a - at });
  }
  return out;
}

// A line of /api/view (the REPL's `view`): the same line, its dates in local time and the
// placeholder for a summary not written yet
export function viewLine(mem: Mem, c: Coord): ViewLine {
  const line = memoryLine(mem, c);
  return {
    built: line.built,
    from: line.from === null ? null : localTime(line.from),
    i: line.i,
    id: line.id,
    l: line.l,
    n: line.n,
    size: line.size,
    text: line.text ?? PLACEHOLDER,
    to: line.to === null ? null : localTime(line.to),
  };
}

const frameBytes = (value: MemoryChange) => bytes(JSON.stringify({ name: "memory", type: "CUSTOM", value }));

// Where the changes are counted: the server's run (`boot`, a random id) and its last change
export type Counted = { readonly boot: string; readonly rev: number };

// Change `rev` as one frame of at most `cap` bytes: the hunks moved to where each applies after
// the ones before it, each with its new lines while they fit, the rest with their count only. Hunks
// so many that their counts alone don't fit are one hunk instead, the whole list replaced, which
// a client reads again: the frame's size is bounded whatever the change.
export function memoryChange(mem: Mem, at: Counted, hunks: readonly Hunk[], cap: number = MEMORY_BYTES): MemoryChange {
  let shift = 0;
  const bare: MemoryHunk[] = hunks.map((h) => {
    const where = h.at + shift;
    shift += h.added.length - h.removed;
    return { added: h.added.length, at: where, removed: h.removed };
  });
  const total = mem.view.length;
  const change: MemoryChange = { boot: at.boot, hunks: bare, rev: at.rev, total };
  if (frameBytes(change) > cap) return { ...change, hunks: [{ added: total, at: 0, removed: total - shift }] };
  let room = cap - frameBytes(change);
  const hunksWithLines = bare.map((h, k) => {
    const lines = (hunks[k]?.added ?? []).map((c) => memoryLine(mem, c));
    if (lines.length === 0) return h;
    const more = bytes(JSON.stringify(lines)) + bytes(',"lines":');
    if (more > room) return h;
    room -= more;
    return { ...h, lines };
  });
  return { ...change, hunks: hunksWithLines };
}

// The view's lines before index `before` (all of them: the newest), `limit` at most, as of change
// `at` (the route bounds `limit`)
export function viewPage(mem: Mem, at: Counted, before: number = mem.view.length, limit: number = MEMORY_PAGE_LINES): MemoryPage {
  const to = Math.min(before, mem.view.length);
  const from = Math.max(0, to - limit);
  return { boot: at.boot, from, lines: mem.view.slice(from, to).map((c) => memoryLine(mem, c)), rev: at.rev, total: mem.view.length };
}

// Node c opened `depth` levels down: its 2^depth descendants from the `from`-th, `limit` at most.
// Null when there is no such node yet (it runs past the log) or it is not that deep.
export function childrenPage(mem: Mem, c: Coord, depth: number, from = 0, limit: number = MEMORY_PAGE_LINES): MemoryChildren | null {
  if (depth < 1 || depth > c.l || end(c) > mem.root.length) return null;
  const total = 2 ** depth;
  const l = c.l - depth;
  const first = c.i * total;
  const lines: MemoryLine[] = [];
  for (let k = from; k < Math.min(total, from + limit); k++) lines.push(memoryLine(mem, { i: first + k, l }));
  return { depth, from, i: c.i, l: c.l, lines, total };
}

// The view's lines as a client last saw them: which nodes, and whether each was built
export type Shown = { readonly view: readonly Coord[]; readonly built: readonly boolean[] };
export const shownOf = (mem: Mem): Shown => ({ built: mem.view.map((c) => built(mem, c)), view: mem.view });

// What changed since `shown`: hunks, and the lines as they are now. The view is reassigned on every
// change of its lines (view.ts), never edited in place; when it is the same list, only a summary
// can have been written since, so only the lines unbuilt before are looked at.
export type Changes = { readonly hunks: Hunk[]; readonly shown: Shown };
export function changesSince(mem: Mem, shown: Shown): Changes {
  if (mem.view !== shown.view) {
    const now = shownOf(mem);
    return { hunks: viewHunks(shown.view, shown.built, now.view, (c) => built(mem, c)), shown: now };
  }
  const hunks: Hunk[] = [];
  let flags: boolean[] | null = null;
  for (const [k, was] of shown.built.entries()) {
    const c = shown.view[k];
    if (was || c === undefined || !built(mem, c)) continue;
    hunks.push({ added: [c], at: k, removed: 1 });
    flags ??= [...shown.built];
    flags[k] = true;
  }
  return { hunks, shown: flags === null ? shown : { built: flags, view: shown.view } };
}
