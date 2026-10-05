// The view's text (gist §5, §6; ref §5.1). Which nodes are in the view is the kernel's call
// (kernel.ts); this file keeps mem.view up to date, renders it and waits on it.
import { Effect } from "effect";
import { MARKS } from "./config.ts";
import * as K from "./kernel.ts";
import type { Node } from "./records.ts";
import { built, bytes, type Coord, dayOf, end, type Entry, getNode, label, type Mem, nodes, setNode } from "./tree.ts";

// an unbuilt line's text: display and fail-safe only, no call ever sees it (gist §6)
export const PLACEHOLDER = "(not summarized yet: zoom it)";
const HOLE = bytes(PLACEHOLDER);

function changed(mem: Mem, view: readonly Coord[]) {
  mem.view = view;
  for (const tell of mem.listeners) tell();
}

// message i arrives: its line goes at the end, then the view is fit again (gist §5.2)
export function addMessage(mem: Mem, m: Entry) {
  if (m.i !== mem.root.length) throw new Error(`message ${m.i} arrived, ${mem.root.length} was due`);
  mem.root.push(m);
  changed(mem, K.append(mem, HOLE));
}

// a node was built: keep it, then fit
export function addNode(mem: Mem, record: Node): void {
  setNode(mem, record);
  changed(mem, K.fit(mem, HOLE));
}

// at load (and after a bulk import): the view folded from message 0 again
export const refold = (mem: Mem): void => {
  changed(mem, K.refold(mem, HOLE));
};

// every line break (LF, CRLF or a lone CR) becomes one space
export const flat = (s: string) => s.replaceAll(/\r\n|\r|\n/g, " ");

const text = (mem: Mem, l: number, i: number) => getNode(mem, l, i)?.text ?? PLACEHOLDER;

// the view as every call sees it: one id+n|text line per part inside <chat> tags
export function render(mem: Mem): string {
  const lines = mem.view.map((c) => `${label(c)}|${flat(text(mem, c.l, c.i))}`);
  return `<chat>\n${lines.map((line) => `${line}\n`).join("")}</chat>`;
}

// The view in blocks (gist §8). Each mark inside the text moves back to just after the last
// line end before it; the text is then sliced at those points. The marks from the first one
// at or past the end are dropped, and a point that is no further on than the one before adds
// no block.
export function cutBlocks(view: string, marks: readonly number[] = MARKS): string[] {
  const outside = marks.findIndex((mark) => mark >= view.length);
  const points = (outside === -1 ? marks : marks.slice(0, outside)).map((mark) => view.lastIndexOf("\n", mark - 1) + 1);
  const starts = [0];
  for (const p of points) if (p > (starts.at(-1) ?? 0)) starts.push(p);
  return starts.map((start, k) => view.slice(start, starts[k + 1]));
}

export const unbuilt = (mem: Mem) => mem.view.filter((c) => !built(mem, c.l, c.i)).length;
export const allBuilt = (mem: Mem) => unbuilt(mem) === 0;
export const viewSize = (mem: Mem) => mem.view.reduce((sum, c) => sum + (getNode(mem, c.l, c.i)?.size ?? HOLE), 0);

// the bare text of the view lines that end at or before message `limit`: a compactor call's
// context (gist §4.2). Rule 3 keeps every one of them built; an unbuilt one is a bug.
export function context(mem: Mem, limit: number): string[] {
  const past = mem.view.findIndex((c) => end(c) > limit);
  return mem.view.slice(0, past === -1 ? mem.view.length : past).map((c) => {
    const line = getNode(mem, c.l, c.i);
    if (!line) throw new Error(`rule 3 broken: view line ${label(c)} is unbuilt in a context up to ${limit}`);
    return flat(line.text);
  });
}

// done once every view line is a summary (gist §6). Interrupting it is the user's cancel; it
// leaves no listener behind either way.
export const settle = (mem: Mem): Effect.Effect<void> =>
  Effect.callback<undefined>((resume) => {
    const check = () => {
      if (!allBuilt(mem)) return;
      mem.listeners.delete(check);
      resume(Effect.undefined);
    };
    mem.listeners.add(check);
    check();
    return Effect.sync(() => {
      mem.listeners.delete(check);
    });
  });

const ago = (ms: number) => {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / (24 * 60))}d ago`;
};

// the two-line header the terminal prints above the view (ref §10)
export function stats(mem: Mem, now: Date = new Date()): readonly [string, string] {
  const T = mem.root.length, last = mem.root.at(-1), firstMsg = mem.root[0];
  const chat = firstMsg && last
    ? `optchat: ${T} messages, ${dayOf(new Date(firstMsg.date))} → ${dayOf(new Date(last.date))}, last ${ago(now.getTime() - Date.parse(last.date))}`
    : "optchat: no messages yet";
  let pending = 0;
  for (const c of nodes(T)) if (!built(mem, c.l, c.i)) pending++;
  const size = viewSize(mem), open = unbuilt(mem);
  const fill = `view ${(size / 1000).toFixed(1)}/${mem.budget / 1000} KB (${Math.round((100 * size) / mem.budget)}%), ${mem.view.length} lines · ${pending} summaries pending`;
  return [chat, open ? `${fill}, ${open} view lines unsummarized` : fill];
}
