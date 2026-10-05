// What the chat holds in RAM (gist §1, §3): every logged message, the summaries built so far and
// the coordinates of the view. Pure data and lookups; store.ts fills it, view.ts keeps the view
// current and the pump adds nodes
import { NODE, VIEW } from "./config.ts";
import type { Msg, Node } from "./records.ts";
import { span } from "./wire.ts";

// node (l, i) stands for the 2^l messages that start at i·2^l
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

export function newMem(budget: number = VIEW): Mem {
  return { root: [], view: [], tree: new Map(), listeners: new Set(), budget };
}

export const bytes = (text: string) => Buffer.byteLength(text);
// what a message counts as everywhere: its kind, a colon and a space, its text
export const msgText = ({ kind, text }: { readonly kind: string; readonly text: string }) => [kind, text].join(": ");

// the key of a node in mem.tree
const key = (c: Coord) => `${c.l}:${c.i}`;
export function getNode(mem: Mem, c: Coord): Built | undefined {
  return mem.tree.get(key(c));
}
export function built(mem: Mem, c: Coord): boolean {
  return mem.tree.has(key(c));
}

// a node is whatever was recorded for it first: a later record for the same place is ignored
export function setNode(mem: Mem, record: Node) {
  if (built(mem, record)) return;
  mem.tree.set(key(record), { i: record.i, l: record.l, size: bytes(record.text), text: record.text });
}

// gist §3 "Addressing": a node is named by its first message and how many messages it spans
// (src/wire.ts, which the web UI shares)
export { span } from "./wire.ts";
// its name in the view, "id+n"
export function label(c: Coord): string {
  const where = span(c);
  return `${where.id}+${where.n}`;
}
// one past the last message a node covers
export function end(c: Coord) {
  const where = span(c);
  return where.id + where.n;
}
// the two nodes one level down that a merge is made from
export const children = ({ l, i }: Coord): readonly [Coord, Coord] => [
  { i: 2 * i, l: l - 1 },
  { i: 2 * i + 1, l: l - 1 },
];

// Every node that covers whole messages of a chat of T: all of level 0, then level 1, and so on,
// each level from its oldest node.
export function* nodes(T: number): Generator<Coord> {
  for (let l = 0, width = 1; width <= T; l++, width *= 2) {
    for (let i = 0, count = Math.floor(T / width); i < count; i++) yield { i, l };
  }
}

export function entry(mem: Mem, i: number): Entry {
  const found = mem.root[i];
  if (!found) throw new Error(`no message ${i}: the chat has ${mem.root.length}`);
  return found;
}

export function node(mem: Mem, c: Coord): Built {
  const found = getNode(mem, c);
  if (!found) throw new Error(`node ${label(c)} is not built`);
  return found;
}

// what a node is made from exists: its message, or both its children
export function ready(mem: Mem, c: Coord) {
  if (c.l === 0) return c.i < mem.root.length;
  return children(c).every((k) => built(mem, k));
}

// gist §3 "Free nodes": a node needs no model call when what it would summarize (its message as
// "kind: text", or its children's texts a line apart) is NODE bytes or less; that is its text
export function freeText(mem: Mem, c: Coord): string | null {
  const source = c.l === 0 ? msgText(entry(mem, c.i)) : children(c).map((k) => node(mem, k).text).join("\n");
  return bytes(source) <= NODE ? source : null;
}

const two = (v: number) => (v < 10 ? `0${v}` : String(v));
// the local calendar day of a date, YYYY-MM-DD: the day file a record goes to
export function dayOf(d: Date) {
  return [String(d.getFullYear()), two(d.getMonth() + 1), two(d.getDate())].join("-");
}
// local "YYYY-MM-DD HH:MM" of an ISO time: what date(id) answers (gist §7.1)
export function localTime(iso: string) {
  const at = new Date(iso);
  const clock = [two(at.getHours()), two(at.getMinutes())].join(":");
  return `${dayOf(at)} ${clock}`;
}
