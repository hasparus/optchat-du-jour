// What a file tool's call changes (lib/diff.ts): the line diff of an Edit, the hunks of a MultiEdit
// within one budget of cells, a Write's new file, all from the input as far as it has streamed
// (its reader is src/partial-json.ts's, tested in test/partial-json.test.ts); any other tool has none.
import { expect, test } from "bun:test";
import { fileChange, lineDiff, MAX_CELLS } from "./diff";

// in the order Claude Code writes its keys: the old text streams before the new one
const EDIT = { file_path: "src/a.ts", old_string: "const a = 1;\nconst b = 2;\nconst c = 3;\n", new_string: 'const a = 1;\nconst b = "two";\nconst c = 3;\n' };

const big = (tag: string) => Array.from({ length: 1200 }, (_, k) => `${tag}${k}`).join("\n");

test("a line diff keeps what both share and shows each change as its removals, then its additions", () => {
  expect(lineDiff(EDIT.old_string, EDIT.new_string)).toEqual([
    { kind: "same", text: "const a = 1;" },
    { kind: "del", text: "const b = 2;" },
    { kind: "add", text: 'const b = "two";' },
    { kind: "same", text: "const c = 3;" },
  ]);
  expect(lineDiff("a\nb\nc\nd", "a\nx\nc\ny")).toEqual([
    { kind: "same", text: "a" },
    { kind: "del", text: "b" },
    { kind: "add", text: "x" },
    { kind: "same", text: "c" },
    { kind: "del", text: "d" },
    { kind: "add", text: "y" },
  ]);
  expect(lineDiff("", "new")).toEqual([{ kind: "add", text: "new" }]);
  expect(lineDiff("old", "")).toEqual([{ kind: "del", text: "old" }]);
  // too big to compare line by line: still every line, removed then added
  const huge = lineDiff(big("a"), big("b"));
  expect(huge).toHaveLength(2400);
  expect(huge.slice(1199, 1201).map((l) => l.kind)).toEqual(["del", "add"]);
});

test("an Edit is its diff with counts; a MultiEdit a hunk per edit; a Write its new file; any other tool nothing", () => {
  const args = JSON.stringify(EDIT);
  expect(fileChange("Edit", args)).toMatchObject({ added: 1, kind: "edit", path: "src/a.ts", removed: 1, whole: true });
  const multi = fileChange("MultiEdit", JSON.stringify({ edits: [{ new_string: "b", old_string: "a" }, { new_string: "d\ne", old_string: "c" }], file_path: "x.md" }));
  expect(multi?.kind === "edit" ? multi.hunks.length : 0).toBe(2);
  expect(multi).toMatchObject({ added: 3, removed: 2 });
  expect(fileChange("Write", JSON.stringify({ content: "one\ntwo\nthree\n", file_path: "n.txt" }))).toEqual({ kind: "write", lines: ["one", "two", "three"], path: "n.txt", whole: true });
  expect(fileChange("Read", JSON.stringify({ file_path: "a" }))).toBeNull();
  expect(fileChange("Bash", JSON.stringify({ command: "ls" }))).toBeNull();
});

test("streaming: the diff grows with the input, and is whole once the input is", () => {
  const args = JSON.stringify(EDIT);
  // only the path so far: nothing to draw yet
  expect(fileChange("Edit", args.slice(0, args.indexOf("old_string")))).toBeNull();
  // the old text, and none of the new yet: all of it removed so far
  const before = fileChange("Edit", args.slice(0, args.indexOf("new_string")));
  expect(before).toMatchObject({ added: 0, removed: 3, whole: false });
  // the old text whole, the new one cut: what has come of it so far
  const cut = args.slice(0, args.indexOf("two") + 3);
  const partial = fileChange("Edit", cut);
  expect(partial?.kind === "edit" && partial.whole).toBe(false);
  expect(partial?.kind === "edit" ? partial.hunks[0]?.filter((l) => l.kind === "add").map((l) => l.text) : []).toEqual(['const b = "two']);
  const writing = fileChange("Write", String.raw`{"file_path":"n.txt","content":"one\ntwo\nth`);
  expect(writing).toMatchObject({ kind: "write", lines: ["one", "two", "th"], whole: false });
});

// n lines, every other one `tag`'s own and the first among them, so nothing is trimmed as shared at
// the start: a longest common subsequence keeps the other half
const alternating = (n: number, tag: string) => Array.from({ length: n }, (_, k) => (k % 2 === 1 ? `same ${k}` : `${tag} ${k}`)).join("\n");
const sameInMiddle = (lines: readonly { readonly kind: string }[]) => lines.slice(1, -1).filter((l) => l.kind === "same").length;

test("within MAX_CELLS the middle keeps its common lines; past it, all removed then all added", () => {
  expect(MAX_CELLS).toBe(1_000_000);
  // 1,000 × 999 cells (the last line is shared, so trimmed): within the budget
  expect(sameInMiddle(lineDiff(alternating(1000, "old"), alternating(1000, "new")))).toBeGreaterThan(400);
  // 1,001 × 1,001: past it
  const past = lineDiff(alternating(1001, "old"), alternating(1001, "new"));
  expect(sameInMiddle(past)).toBe(0);
  expect(past.filter((l) => l.kind === "del")).toHaveLength(1001);
  expect(past.findLastIndex((l) => l.kind === "del")).toBeLessThan(past.findIndex((l) => l.kind === "add"));
});

test("2,000 × 2,000 lines, 4 million cells: the fallback's shape, quickly", () => {
  const t0 = performance.now();
  const change = fileChange("Edit", JSON.stringify({ file_path: "x", old_string: alternating(2000, "old"), new_string: alternating(2000, "new") }));
  const ms = performance.now() - t0;
  const lines = change?.kind === "edit" ? (change.hunks[0] ?? []) : [];
  // the last line is shared (trimmed); every other line of the 1,999 left is too, but no LCS ran
  expect(change).toMatchObject({ added: 1999, removed: 1999 });
  expect(lines.slice(0, 1999).every((l) => l.kind === "del")).toBe(true);
  expect(lines.slice(1999, -1).every((l) => l.kind === "add")).toBe(true);
  expect(lines.at(-1)).toEqual({ kind: "same", text: "same 1999" });
  expect(ms).toBeLessThan(250);
});

test("one budget for the whole call: a MultiEdit's later hunks fall back once its earlier ones spent it", () => {
  const edit = { old_string: alternating(800, "old"), new_string: alternating(800, "new") };
  const change = fileChange("MultiEdit", JSON.stringify({ file_path: "x", edits: [edit, edit] }));
  const hunks = change?.kind === "edit" ? change.hunks : [];
  expect(hunks).toHaveLength(2);
  expect(sameInMiddle(hunks[0] ?? [])).toBeGreaterThan(300); // 640,000 cells: within the budget
  expect(sameInMiddle(hunks[1] ?? [])).toBe(0); // 640,000 more: past it
});
