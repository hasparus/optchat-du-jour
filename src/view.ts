// The view (gist §5, §6): which nodes it holds is the kernel's business (src/kernel.ts); this
// file owns its text. Rendering, cutting, the compactor's context and settle().
import { Effect } from "effect";
import { MARKS } from "./config.ts";
import * as K from "./kernel.ts";
import type { Node } from "./records.ts";
import { built, type Coord, dayOf, type Entry, getNode, type Mem, setNode, span } from "./tree.ts";

export { PLACEHOLDER } from "./kernel.ts";

// a listener may remove itself while it is told; a Set's iterator copes with that
const changed = (mem: Mem) => {
  for (const tell of mem.listeners) tell();
};

export function addMessage(mem: Mem, m: Entry) {
  if (m.i !== mem.root.length) throw new Error(`message id ${m.i}, expected ${mem.root.length}`);
  mem.root.push(m);
  mem.view = K.append(mem);
  changed(mem);
}

export function addNode(mem: Mem, n: Node) {
  setNode(mem, n);
  mem.view = K.fit(mem);
  changed(mem);
}

// ponytail: the kernel folds 20k messages in ~1 s and 60k in ~4 s (it rebuilds its list on
// every append); keep the view's size as a running total in the kernel if startup gets slow
export function refold(mem: Mem) {
  mem.view = K.refold(mem);
  changed(mem);
}

export const flat = (s: string) => s.replaceAll(/\r\n|\r|\n/g, " ");
const partText = (mem: Mem, c: Coord) => getNode(mem, c.l, c.i)?.text ?? K.PLACEHOLDER;

export const render = (mem: Mem) =>
  ["<chat>", ...mem.view.map((c) => `${span(c).id}+${span(c).n}|${flat(partText(mem, c))}`), "</chat>"].join("\n");

// cut after the last line end before each mark; marks past the end are skipped (ref §5.1)
export function cutBlocks(s: string, marks: readonly number[] = MARKS): string[] {
  const out: string[] = [];
  let from = 0;
  for (const m of marks) {
    if (m >= s.length) continue;
    const end = s.lastIndexOf("\n", m - 1) + 1;
    if (end <= from) continue;
    out.push(s.slice(from, end));
    from = end;
  }
  out.push(s.slice(from));
  return out;
}

export const allBuilt = (mem: Mem) => mem.view.every((c) => built(mem, c.l, c.i));
export const unbuilt = (mem: Mem) => mem.view.filter((c) => !built(mem, c.l, c.i)).length;
export const viewSize = (mem: Mem) => mem.view.reduce((s, c) => s + K.partSize(mem, c), 0);

// the bare lines (no ids) of the parts that end at or before `limit`: a compactor call's context
// (gist §4.2). An unbuilt one there means rule 3 is broken, which must be loud.
export function context(mem: Mem, limit: number): string[] {
  const lines: string[] = [];
  for (const c of mem.view) {
    const { id, n } = span(c);
    if (id + n > limit) break;
    const node = getNode(mem, c.l, c.i);
    if (!node) throw new Error(`unbuilt line ${id}+${n} before ${limit}: rule 3 broken`);
    lines.push(flat(node.text));
  }
  return lines;
}

// done when every view line is built (gist §6); interrupting it is the user's cancel
export const settle = (mem: Mem) =>
  Effect.callback<true>((resume) => {
    const check = () => {
      if (!allBuilt(mem)) return;
      mem.listeners.delete(check);
      resume(Effect.succeed(true));
    };
    mem.listeners.add(check);
    check();
    return Effect.sync(() => mem.listeners.delete(check));
  }).pipe(Effect.asVoid);

// a few lines for the start of a session: time span, view fill, summarizer backlog. Pending counts
// every unbuilt node over a full pair, an upper bound on the calls to come.
export function stats(mem: Mem, now = new Date()): string[] {
  const firstMsg = mem.root[0], lastMsg = mem.root.at(-1), T = mem.root.length;
  if (!firstMsg || !lastMsg) return ["0 messages"];
  const last = new Date(lastMsg.date), open = unbuilt(mem), size = viewSize(mem);
  let pending = 0;
  for (let l = 0; 2 ** l <= T; l++) for (let i = 0; (i + 1) * 2 ** l <= T; i++) if (!built(mem, l, i)) pending++;
  const backlog = pending
    ? `${plural(pending, "summary", "summaries")} pending${open ? `, ${plural(open, "view line", "view lines")} unsummarized` : ""}`
    : "all summarized";
  return [
    `${T} messages, ${dayOf(new Date(firstMsg.date))} → ${dayOf(last)}, last ${ago(now.getTime() - last.getTime())}`,
    `view ${kb(size)}/${kb(mem.budget)} KB (${Math.round((100 * size) / mem.budget)}%), ${mem.view.length} lines · ${backlog}`,
  ];
}

const kb = (b: number) => (b / 1000).toFixed(1).replace(/\.0$/, "");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function ago(ms: number) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}
