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

export const bytes = (text: string) => Buffer.byteLength(text);
export const msgText = (m: { readonly kind: string; readonly text: string }) => `${m.kind}: ${m.text}`;

// where node (l, i) sits in mem.tree
const slot = (l: number, i: number) => `${l}:${i}`;
export const getNode = (mem: Mem, l: number, i: number) => mem.tree.get(slot(l, i));
export const built = (mem: Mem, l: number, i: number) => getNode(mem, l, i) !== undefined;

// the first record of a node is the node; a later one for the same (l, i) changes nothing
export function setNode(mem: Mem, n: Node) {
  const k = slot(n.l, n.i);
  if (!mem.tree.has(k)) mem.tree.set(k, { i: n.i, l: n.l, size: bytes(n.text), text: n.text });
}

// the id+n address of a node (gist §3 "Addressing"): its first message and how many it covers
export function span({ l, i }: Coord) {
  const n = 2 ** l;
  return { id: i * n, n };
}
// its name in the view, "id+n"
export function label(c: Coord): string {
  const where = span(c);
  return `${where.id}+${where.n}`;
}
// one past the last message a node covers
export const end = (c: Coord) => span(c).id + span(c).n;
// the two nodes one level down that a merge is made from
export const children = ({ l, i }: Coord): readonly [Coord, Coord] => [
  { i: 2 * i, l: l - 1 },
  { i: 2 * i + 1, l: l - 1 },
];

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
export function ready(mem: Mem, c: Coord) {
  if (c.l > 0) return children(c).every((k) => built(mem, k.l, k.i));
  return c.i < mem.root.length;
}

// gist §3 "Free nodes": a node needs no model call when what it would summarize (its message as
// "kind: text", or its children's texts a line apart) is NODE bytes or less; that is its text
export function freeText(mem: Mem, c: Coord): string | null {
  const source = c.l > 0 ? children(c).map((k) => node(mem, k.l, k.i).text).join("\n") : msgText(entry(mem, c.i));
  return bytes(source) > NODE ? null : source;
}

const pad = (n: number) => String(n).padStart(2, "0");
// the local calendar day of a date, YYYY-MM-DD: the day file a record goes to
export const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// local "YYYY-MM-DD HH:MM" of an ISO time: what date(id) answers (gist §7.1)
export function localTime(iso: string) {
  const d = new Date(iso);
  return `${dayOf(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
