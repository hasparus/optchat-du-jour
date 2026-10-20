// Long pastes, folded (SPEC "Web UI", Chat; docs/uniichat.md, small client items). A block pasted
// into the composer that is longer than FOLD_LINES lines or FOLD_BYTES bytes stands in the text as
// one token, "[Pasted text #1, 120 lines]", with a chip on the composer's tray to open or remove it;
// the message sent has the block where its token was, so the model reads exactly what was pasted.
// In the chat the block shows folded under the same summary. Pure: the composer keeps the pastes
// (with the draft, lib/draft.ts) and the user message draws the folds (chat/pasted.tsx).
import { kb, REPORT_PREFIX } from "@wire";
import type { Fold } from "./draft";
import { linesOf } from "./lines";

// Past 40 lines a paste is a document rather than a sentence: more than a laptop screen of the
// chat's 15 px text (about 25 px a line) and two of a phone's, so drawn whole it pushes what was
// said around it out of view, while a function or a stack trace's head still reads inline. 4 KB
// (about a thousand tokens) catches what has few, long lines, minified JSON or a log, which wraps
// to a hundred lines on a phone. Either one folds it.
export const FOLD_LINES = 40;
export const FOLD_BYTES = 4096;

const encoder = new TextEncoder();
export const bytesOf = (text: string) => encoder.encode(text).length;
export const lineCount = (text: string) => linesOf(text).length;
export const folds = (text: string) => lineCount(text) > FOLD_LINES || bytesOf(text) > FOLD_BYTES;

// how big a block is, said briefly: its lines, or its size when it is one long line
export const sizeOf = (text: string) => {
  const n = lineCount(text);
  return n > 1 ? `${n} lines` : kb(bytesOf(text));
};

export type Paste = { readonly id: number; readonly text: string };

// a paste's stand-in in the composer's text; made from the paste alone, so a draft read back after
// a reload finds its tokens again
export const tokenOf = (p: Paste) => `[Pasted text #${p.id}, ${sizeOf(p.text)}]`;
const TOKEN = /\[Pasted text #(\d+), [^\]\n]*\]/g;

// the pastes whose token is in the text, in the text's order (one typed over, or deleted, is gone)
export const present = (text: string, pastes: readonly Paste[]): Paste[] =>
  [...text.matchAll(TOKEN)].flatMap((m) => pastes.find((p) => String(p.id) === m[1] && tokenOf(p) === m[0]) ?? []);

// the id the next paste gets
export const nextId = (pastes: readonly Paste[]) => Math.max(0, ...pastes.map((p) => p.id)) + 1;

// `token` typed over the selection [start, end): the text, and where the caret goes after it
export const insert = (text: string, start: number, end: number, token: string) => ({ caret: start + token.length, text: text.slice(0, start) + token + text.slice(end) });

// the text without a paste's token
export const removeToken = (text: string, p: Paste) => text.replace(tokenOf(p), "");

// A span of a message's text, [start, end), that is one pasted block
export type Span = readonly [number, number];

// The text as sent: each token replaced by its block, and where each block sits in what results
export const expand = (text: string, pastes: readonly Paste[]) => {
  let out = "";
  let from = 0;
  const spans: Span[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const p = pastes.find((q) => String(q.id) === m[1] && tokenOf(q) === m[0]);
    if (!p) continue;
    out += text.slice(from, m.index);
    spans.push([out.length, out.length + p.text.length]);
    out += p.text;
    from = m.index + m[0].length;
  }
  return { spans, text: out + text.slice(from) };
};

// The spans this browser kept for a message, when they are for this text: a kept length that differs
// names another message under the same log index (the server's log was started afresh), and is none
export const foldsOf = (fold: Fold | undefined, text: string): readonly Span[] | null => (fold !== undefined && fold.length === text.length ? fold.spans : null);

// A message's text in parts: plain, a pasted block, or a long text folded whole. `spans`: where its
// pasted blocks are, for a message sent from this browser (none: it had none, and nothing of it
// folds); null for any other (another client's, one older than what this browser keeps, one posted
// to /api/messages), which folds whole when it is as long as a paste that folds, unless it is a
// subagent's report (the subagent's own answer, kept short by REPORT_MAX, not a paste).
export type Part = { readonly kind: "plain" | "pasted" | "long"; readonly text: string };
export const foldParts = (text: string, spans: readonly Span[] | null): Part[] => {
  if (spans === null) return [{ kind: folds(text) && !REPORT_PREFIX.test(text) ? "long" : "plain", text }];
  const known = spans.filter(([s, e]) => s >= 0 && e <= text.length && s < e).toSorted((a, b) => a[0] - b[0]);
  const parts: Part[] = [];
  let at = 0;
  for (const [s, e] of known) {
    if (s < at) continue; // overlapping: a span from another text
    if (s > at) parts.push({ kind: "plain", text: text.slice(at, s) });
    parts.push({ kind: "pasted", text: text.slice(s, e) });
    at = e;
  }
  if (at < text.length) parts.push({ kind: "plain", text: text.slice(at) });
  return parts;
};
