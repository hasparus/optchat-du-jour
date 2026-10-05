// The log and the summary tree in memory (gist §2, §3): plain data, no I/O.
import type { Kind, Msg, Node } from "./records.ts";
import { NODE, VIEW } from "./config.ts";

export type Coord = { readonly i: number; readonly l: number; }; // covers [i·2^l, (i+1)·2^l)
export type Entry = Msg & { readonly size: number };
export type Built = Node & { readonly size: number };

export type Mem = {
  readonly budget: number;
  readonly listeners: Set<() => void>; // told after every change of the view
  readonly root: Entry[]; // every message, by id
  readonly tree: Map<string, Built>; // built nodes; a node never changes once built
  view: Coord[]; // the parts, oldest first (view.ts)
};

export const newMem = (budget = VIEW): Mem => ({ budget, listeners: new Set(), root: [], tree: new Map(), view: [] });

const encoder = new TextEncoder();
export const bytes = (s: string) => encoder.encode(s).length;
export const msgText = (m: { readonly kind: Kind; readonly text: string }) => `${m.kind}: ${m.text}`;

export const key = (l: number, i: number) => `${l}:${i}`;
export const getNode = (mem: Mem, l: number, i: number) => mem.tree.get(key(l, i));
export const built = (mem: Mem, l: number, i: number) => mem.tree.has(key(l, i));
export function setNode(mem: Mem, n: Node) {
  if (!built(mem, n.l, n.i)) mem.tree.set(key(n.l, n.i), { ...n, size: bytes(n.text) });
}

// addressing (gist §3): node (l, i) is "id+n", its first message and how many it covers
export const span = (c: Coord) => ({ id: c.i * 2 ** c.l, n: 2 ** c.l });
export const label = (c: Coord) => `${span(c).id}+${span(c).n}`;

// the node's sources exist: its message, or both its children
export const ready = (mem: Mem, l: number, i: number) =>
  l === 0 ? i < mem.root.length : built(mem, l - 1, 2 * i) && built(mem, l - 1, 2 * i + 1);

// a source that fits in NODE is the node itself, no model call (gist §3 "Free nodes"); requires ready()
export function freeText(mem: Mem, l: number, i: number): string | null {
  const text = l === 0 ? msgText(entry(mem, i)) : `${node(mem, l - 1, 2 * i).text}\n${node(mem, l - 1, 2 * i + 1).text}`;
  return bytes(text) <= NODE ? text : null;
}

export function entry(mem: Mem, i: number): Entry {
  const m = mem.root[i];
  if (!m) throw new Error(`no message ${i}`);
  return m;
}

export function node(mem: Mem, l: number, i: number): Built {
  const n = getNode(mem, l, i);
  if (!n) throw new Error(`node ${label({ i, l })} is not built`);
  return n;
}

const two = (n: number) => String(n).padStart(2, "0");
export const dayOf = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; // local day
export const localTime = (iso: string) => {
  const d = new Date(iso);
  return `${dayOf(d)} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
