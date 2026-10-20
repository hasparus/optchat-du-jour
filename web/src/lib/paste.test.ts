// Long pastes, folded (lib/paste.ts): which ones fold, their tokens, the text sent (exactly what was
// pasted, where it was pasted), and the parts a sent message folds into.
import { expect, test } from "bun:test";
import { expand, FOLD_BYTES, FOLD_LINES, foldParts, folds, insert, lineCount, nextId, present, removeToken, sizeOf, tokenOf } from "./paste";

const lines = (n: number) => Array.from({ length: n }, (_, k) => `line ${k + 1}`).join("\n");

test("a paste folds past 40 lines or past 4 KB; a final newline ends a line, it doesn't add one", () => {
  expect([FOLD_LINES, FOLD_BYTES]).toEqual([40, 4096]);
  expect(lineCount(lines(40))).toBe(40);
  expect(lineCount(`${lines(40)}\n`)).toBe(40);
  expect(folds(lines(40))).toBe(false);
  expect(folds(`${lines(40)}\n`)).toBe(false);
  expect(folds(lines(41))).toBe(true);
  expect(folds("x".repeat(4096))).toBe(false);
  expect(folds("x".repeat(4097))).toBe(true);
  expect(folds("é".repeat(2049))).toBe(true); // bytes, not characters: 4098 of them
  expect(sizeOf(lines(120))).toBe("120 lines");
  expect(sizeOf("x".repeat(5000))).toBe("4.9 KB");
});

test("a token stands for its paste; the text sent has each paste where its token was, and says where", () => {
  const a = { id: 1, text: lines(50) };
  const b = { id: 2, text: "x".repeat(5000) };
  expect(tokenOf(a)).toBe("[Pasted text #1, 50 lines]");
  const typed = `look at this:\n${tokenOf(a)}\nand ${tokenOf(b)} too`;
  expect(present(typed, [b, a])).toEqual([a, b]); // in the text's order
  const sent = expand(typed, [a, b]);
  expect(sent.text).toBe(`look at this:\n${a.text}\nand ${b.text} too`);
  expect(sent.spans.map(([s, e]) => sent.text.slice(s, e))).toEqual([a.text, b.text]);
  // a token typed over, or one whose paste is gone, is text like any other
  const edited = `${tokenOf(a).slice(0, -2)}] ${tokenOf({ id: 9, text: lines(50) })}`;
  expect(present(edited, [a])).toEqual([]);
  expect(expand(edited, [a]).text).toBe(edited);
  expect(expand("no pastes", [a])).toEqual({ spans: [], text: "no pastes" });
});

test("inserted over the selection with the caret after it; removed with its token; ids go up", () => {
  expect(insert("abcdef", 2, 4, "[T]")).toEqual({ caret: 5, text: "ab[T]ef" });
  const p = { id: 3, text: lines(41) };
  expect(removeToken(`before ${tokenOf(p)} after`, p)).toBe("before  after");
  expect(nextId([])).toBe(1);
  expect(nextId([p, { id: 1, text: "" }])).toBe(4);
});

test("a message from this browser folds its pasted blocks only; any other folds whole when that long, unless it is a report", () => {
  const block = lines(60);
  const text = `see:\n${block}\nthanks`;
  const at = text.indexOf(block);
  expect(foldParts(text, [[at, at + block.length]])).toEqual([
    { kind: "plain", text: "see:\n" },
    { kind: "pasted", text: block },
    { kind: "plain", text: "\nthanks" },
  ]);
  // sent from here with no paste: a long typed message stays as typed
  expect(foldParts(text, [])).toEqual([{ kind: "plain", text }]);
  // from elsewhere: whole
  expect(foldParts(text, null)).toEqual([{ kind: "long", text }]);
  expect(foldParts("short", null)).toEqual([{ kind: "plain", text: "short" }]);
  // a subagent's report, however long, never folds; a bracket that names no subagent does
  expect(foldParts(`[scout] ${block}`, null)).toEqual([{ kind: "plain", text: `[scout] ${block}` }]);
  expect(foldParts(`[not a name] ${block}`, null)[0]?.kind).toBe("long");
  // spans past the text, or overlapping, are not this text's
  expect(foldParts("short", [[0, 99]])).toEqual([{ kind: "plain", text: "short" }]);
  expect(foldParts(text, [[at, at + block.length], [at + 1, at + 5]]).filter((p) => p.kind === "pasted")).toHaveLength(1);
});
