// What a file tool's call changes (SPEC "Web UI", Chat; docs/uniichat.md, small client items):
// Claude Code's Edit and MultiEdit as a line diff of each old_string to its new_string, its Write as
// the new file's lines. The input may still be streaming (E45): it is read as far as it goes, a
// string cut short as what it has so far, so the diff grows as the model writes. Pure: the tool
// row draws it (chat/tool-diff.tsx), and its raw input stays one tap away.
import { Option, Schema } from "effect";

// ---- a JSON text read as far as it goes ----

// The value at the start of `s`, read as far as the text goes: a string cut short is what it has
// so far (a dangling escape left out), an object or an array cut short has what began in it, and a
// value that hasn't begun (or a number or a literal cut short) is undefined. Whole JSON reads as
// JSON.parse would.
const ESCAPES = new Map([
  ['"', '"'],
  ["/", "/"],
  ["\\", "\\"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);
const LITERAL = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/;
export function readPartial(s: string): Schema.Json | undefined {
  let i = 0;
  const space = () => {
    while (i < s.length && " \t\n\r".includes(s[i] ?? "")) i++;
  };
  const string = (): string => {
    i++; // the opening quote
    let out = "";
    while (i < s.length) {
      const c = s[i] ?? "";
      if (c === '"') {
        i++;
        return out;
      }
      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }
      const e = s[i + 1];
      if (e === undefined) break; // cut inside an escape
      if (e === "u") {
        const hex = s.slice(i + 2, i + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
        out += String.fromCodePoint(Number.parseInt(hex, 16));
        i += 6;
        continue;
      }
      out += ESCAPES.get(e) ?? e;
      i += 2;
    }
    i = s.length;
    return out;
  };
  const value = (): Schema.Json | undefined => {
    space();
    const c = s[i];
    if (c === undefined) return undefined;
    if (c === '"') return string();
    if (c === "{") return object();
    if (c === "[") return array();
    const m = LITERAL.exec(s.slice(i));
    if (!m || i + m[0].length >= s.length) {
      i = s.length; // a number may go on: not read until it ends
      return undefined;
    }
    i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" ? null : Number(m[0]);
  };
  // the members of an array or an object, up to `close` or as far as the text goes
  const members = <A>(close: string, member: () => A | undefined): A[] => {
    i++;
    const out: A[] = [];
    for (;;) {
      space();
      if (i >= s.length) return out;
      if (s[i] === close) {
        i++;
        return out;
      }
      const m = member();
      if (m === undefined) return out;
      out.push(m);
      space();
      if (s[i] === ",") i++;
      else if (s[i] !== close) return out;
    }
  };
  const array = () => members("]", value);
  // a key and its value; a key cut short, or one with no value begun, is none
  const pair = (): [string, Schema.Json] | undefined => {
    if (s[i] !== '"') {
      i = s.length;
      return undefined;
    }
    const start = i;
    const key = string();
    if (s[i - 1] !== '"' || i - 1 === start) return undefined;
    space();
    if (s[i] !== ":") return undefined;
    i++;
    const v = value();
    return v === undefined ? undefined : [key, v];
  };
  const object = () => Object.fromEntries(members("}", pair));
  return value();
}

// ---- line diffs ----

export type DiffLine = { readonly kind: "same" | "del" | "add"; readonly text: string };

// a text's lines; a final newline ends the last one rather than starting another
const linesOf = (text: string) => (text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"));

// past this many cells of the LCS table (old lines × new lines), the middle is shown as all removed,
// then all added: correct, if not the shortest, and never a frozen page
const MAX_CELLS = 1_000_000;

const same = (lines: readonly string[]): DiffLine[] => lines.map((text) => ({ kind: "same", text }));

// The lines of `before` turned into `after`: those both share at the start and the end as they are,
// and between them a longest common subsequence's lines kept, the rest removed or added
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  let middle: DiffLine[];
  if (x.length * y.length > MAX_CELLS) {
    middle = [...x.map((text): DiffLine => ({ kind: "del", text })), ...y.map((text): DiffLine => ({ kind: "add", text }))];
  } else {
    // lcs[k][j]: the longest common subsequence of x[k..] and y[j..]
    const lcs = Array.from({ length: x.length + 1 }, () => new Uint32Array(y.length + 1));
    for (let k = x.length - 1; k >= 0; k--) {
      const row = lcs[k] ?? new Uint32Array(0);
      const below = lcs[k + 1] ?? new Uint32Array(0);
      for (let j = y.length - 1; j >= 0; j--) row[j] = x[k] === y[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
    }
    middle = [];
    let k = 0;
    let j = 0;
    while (k < x.length || j < y.length) {
      if (k < x.length && j < y.length && x[k] === y[j]) {
        middle.push({ kind: "same", text: x[k] ?? "" });
        k++;
        j++;
      } else if (j < y.length && (k >= x.length || (lcs[k]?.[j + 1] ?? 0) >= (lcs[k + 1]?.[j] ?? 0))) {
        middle.push({ kind: "add", text: y[j] ?? "" });
        j++;
      } else {
        middle.push({ kind: "del", text: x[k] ?? "" });
        k++;
      }
    }
    // within a run of changes, the removed lines first, then the added ones, as a diff reads
    middle = grouped(middle);
  }
  return [...same(a.slice(0, head)), ...middle, ...same(a.slice(a.length - tail))];
}

// each run of changed lines as its removals, then its additions
const grouped = (lines: readonly DiffLine[]): DiffLine[] => {
  const out: DiffLine[] = [];
  let run: DiffLine[] = [];
  const flush = () => {
    out.push(...run.filter((l) => l.kind === "del"), ...run.filter((l) => l.kind === "add"));
    run = [];
  };
  for (const line of lines) {
    if (line.kind === "same") {
      flush();
      out.push(line);
    } else run.push(line);
  }
  flush();
  return out;
};

// ---- what a call changes ----

const Edit = Schema.Struct({ old_string: Schema.optional(Schema.String), new_string: Schema.optional(Schema.String) });
const FileInput = Schema.Struct({
  file_path: Schema.optional(Schema.String),
  old_string: Schema.optional(Schema.String),
  new_string: Schema.optional(Schema.String),
  edits: Schema.optional(Schema.Array(Edit)),
  content: Schema.optional(Schema.String),
});
const decodeInput = Schema.decodeUnknownOption(FileInput);

// An Edit's or a MultiEdit's hunks (one per edit), or a Write's new file; `whole` once the input is
// whole, so counts are final; null for any other tool, or an input that says nothing of the change yet
export type FileChange =
  | { readonly kind: "edit"; readonly path: string | null; readonly hunks: readonly (readonly DiffLine[])[]; readonly added: number; readonly removed: number; readonly whole: boolean }
  | { readonly kind: "write"; readonly path: string | null; readonly content: string; readonly lines: number; readonly whole: boolean };

const isWhole = (args: string) => {
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
};

export function fileChange(name: string, args: string): FileChange | null {
  if (name !== "Edit" && name !== "MultiEdit" && name !== "Write") return null;
  const input = Option.getOrNull(decodeInput(readPartial(args)));
  if (input === null) return null;
  const path = input.file_path ?? null;
  const whole = isWhole(args);
  if (name === "Write") return input.content === undefined ? null : { content: input.content, kind: "write", lines: linesOf(input.content).length, path, whole };
  const edits = name === "Edit" ? [input] : (input.edits ?? []);
  // an edit whose old_string hasn't come yet shows nothing; one whose new_string hasn't, its removals so far
  const hunks = edits.flatMap((e) => (e.old_string === undefined ? [] : [lineDiff(e.old_string, e.new_string ?? "")]));
  if (hunks.length === 0) return null;
  const count = (kind: DiffLine["kind"]) => hunks.reduce((n, h) => n + h.filter((l) => l.kind === kind).length, 0);
  return { added: count("add"), hunks, kind: "edit", path, removed: count("del"), whole };
}
