// The calls into the Bend fold kernel (kernel/kernel.bend, E14). The kernel sees sizes only:
// this file turns the memory into its inputs and its answers back into coordinates. It holds no
// text either: an unbuilt line's size (the placeholder's, which view.ts owns) is a parameter.
import kernel, { type List, type Msg, type Part, type Saw as Sawed } from "../kernel/kernel.mjs";
import { built, type Coord, getNode, type Marks, type Mem, nodes, type Saw } from "./tree.ts";

const nil: List<never> = { $: "Nil" };
function list<T>(xs: readonly T[]): List<T> {
  let out: List<T> = nil;
  for (const head of xs.toReversed()) out = { $: "Con", head, tail: out };
  return out;
}
function array<T>(xs: List<T>): T[] {
  const items: T[] = [];
  let at = xs;
  while (at.$ === "Con") {
    items.push(at.head);
    at = at.tail;
  }
  return items;
}

// the sizes of the built nodes above c, its parent first, up to the first one not built
const parent = (c: Coord): Coord => ({ i: Math.floor(c.i / 2), l: c.l + 1 });
function ups(mem: Mem, c: Coord): number[] {
  const sizes: number[] = [];
  let up = parent(c);
  for (let n = getNode(mem, up); n; n = getNode(mem, up)) {
    sizes.push(n.size);
    up = parent(up);
  }
  return sizes;
}

// `hole` is the size an unbuilt line counts with
const part = (mem: Mem, c: Coord, hole: number): Part => ({
  $: "Part",
  built: built(mem, c),
  i: c.i,
  l: c.l,
  size: getNode(mem, c)?.size ?? hole,
  ups: list(ups(mem, c)),
});
const parts = (mem: Mem, view: readonly Coord[], hole: number) => list(view.map((c) => part(mem, c, hole)));
const coords = (ps: List<Part>): Coord[] => array(ps).map((p) => ({ i: Number(p.i), l: Number(p.l) }));
const sawOf = (r: Sawed): Saw => ({ folding: r.folding, view: coords(r.ps) });
const msg = (mem: Mem, i: number, hole: number): Msg => {
  const p = part(mem, { i, l: 0 }, hole);
  return { $: "Msg", built: p.built, size: p.size, ups: p.ups };
};

// One batch's merges (gist 2026-10-08 §3.2): as long as `view` is over `budget`, its most due
// built pair becomes its parent
export const fit = (mem: Mem, view: readonly Coord[], budget: number, hole: number) =>
  coords(kernel.fit(mem.root.length, budget, parts(mem, view, hole)));

// Message `i` (the newest, unless a saved view is catching up) arrives: its line goes at the end of
// `at`'s view, then the sawtooth at `marks`. Only past `marks.high`, or with a batch owed, does
// anything merge: in between the view only grows at its end (gist §3.3).
export const append = (mem: Mem, at: Saw, marks: Marks, hole: number, i = mem.root.length - 1) =>
  sawOf(kernel.append(i, marks.high, marks.low, at.folding, parts(mem, at.view, hole), msg(mem, i, hole)));

// the view rebuilt from message 0 with the tree as it is today: for a data dir with no saved
// view, or a damaged one (gist §3.2: never otherwise, since a rebuilt view differs from the live one)
export const refold = (mem: Mem, marks: Marks, hole: number) =>
  sawOf(kernel.refold(marks.high, marks.low, list(mem.root.map((m) => msg(mem, m.i, hole)))));

// a view line as kernel.first reads it: where it starts and whether it is built. first never
// looks at a line's size or ancestors, so they stay empty instead of being looked up.
const bare = (mem: Mem, c: Coord): Part => ({ $: "Part", built: built(mem, c), i: c.i, l: c.l, size: 0, ups: nil });

// the first message whose view line is unbuilt, else T (gist §4.1)
export const first = (mem: Mem): number =>
  Number(kernel.first(mem.root.length, list(mem.view.map((c) => bare(mem, c)))));

// the nodes rule 3 lets the pump start, in its order: level by level, oldest first (gist §4.1)
export function offers(mem: Mem): Coord[] {
  const levels: boolean[][] = [];
  for (const c of nodes(mem.root.length)) (levels[c.l] ??= []).push(built(mem, c));
  const found = array(kernel.offers(list(levels.map(list)), first(mem)));
  return found.toReversed().map((c) => ({ i: Number(c.i), l: Number(c.l) }));
}

// the node named id+n in a chat of T messages, or null (gist §7.1); integers only. A node past
// the end is no node, and is never handed to the kernel (its Nats stop at 2^48).
export function address(id: number, n: number, count: number): Coord | null {
  const whole = [id, n].every((x) => Number.isSafeInteger(x));
  if (!whole || id < 0 || n < 1 || id + n > count) return null;
  const c = kernel.coords(id, n, count);
  return c.$ === "Some" ? { i: Number(c.value.i), l: Number(c.value.l) } : null;
}
