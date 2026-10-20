// What a file tool's call changes (lib/diff.ts): its input read as far as it has streamed, the line
// diff of an Edit, the hunks of a MultiEdit, a Write's new file; any other tool has none.
import { expect, test } from "bun:test";
import { fileChange, lineDiff, readPartial } from "./diff";

// in the order Claude Code writes its keys: the old text streams before the new one
const EDIT = { file_path: "src/a.ts", old_string: "const a = 1;\nconst b = 2;\nconst c = 3;\n", new_string: 'const a = 1;\nconst b = "two";\nconst c = 3;\n' };

test("a JSON text is read as far as it goes: a string cut short as it has come, what hasn't begun left out", () => {
  const whole = { ...EDIT, n: 12.5, ok: true, no: null, list: [1, "x", { deep: false }] };
  expect(readPartial(JSON.stringify(whole))).toEqual(whole);
  expect(readPartial(String.raw`{"file_path":"src/a.ts","old_string":"line one\nli`)).toEqual({ file_path: "src/a.ts", old_string: "line one\nli" });
  expect(readPartial('{"file_path":"src/a.ts","old_')).toEqual({ file_path: "src/a.ts" });
  expect(readPartial('{"file_path":"src/a.ts","old_string":')).toEqual({ file_path: "src/a.ts" });
  expect(readPartial('{"a":"x\\')).toEqual({ a: "x" }); // a dangling escape
  expect(readPartial(String.raw`{"a":"\u00e9\u00`)).toEqual({ a: "é" });
  expect(readPartial(String.raw`{"a":"\"quoted\" \t tab"}`)).toEqual({ a: '"quoted" \t tab' });
  expect(readPartial('{"n":12')).toEqual({}); // a number that may go on
  expect(readPartial('{"edits":[{"old_string":"a","new_string":"b"},{"old_string":"c')).toEqual({ edits: [{ new_string: "b", old_string: "a" }, { old_string: "c" }] });
  expect(readPartial("")).toBeUndefined();
});

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
  expect(fileChange("Write", JSON.stringify({ content: "one\ntwo\nthree\n", file_path: "n.txt" }))).toEqual({ content: "one\ntwo\nthree\n", kind: "write", lines: 3, path: "n.txt", whole: true });
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
  expect(writing).toMatchObject({ kind: "write", lines: 3, whole: false });
});
