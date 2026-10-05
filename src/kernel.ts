// The calls into the Bend fold kernel (kernel/kernel.bend, E14). The kernel sees sizes only:
// this file turns the memory into its inputs and its answers back into coordinates.
import kernel, { type List, type Msg, type Part } from "../kernel/kernel.mjs";
import { built, bytes, type Coord, getNode, type Mem } from "./tree.ts";

export const PLACEHOLDER = "(not summarized yet: zoom it)"; // display and fail-safe only, no call ever sees it
const PLACEHOLDER_SIZE = bytes(PLACEHOLDER);

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

export const partSize = (mem: Mem, c: Coord) => getNode(mem, c.l, c.i)?.size ?? PLACEHOLDER_SIZE;

const part = (mem: Mem, c: Coord): Part => ({
  $: "Part",
  built: built(mem, c.l, c.i),
  i: c.i,
  l: c.l,
  size: partSize(mem, c),
  ups: list(ups(mem, c.l, c.i)),
});
const parts = (mem: Mem) => list(mem.view.map((c) => part(mem, c)));
const coords = (ps: List<Part>): Coord[] => array(ps).map((p) => ({ i: Number(p.i), l: Number(p.l) }));
const msg = (mem: Mem, i: number): Msg => {
  const p = part(mem, { i, l: 0 });
  return { $: "Msg", built: p.built, size: p.size, ups: p.ups };
};

// merge the most due built pairs while over budget (gist §5.2), T messages
export const fit = (mem: Mem) => coords(kernel.fit(mem.root.length, mem.budget, parts(mem)));

// message T - 1 just arrived: its line goes at the end, then fit
export const append = (mem: Mem) => {
  const T = mem.root.length - 1;
  return coords(kernel.append(T, mem.budget, parts(mem), msg(mem, T)));
};

// the view folded again from message 0 against today's tree (gist §5.2 "At load")
export const refold = (mem: Mem) =>
  coords(kernel.refold(mem.budget, list(mem.root.map((m) => msg(mem, m.i)))));

// the first message whose view line is unbuilt, else T (gist §4.1)
export const first = (mem: Mem) => Number(kernel.first(mem.root.length, parts(mem)));

// the nodes rule 3 lets the pump start, in its order: level by level, oldest first (gist §4.1)
export function offers(mem: Mem): Coord[] {
  const levels: boolean[][] = [], T = mem.root.length;
  for (let l = 0; 2 ** l <= T; l++) {
    const row: boolean[] = [];
    for (let i = 0; (i + 1) * 2 ** l <= T; i++) row.push(built(mem, l, i));
    levels.push(row);
  }
  const found = array(kernel.offers(list(levels.map(list)), first(mem)));
  return found.toReversed().map((c) => ({ i: Number(c.i), l: Number(c.l) }));
}

// the node named id+n in a chat of T messages, or null (gist §7.1); integers only
export function address(id: number, n: number, T: number): Coord | null {
  if (!Number.isSafeInteger(id) || !Number.isSafeInteger(n) || id < 0 || n < 1) return null;
  const c = kernel.coords(id, n, T);
  return c.$ === "Some" ? { i: Number(c.value.i), l: Number(c.value.l) } : null;
}
