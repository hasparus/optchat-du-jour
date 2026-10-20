// What a file tool's call changes (SPEC "Web UI", Chat; docs/uniichat.md, small client items):
// Claude Code's Edit and MultiEdit as a line diff of each old_string to its new_string, its Write as
// the new file's lines. The input may still be streaming (E45): it is read as far as it goes
// (src/partial-json.ts, the reader of the server's artifact drafts), a string cut short as
// what it has so far, so the diff grows as the model writes. Pure: the tool row draws it
// (chat/tool-diff.tsx), and its raw input stays one tap away.
import { readPartial } from "@shared/partial-json";
import { liveTool } from "@wire";
import { Option, Schema } from "effect";
import { linesOf } from "./lines";

// ---- line diffs ----

export type DiffLine = { readonly kind: "same" | "del" | "add"; readonly text: string };

// The cells of LCS table (old lines × new lines) one call's hunks may fill between them, about
// 4 MB and a few ms: a hunk past what is left shows its middle as all removed, then all added,
// correct if not the shortest, so a huge MultiEdit never freezes the page
export const MAX_CELLS = 1_000_000;
// what is left of a call's cells, spent hunk by hunk
export type Budget = { left: number };
const fullBudget = (): Budget => ({ left: MAX_CELLS });

const same = (lines: readonly string[]): DiffLine[] => lines.map((text) => ({ kind: "same", text }));

// The lines of `before` turned into `after`: those both share at the start and the end as they are,
// and between them a longest common subsequence's lines kept, the rest removed or added, while the
// budget lasts
export function lineDiff(before: string, after: string, budget: Budget = fullBudget()): DiffLine[] {
  const a = linesOf(before);
  const b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  let middle: DiffLine[];
  const cells = x.length * y.length;
  if (cells > budget.left) {
    middle = [...x.map((text): DiffLine => ({ kind: "del", text })), ...y.map((text): DiffLine => ({ kind: "add", text }))];
  } else {
    budget.left -= cells;
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
  | { readonly kind: "write"; readonly path: string | null; readonly lines: readonly string[]; readonly whole: boolean };

const isWhole = (args: string) => {
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
};

export function fileChange(name: string, args: string): FileChange | null {
  if (!liveTool(name)) return null;
  const input = Option.getOrNull(decodeInput(readPartial(args)));
  if (input === null) return null;
  const path = input.file_path ?? null;
  const whole = isWhole(args);
  if (name === "Write") return input.content === undefined ? null : { kind: "write", lines: linesOf(input.content), path, whole };
  const edits = name === "Edit" ? [input] : (input.edits ?? []);
  // an edit whose old_string hasn't come yet shows nothing; one whose new_string hasn't, its removals so far
  const budget = fullBudget();
  const hunks = edits.flatMap((e) => (e.old_string === undefined ? [] : [lineDiff(e.old_string, e.new_string ?? "", budget)]));
  if (hunks.length === 0) return null;
  const count = (kind: DiffLine["kind"]) => hunks.reduce((n, h) => n + h.filter((l) => l.kind === kind).length, 0);
  return { added: count("add"), hunks, kind: "edit", path, removed: count("del"), whole };
}
