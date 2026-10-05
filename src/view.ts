// The view's text (gist §5, §6; ref §5.1). Which nodes are in the view is the kernel's call
// (kernel.ts); this file keeps mem.view up to date, renders it and waits on it.
import { Effect } from "effect";
import { MARKS } from "./config.ts";
import * as K from "./kernel.ts";
import type { Node } from "./records.ts";
import { built, bytes, type Coord, dayOf, end, type Entry, getNode, label, type Mem, nodes, setNode } from "./tree.ts";

// What a line shows until its summary exists (gist §6). Only people read it: rule 3 keeps it out
// of every compactor call, and a turn waits until no view line shows it.
export const PLACEHOLDER = "(not summarized yet: zoom it)";
const HOLE = bytes(PLACEHOLDER);

function changed(mem: Mem, view: readonly Coord[]) {
  mem.view = view;
  for (const tell of mem.listeners) tell();
}

// message i arrives: its line goes at the end, then the view is fit again (gist §5.2)
export function addMessage(mem: Mem, msg: Entry) {
  const next = mem.root.length;
  if (msg.i !== next) throw new Error(`addMessage: the next id is ${next}, ${msg.i} is out of turn`);
  mem.root.push(msg);
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

// one space for each line break, whether LF, CRLF or a CR on its own
export const flat = (text: string) => text.split(/\r\n?|\n/).join(" ");

// the view as every call sees it: one id+n|text line per part inside <chat> tags
export function render(mem: Mem): string {
  const lines = mem.view.map((c) => `${label(c)}|${flat(getNode(mem, c)?.text ?? PLACEHOLDER)}`);
  return `${["<chat>", ...lines].join("\n")}\n</chat>`;
}

// The view in blocks (gist §8). Each mark inside the text moves back to just after the last
// line end before it; the text is then sliced at those points. The marks from the first one
// at or past the end are dropped, and a point that is no further on than the one before adds
// no block.
export function cutBlocks(text: string, at: readonly number[] = MARKS) {
  const inside = at.findIndex((mark) => mark >= text.length);
  const points = (inside === -1 ? at : at.slice(0, inside)).map((mark) => text.lastIndexOf("\n", mark - 1) + 1);
  const starts = [0];
  for (const p of points) if (p > (starts.at(-1) ?? 0)) starts.push(p);
  return starts.map((start, k) => text.slice(start, starts[k + 1]));
}

export function unbuilt(mem: Mem) {
  let open = 0;
  for (const c of mem.view) if (!built(mem, c)) open++;
  return open;
}
export function allBuilt(mem: Mem) {
  return unbuilt(mem) === 0;
}
export function viewSize(mem: Mem) {
  let total = 0;
  for (const c of mem.view) total += getNode(mem, c)?.size ?? HOLE;
  return total;
}

// the bare text of the view lines that end at or before message `upTo`: a compactor call's
// context (gist §4.2). Rule 3 keeps every one of them built; an unbuilt one is a bug.
export function context(mem: Mem, upTo: number): string[] {
  const texts: string[] = [];
  for (const c of mem.view) {
    if (end(c) > upTo) break;
    const n = getNode(mem, c);
    if (!n) throw new Error(`rule 3 broken: view line ${label(c)} is unbuilt in a context up to ${upTo}`);
    texts.push(flat(n.text));
  }
  return texts;
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

// the age in its largest whole unit, days, hours or minutes, as in ref §10's "last 2h ago"
const UNITS: readonly (readonly [string, number])[] = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
];
function elapsed(ms: number) {
  const [unit, size] = UNITS.find(([, length]) => ms >= length) ?? ["m", 60_000];
  return `${Math.max(0, Math.floor(ms / size))}${unit}`;
}

const kb = (size: number) => size / 1000;

// The two-line header the terminal prints above the view (ref §10): what the log spans, then how
// full the view is and how much summarizing is still owed.
export function stats(mem: Mem, at: Date = new Date()): readonly [string, string] {
  const count = mem.root.length;
  const [oldest, newest] = [mem.root[0], mem.root.at(-1)];
  let span = "optchat: no messages yet";
  if (oldest && newest) {
    const [from, to] = [oldest, newest].map((m) => dayOf(new Date(m.date)));
    span = `optchat: ${count} messages, ${from} → ${to}, last ${elapsed(at.getTime() - Date.parse(newest.date))} ago`;
  }
  const owed = nodes(count).filter((c) => !built(mem, c)).toArray().length;
  const used = viewSize(mem), percent = Math.round((used / mem.budget) * 100), lineCount = mem.view.length, limit = kb(mem.budget);
  const fill = `view ${kb(used).toFixed(1)}/${limit} KB (${percent}%), ${lineCount} lines · ${owed} summaries pending`;
  const open = unbuilt(mem);
  return [span, open > 0 ? `${fill}, ${open} view lines unsummarized` : fill];
}
