// JSON as a model writes it (src/partial-json.ts), read by the server's artifact drafts and the
// web's file diffs alike: a string decoded as far as its escapes are whole, a value read as far as
// the text goes, the whole items of an array field so far; a bad \u is U+FFFD everywhere.
import { expect, test } from "bun:test";
import { fieldExtractor } from "../src/artifacts/draft.ts";
import { readPartial, stringAt, wholeItems } from "../src/partial-json.ts";

// a fixture with "~" for each backslash, so escapes read as the model writes them
const raw = (s: string) => s.replaceAll("~", "\\");

test("a string is decoded as far as its escapes are whole; one cut inside an escape waits for the rest", () => {
  expect(stringAt(raw('ab~ncd"rest'), 0)).toEqual({ closed: true, end: 7, text: "ab\ncd" });
  expect(stringAt(raw("ab~"), 0)).toEqual({ closed: false, end: 2, text: "ab" });
  expect(stringAt(raw("~u00e9~u00"), 0)).toEqual({ closed: false, end: 6, text: "\u00E9" });
  expect(stringAt(raw('~ud83d~ude00"'), 0).text).toBe("\u{1F600}"); // a surrogate pair from two escapes
  expect(stringAt(raw('x~uzzzzy"'), 0).text).toBe("x\uFFFDy");
  expect(stringAt(raw('~"q~" ~/ ~t"'), 0).text).toBe('"q" / \t');
});

test("a value is read as far as the text goes: a string cut short as it has come, what hasn't begun left out", () => {
  const whole = { file_path: "src/a.ts", old_string: "a\nb", new_string: 'say "hi"', n: 12.5, ok: true, no: null, list: [1, "x", { deep: false }] };
  expect(readPartial(JSON.stringify(whole))).toEqual(whole);
  expect(readPartial(raw('{"file_path":"src/a.ts","old_string":"line one~nli'))).toEqual({ file_path: "src/a.ts", old_string: "line one\nli" });
  expect(readPartial('{"file_path":"src/a.ts","old_')).toEqual({ file_path: "src/a.ts" });
  expect(readPartial('{"file_path":"src/a.ts","old_string":')).toEqual({ file_path: "src/a.ts" });
  expect(readPartial(raw('{"a":"x~'))).toEqual({ a: "x" });
  expect(readPartial(raw('{"a":"x~uzzzz"}'))).toEqual({ a: "x\uFFFD" });
  expect(readPartial('{"n":12')).toEqual({}); // a number that may go on
  expect(readPartial('{"edits":[{"old_string":"a","new_string":"b"},{"old_string":"c')).toEqual({ edits: [{ new_string: "b", old_string: "a" }, { old_string: "c" }] });
  expect(readPartial("")).toBeUndefined();
});

test("an array field's items, each once it is whole; strings with brackets and escaped quotes in them don't confuse it", () => {
  const text = raw('{"name":"x","edits":[{"old":"a{","new":"B}"},{"old":"~"]","new":"[c"},{"old":"d","new":"e');
  expect(wholeItems(text, "edits")).toEqual(['{"old":"a{","new":"B}"}', raw('{"old":"~"]","new":"[c"}')]);
  expect(wholeItems('{"name":"x","ed', "edits")).toEqual([]);
  expect(wholeItems('{"edits":[{"a":1}],"more":[{"b":2}]}', "edits")).toEqual(['{"a":1}']);
});

test("an artifact's draft decodes a bad unicode escape as U+FFFD too, piece by piece", () => {
  let html = "";
  const feed = fieldExtractor("html", (chunk) => {
    html += chunk;
  });
  for (const piece of [raw('{"html":"<p>x~u'), "zz", 'zz y</p>"}']) feed(piece);
  expect(html).toBe("<p>x\uFFFD y</p>");
});
