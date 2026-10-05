// The calls into the Bend fold kernel (kernel/kernel.bend, E14). The kernel sees sizes only:
// this file turns the memory into its inputs and its answers back into coordinates. It holds no
// text either: an unbuilt line's size (the placeholder's, which view.ts owns) is a parameter.
import kernel, { type List, type Msg, type Part } from "../kernel/kernel.mjs";
import { built, type Coord, getNode, type Mem, nodes } from "./tree.ts";

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
const parts = (mem: Mem, hole: number) => list(mem.view.map((c) => part(mem, c, hole)));
const coords = (ps: List<Part>): Coord[] => array(ps).map((p) => ({ i: Number(p.i), l: Number(p.l) }));
const msg = (mem: Mem, i: number, hole: number): Msg => {
  const p = part(mem, { i, l: 0 }, hole);
  return { $: "Msg", built: p.built, size: p.size, ups: p.ups };
};

// gist §5.2's fit: as long as the view is over budget, the most due built pair becomes its parent
export const fit = (mem: Mem, hole: number) => coords(kernel.fit(mem.root.length, mem.budget, parts(mem, hole)));

// message T - 1 just arrived: its line goes at the end, then fit
export const append = (mem: Mem, hole: number) => {
  const T = mem.root.length - 1;
  return coords(kernel.append(T, mem.budget, parts(mem, hole), msg(mem, T, hole)));
};

// at load (gist §5.2): the view built up again from message 0, with the tree as it is today
export const refold = (mem: Mem, hole: number) =>
  coords(kernel.refold(mem.budget, list(mem.root.map((m) => msg(mem, m.i, hole)))));

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

// the node named id+n in a chat of T messages, or null (gist §7.1); integers only
export function address(id: number, n: number, count: number): Coord | null {
  const whole = [id, n].every((x) => Number.isSafeInteger(x));
  if (!whole || id < 0 || n < 1) return null;
  const c = kernel.coords(id, n, count);
  return c.$ === "Some" ? { i: Number(c.value.i), l: Number(c.value.l) } : null;
}
