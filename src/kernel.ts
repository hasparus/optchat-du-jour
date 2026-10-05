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
  const out: T[] = [];
  for (let at = xs; at.$ === "Con"; at = at.tail) out.push(at.head);
  return out;
}

// the sizes of the built nodes above (l, i), nearest first, up to the first unbuilt one
function ups(mem: Mem, l: number, i: number): number[] {
  const out: number[] = [];
  for (let j = i >> 1, up = l + 1; ; up++, j >>= 1) {
    const n = getNode(mem, up, j);
    if (!n) return out;
    out.push(n.size);
  }
}

// `hole` is the size an unbuilt line counts with
const part = (mem: Mem, c: Coord, hole: number): Part => ({
  $: "Part",
  built: built(mem, c.l, c.i),
  i: c.i,
  l: c.l,
  size: getNode(mem, c.l, c.i)?.size ?? hole,
  ups: list(ups(mem, c.l, c.i)),
});
const parts = (mem: Mem, hole: number) => list(mem.view.map((c) => part(mem, c, hole)));
const coords = (ps: List<Part>): Coord[] => array(ps).map((p) => ({ i: Number(p.i), l: Number(p.l) }));
const msg = (mem: Mem, i: number, hole: number): Msg => {
  const p = part(mem, { i, l: 0 }, hole);
  return { $: "Msg", built: p.built, size: p.size, ups: p.ups };
};

// merge the most due built pairs while over budget (gist §5.2), T messages
export const fit = (mem: Mem, hole: number) => coords(kernel.fit(mem.root.length, mem.budget, parts(mem, hole)));

// message T - 1 just arrived: its line goes at the end, then fit
export const append = (mem: Mem, hole: number) => {
  const T = mem.root.length - 1;
  return coords(kernel.append(T, mem.budget, parts(mem, hole), msg(mem, T, hole)));
};

// the view folded again from message 0 against today's tree (gist §5.2 "At load")
export const refold = (mem: Mem, hole: number) =>
  coords(kernel.refold(mem.budget, list(mem.root.map((m) => msg(mem, m.i, hole)))));

// the first message whose view line is unbuilt, else T (gist §4.1). It reads only where each
// line starts and whether it is built, so the lines go without sizes or ancestors.
export function first(mem: Mem) {
  const ps = mem.view.map((c): Part => ({ $: "Part", built: built(mem, c.l, c.i), i: c.i, l: c.l, size: 0, ups: nil }));
  return Number(kernel.first(mem.root.length, list(ps)));
}

// the nodes rule 3 lets the pump start, in its order: level by level, oldest first (gist §4.1)
export function offers(mem: Mem): Coord[] {
  const levels: boolean[][] = [];
  for (const c of nodes(mem.root.length)) (levels[c.l] ??= []).push(built(mem, c.l, c.i));
  const found = array(kernel.offers(list(levels.map(list)), first(mem)));
  return found.toReversed().map((c) => ({ i: Number(c.i), l: Number(c.l) }));
}

// the node named id+n in a chat of T messages, or null (gist §7.1); integers only
export function address(id: number, n: number, T: number): Coord | null {
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(n) || id < 0 || n < 1) return null;
  const c = kernel.coords(id, n, T);
  return c.$ === "Some" ? { i: Number(c.value.i), l: Number(c.value.l) } : null;
}
