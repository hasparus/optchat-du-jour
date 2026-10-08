// The view's text (docs/optchat.md §3, §6; ref §5.1). Which nodes are in the view is the kernel's call
// (kernel.ts); this file keeps mem.view up to date, checks a saved one, renders it and waits on it.
import { Effect } from "effect";
import { BLOCK, NODE } from "./config.ts";
import * as K from "./kernel.ts";
import type { Node } from "./records.ts";
import { built, bytes, dayOf, end, type Entry, getNode, label, type Mem, nodes, type Saw, setNode } from "./tree.ts";

// What a line shows until its summary exists (docs/optchat.md §3, §6). Only people read it: rule 3 keeps it out
// of every compactor call, and a turn waits until no view line shows it.
export const PLACEHOLDER = "(not summarized yet: zoom it)";
const HOLE = bytes(PLACEHOLDER);
// What an unbuilt line counts as when the sawtooth weighs the view: its summary's size to come,
// at most NODE, not the placeholder's. A line built after the last message then never takes the
// view past its high mark (a summary a few bytes over NODE aside). Sizes are the lines' texts,
// not their rendered `id+n|` heads and newlines: 2-3% under the rendered bytes, as the reference.
export const UNBUILT = NODE;

const tell = (mem: Mem) => {
  for (const listener of mem.listeners) listener();
};
function changed(mem: Mem, next: Saw) {
  mem.view = next.view;
  mem.folding = next.folding;
  tell(mem);
}

// Message i arrives: its line goes at the end, and only past the high mark, or with a batch still
// owed, does anything merge (docs/optchat.md §3.2). The caller saves the view (store.saveView).
export function addMessage(mem: Mem, msg: Entry) {
  const next = mem.root.length;
  if (msg.i !== next) throw new Error(`addMessage: the next id is ${next}, ${msg.i} is out of turn`);
  mem.root.push(msg);
  changed(mem, K.append(mem, { folding: mem.folding, view: mem.view }, mem.marks, UNBUILT));
}

// A node was built: kept. The view's lines stay as they are until the next message (a batch owed
// goes on then), but a line may now show its summary instead of the placeholder.
export function addNode(mem: Mem, record: Node): void {
  setNode(mem, record);
  tell(mem);
}

// after a bulk import, or with no usable saved view: the view rebuilt from message 0, once
export const refold = (mem: Mem): void => {
  changed(mem, K.refold(mem, mem.marks, UNBUILT));
};

// A saved view (chat/view.json) as [l, i] pairs, and whether a batch is owed; or why there is none
// to use ("missing", "unreadable")
export type Saved = { readonly folding: boolean; readonly view: readonly (readonly [number, number])[] };
export type Found = { readonly ok: true; readonly saved: Saved } | { readonly ok: false; readonly why: string };

// Where the saved lines end, if they are legal: whole nodes, each starting where the one before
// ended, the first at 0, the last at or before T, and every merged line built (a merge needs its
// parent). A message's own line may still wait for its summary.
function savedEnd(mem: Mem, saved: Saved): { readonly ok: true; readonly end: number } | { readonly ok: false; readonly why: string } {
  let at = 0;
  for (const [l, i] of saved.view) {
    const c = { i, l };
    if (l < 0 || l > 52 || i < 0) return { ok: false, why: `[${l}, ${i}] is no node` };
    const width = 2 ** l;
    if (i * width !== at) return { ok: false, why: `${label(c)} does not start at ${at}` };
    if (l > 0 && !built(mem, c)) return { ok: false, why: `${label(c)} is a merge whose summary is not in the tree` };
    at += width;
    if (at > mem.root.length) return { ok: false, why: `${label(c)} runs past the log's ${mem.root.length} messages` };
  }
  return { end: at, ok: true };
}

// The view at load (docs/optchat.md §3.2 "Save the view to view.json and load it at start"): the saved one
// when it fits the log and the tree. One that stops short of the log (a crash between logging a
// message and saving the view) gets the missing messages appended, as they would have been.
// Missing or damaged, it is rebuilt from the log; every cache entry dies then, so it is said.
export function restore(mem: Mem, found: Found): string | null {
  const rebuilt = (why: string) => {
    refold(mem);
    return `chat/view.json: ${why}; the view was rebuilt from the log`;
  };
  if (!found.ok) return rebuilt(found.why);
  const ends = savedEnd(mem, found.saved);
  if (!ends.ok) return rebuilt(ends.why);
  const at: Saw = { folding: found.saved.folding, view: found.saved.view.map(([l, i]) => ({ i, l })) };
  changed(mem, ends.end === mem.root.length ? at : K.extend(mem, at, mem.marks, UNBUILT, ends.end));
  const behind = mem.root.length - ends.end;
  return behind === 0 ? null : `chat/view.json: ${behind} messages behind the log; appended them`;
}

// one space for each line break, whether LF, CRLF or a CR on its own
export const flat = (text: string) => text.split(/\r\n?|\n/).join(" ");

// the view as every call sees it: one id+n|text line per part inside <chat> tags
export function render(mem: Mem): string {
  const lines = mem.view.map((c) => `${label(c)}|${flat(getNode(mem, c)?.text ?? PLACEHOLDER)}`);
  return `${["<chat>", ...lines].join("\n")}\n</chat>`;
}

// The view, or a compactor's context, as content blocks (docs/optchat.md §3.3 "How the cache is
// marked"): `size` lines each, counted from the start, so a text that only grows at its end keeps
// every whole block byte for byte. `whole` counts the leading blocks of `size` whole lines (each
// ending in a line break): the one cache mark goes on the last of them. What follows, the
// unterminated last line (`</chat>`) and the lines before it that fill no block, is the partial
// block, never marked.
export type Blocks = { readonly blocks: readonly string[]; readonly whole: number };
export function viewBlocks(text: string, size: number = BLOCK): Blocks {
  const blocks: string[] = [];
  let start = 0, lines = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
    if (++lines % size === 0) {
      blocks.push(text.slice(start, at + 1));
      start = at + 1;
    }
  const whole = blocks.length;
  if (start < text.length) blocks.push(text.slice(start));
  return { blocks, whole };
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
// context (E24). Rule 3 keeps every one of them built; an unbuilt one is a bug.
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

// done once every view line is a summary (docs/optchat.md §6). Interrupting it is the user's cancel; it
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
  const used = viewSize(mem), percent = Math.round((used / mem.marks.high) * 100), lineCount = mem.view.length, limit = kb(mem.marks.high);
  const fill = `view ${kb(used).toFixed(1)}/${limit} KB (${percent}%), ${lineCount} lines · ${owed} summaries pending`;
  const open = unbuilt(mem);
  return [span, open > 0 ? `${fill}, ${open} view lines unsummarized` : fill];
}
