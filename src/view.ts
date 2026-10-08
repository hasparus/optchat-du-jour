// The view's text (docs/optchat.md §3, §6; ref §5.1). Which nodes are in the view is the kernel's call
// (kernel.ts); this file keeps mem.view and the compaction view up to date, checks saved ones,
// renders them and waits on the view.
import { Effect } from "effect";
import { BLOCK, NODE } from "./config.ts";
import * as K from "./kernel.ts";
import type { Node } from "./records.ts";
import { built, bytes, type Coord, dayOf, end, type Entry, getNode, label, type Mem, nodes, type Saw, setNode } from "./tree.ts";

// What a line shows until its summary exists (docs/optchat.md §3, §6). Only people read it: no
// compaction sees it (compactionContext), and a turn waits until no view line shows it.
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
function changed(mem: Mem, next: Saw, compaction: Saw) {
  mem.view = next.view;
  mem.folding = next.folding;
  mem.compaction = compaction;
  tell(mem);
}

// The compaction view once message i has arrived and the view went from `before` to `after`
// (docs/optchat.md §4 "Its view"): when the view merged, it is the view merged again, down to the
// compaction view's low mark; otherwise it gets the same new line and runs its own sawtooth, so
// between batches it too only grows at its end.
function follow(mem: Mem, i: number, before: readonly Coord[], after: Saw, compaction: Saw): Saw {
  const merged = after.view.length < before.length + 1;
  return merged ? K.batch(mem, after.view, mem.compactionMarks, UNBUILT, i + 1) : K.append(mem, compaction, mem.compactionMarks, UNBUILT, i);
}

// message i arrives in the view `at`
const arrive = (mem: Mem, i: number, at: Saw) => K.append(mem, { folding: at.folding, view: at.view }, mem.marks, UNBUILT, i);

// Message i arrives: its line goes at the end, and only past the high mark, or with a batch still
// owed, does anything merge (docs/optchat.md §3.2). The caller saves the view (store.saveView).
export function addMessage(mem: Mem, msg: Entry) {
  const next = mem.root.length;
  if (msg.i !== next) throw new Error(`addMessage: the next id is ${next}, ${msg.i} is out of turn`);
  mem.root.push(msg);
  const after = arrive(mem, msg.i, mem);
  changed(mem, after, follow(mem, msg.i, mem.view, after, mem.compaction));
}

// A node was built: kept. The view's lines stay as they are until the next message (a batch owed
// goes on then), but a line may now show its summary instead of the placeholder.
export function addNode(mem: Mem, record: Node): void {
  setNode(mem, record);
  tell(mem);
}

// after a bulk import, or with no usable saved view: the view rebuilt from message 0, once, and
// the compaction view merged down from it
export const refold = (mem: Mem): void => {
  const view = K.refold(mem, mem.marks, UNBUILT);
  changed(mem, view, K.batch(mem, view.view, mem.compactionMarks, UNBUILT));
};

// A saved view (chat/view.json) as [l, i] pairs, and whether a batch is owed; the compaction view
// beside it (missing in a file written before it existed); or why there is none to use
// ("missing", "unreadable")
export type SavedSaw = { readonly folding: boolean; readonly view: readonly (readonly [number, number])[] };
export type Saved = SavedSaw & { readonly compaction?: SavedSaw | undefined };
export type Found = { readonly ok: true; readonly saved: Saved } | { readonly ok: false; readonly why: string };

// Where the saved lines end, if they are legal: whole nodes, each starting where the one before
// ended, the first at 0, the last at or before T, and every merged line built (a merge needs its
// parent). A message's own line may still wait for its summary.
function savedEnd(mem: Mem, saved: SavedSaw): { readonly ok: true; readonly end: number } | { readonly ok: false; readonly why: string } {
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

const sawOf = (saved: SavedSaw): Saw => ({ folding: saved.folding, view: saved.view.map(([l, i]) => ({ i, l })) });

// The view at load (docs/optchat.md §3.2 "Save the view to view.json and load it at start"): the saved one
// when it fits the log and the tree. One that stops short of the log (a crash between logging a
// message and saving the view) gets the missing messages appended, as they would have been.
// Missing or damaged, it is rebuilt from the log; every cache entry dies then, so it is said. The
// compaction view is saved with it and loaded the same way; one that is missing (a file from
// before it existed), doesn't fit, or whose view had to catch up is merged down from the view
// once: only compactions' cache entries die then.
export function restore(mem: Mem, found: Found): string | null {
  const rebuilt = (why: string) => {
    refold(mem);
    return `chat/view.json: ${why}; the view was rebuilt from the log`;
  };
  if (!found.ok) return rebuilt(found.why);
  const ends = savedEnd(mem, found.saved);
  if (!ends.ok) return rebuilt(ends.why);
  const at = sawOf(found.saved), behind = mem.root.length - ends.end;
  const view = behind === 0 ? at : K.extend(mem, at, mem.marks, UNBUILT, ends.end);
  // the compaction view as saved, when it is whole and the view did not have to catch up
  const { compaction } = found.saved;
  const theirs = compaction === undefined ? null : savedEnd(mem, compaction);
  const kept = compaction !== undefined && theirs?.ok === true && theirs.end === ends.end && behind === 0;
  changed(mem, view, kept ? sawOf(compaction) : K.batch(mem, view.view, mem.compactionMarks, UNBUILT));
  const notes = [
    ...(behind === 0 ? [] : [`chat/view.json: ${behind} messages behind the log; appended them`]),
    ...(theirs === null || theirs.ok ? [] : [`chat/view.json: the compaction view: ${theirs.why}; merged it again from the view`]),
  ];
  return notes.length === 0 ? null : notes.join("; ");
}

// one space for each line break, whether LF, CRLF or a CR on its own
export const flat = (text: string) => text.split(/\r\n?|\n/).join(" ");

// a view line as every call sees it: id+n|text, newlines as spaces
const lineOf = (mem: Mem, c: Coord) => `${label(c)}|${flat(getNode(mem, c)?.text ?? PLACEHOLDER)}`;

// the view as every turn sees it: one id+n|text line per part inside <chat> tags
export function render(mem: Mem): string {
  return `${["<chat>", ...mem.view.map((c) => lineOf(mem, c))].join("\n")}\n</chat>`;
}

// The view, or a compactor's context, as content blocks (docs/optchat.md §3.3 "How the cache is
// marked"): `size` lines each, counted from the start, so a text that only grows at its end keeps
// every whole block byte for byte. A whole block is `size` lines each ending in a line break;
// `mark` is the index of the last one, where the one cache mark goes (none while no block is
// whole). What follows, the unterminated last line (`</chat>`) and the lines before it that fill
// no block, is the partial block, never marked.
export type Blocks = { readonly blocks: readonly string[]; readonly mark: number | undefined };
export function viewBlocks(text: string, size: number = BLOCK): Blocks {
  const blocks: string[] = [];
  let start = 0, lines = 0;
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
    if (++lines % size === 0) {
      blocks.push(text.slice(start, at + 1));
      start = at + 1;
    }
  const mark = blocks.length > 0 ? blocks.length - 1 : undefined;
  if (start < text.length) blocks.push(text.slice(start));
  return { blocks, mark };
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

// A compaction's view (docs/optchat.md §4): the compaction view's lines that end by message
// `upTo` (for a message's node, the lines before it; for a merge, those up to its last message),
// stopping at the first unbuilt one, so no call sees a placeholder or half a message. Each line as
// the view shows it.
export function compactionContext(mem: Mem, upTo: number): string[] {
  const { view } = mem.compaction;
  const stop = Math.min(upTo, K.first(mem, view)); // every line before it is built (law first_first)
  const lines: string[] = [];
  for (const c of view) {
    if (end(c) > stop) break;
    lines.push(lineOf(mem, c));
  }
  return lines;
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
