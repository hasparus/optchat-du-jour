// The memory in RAM (gist §1, §3): the log, the built tree nodes and the view's coordinates.
// No I/O here; store.ts fills it, view.ts keeps the view, the pump adds nodes.
import { NODE, VIEW } from "./config.ts";
import type { Msg, Node } from "./records.ts";

// node (l, i) covers the messages [i·2^l, (i+1)·2^l)
export type Coord = { readonly l: number; readonly i: number };
// a logged message; size = bytes of "kind: text" (gist §2)
export type Entry = Msg & { readonly size: number };
// a built node; size = bytes of its text
export type Built = Node & { readonly size: number };

export type Mem = {
  readonly root: Entry[];
  readonly tree: Map<string, Built>;
  // reassigned by view.ts on every change, never edited in place
  view: readonly Coord[];
  readonly budget: number;
  // called after every change of the view (settle, idle priming)
  readonly listeners: Set<() => void>;
};

export const newMem = (budget = VIEW): Mem => ({ budget, listeners: new Set(), root: [], tree: new Map(), view: [] });

export const bytes = (s: string) => Buffer.byteLength(s, "utf8");
export const msgText = (m: { readonly kind: string; readonly text: string }) => `${m.kind}: ${m.text}`;

const key = (l: number, i: number) => `${l}:${i}`;
export const getNode = (mem: Mem, l: number, i: number) => mem.tree.get(key(l, i));
export const built = (mem: Mem, l: number, i: number) => mem.tree.has(key(l, i));

// the first record of a node is the node; a later one for the same (l, i) changes nothing
export function setNode(mem: Mem, n: Node) {
  const k = key(n.l, n.i);
  if (!mem.tree.has(k)) mem.tree.set(k, { i: n.i, l: n.l, size: bytes(n.text), text: n.text });
}

// the id+n name of a node (gist §3 "Addressing")
export const span = (c: Coord) => ({ id: c.i * 2 ** c.l, n: 2 ** c.l });
export const label = (c: Coord) => {
  const { id, n } = span(c);
  return `${id}+${n}`;
};

// every node over a full pair of messages in a chat of T: level 0 first, each level oldest first
export function* nodes(T: number): Generator<Coord> {
  for (let l = 0; 2 ** l <= T; l++) for (let i = 0; (i + 1) * 2 ** l <= T; i++) yield { i, l };
}

export function entry(mem: Mem, i: number): Entry {
  const m = mem.root[i];
  if (!m) throw new Error(`no message ${i} in a chat of ${mem.root.length}`);
  return m;
}

export function node(mem: Mem, l: number, i: number): Built {
  const n = getNode(mem, l, i);
  if (!n) throw new Error(`node ${label({ i, l })} is not built`);
  return n;
}

// what a node is made from exists: its message, or both its children
export const ready = (mem: Mem, l: number, i: number) =>
  l === 0 ? i < mem.root.length : built(mem, l - 1, 2 * i) && built(mem, l - 1, 2 * i + 1);

// gist §3 "Free nodes": a source that already fits in NODE bytes is the node itself
export function freeText(mem: Mem, l: number, i: number): string | null {
  const text = l === 0 ? msgText(entry(mem, i)) : `${node(mem, l - 1, 2 * i).text}\n${node(mem, l - 1, 2 * i + 1).text}`;
  return bytes(text) <= NODE ? text : null;
}

const pad = (n: number) => String(n).padStart(2, "0");
// the local calendar day of a date, YYYY-MM-DD: the day file a record goes to
export const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// local "YYYY-MM-DD HH:MM" of an ISO time: what date(id) answers (gist §7.1)
export function localTime(iso: string) {
  const d = new Date(iso);
  return `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
