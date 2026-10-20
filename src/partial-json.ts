// JSON as a model writes it: a tool call's input, read while it streams. Pure readers, shared by
// the server's artifact drafts (src/artifacts/draft.ts) and the web's file diffs
// (web/src/lib/diff.ts, through src/wire.ts), so the two read a cut text alike. A string is decoded
// as far as its escapes are whole; a `\u` without four hex digits is U+FFFD, as JSON.parse would
// refuse it and a draft shouldn't stop on it.
import type { Schema } from "effect";

const ESCAPES = new Map([
  ['"', '"'],
  ["\\", "\\"],
  ["/", "/"],
  ["b", "\b"],
  ["f", "\f"],
  ["n", "\n"],
  ["r", "\r"],
  ["t", "\t"],
]);
const HEX4 = /^[0-9a-fA-F]{4}$/;

// A JSON string's body as far as it was read: its text, where reading stopped (`end`), and whether
// its closing quote was there (`closed`)
export type StringRead = { readonly text: string; readonly end: number; readonly closed: boolean };

// The body of a JSON string from `pos` (just past its opening quote), decoded as far as the text
// goes. `end` is past the closing quote when `closed`, else before an escape cut short, which waits
// for the rest of it.
export function stringAt(raw: string, pos: number): StringRead {
  let text = "";
  let at = pos;
  while (at < raw.length) {
    const c = raw[at] ?? "";
    if (c === '"') return { closed: true, end: at + 1, text };
    if (c !== "\\") {
      text += c;
      at++;
      continue;
    }
    const e = raw[at + 1];
    if (e === undefined) break;
    if (e === "u") {
      if (at + 6 > raw.length) break;
      const hex = raw.slice(at + 2, at + 6);
      text += HEX4.test(hex) ? String.fromCodePoint(Number.parseInt(hex, 16)) : "\uFFFD";
      at += 6;
      continue;
    }
    text += ESCAPES.get(e) ?? e;
    at += 2;
  }
  return { closed: false, end: at, text };
}

const LITERAL = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/;
const SPACE = " \t\n\r";

// The value at the start of `s`, read as far as the text goes: a string cut short is what it has
// so far, an object or an array cut short has the members that began in it, and a value that
// hasn't begun (or a number or a literal cut short, which may go on) is undefined. Whole JSON
// reads as JSON.parse would.
export function readPartial(s: string): Schema.Json | undefined {
  let i = 0;
  const space = () => {
    while (i < s.length && SPACE.includes(s[i] ?? "")) i++;
  };
  const string = () => {
    const read = stringAt(s, i + 1);
    i = read.closed ? read.end : s.length;
    return read.text;
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
      i = s.length;
      return undefined;
    }
    i += m[0].length;
    return m[0] === "true" ? true : m[0] === "false" ? false : m[0] === "null" ? null : Number(m[0]);
  };
  // the members of an array or an object up to `close`, or as far as the text goes
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
  // a key and its value; a key cut short, or one whose value hasn't begun, is none
  const pair = (): [string, Schema.Json] | undefined => {
    if (s[i] !== '"') {
      i = s.length;
      return undefined;
    }
    const key = stringAt(s, i + 1);
    if (!key.closed) {
      i = s.length;
      return undefined;
    }
    i = key.end;
    space();
    if (s[i] !== ":") return undefined;
    i++;
    const v = value();
    return v === undefined ? undefined : [key.text, v];
  };
  const object = () => Object.fromEntries(members("}", pair));
  return value();
}

// The text of each object (or array) in the array field `field` that the model has written whole so
// far, its closing brace in, each to be read on its own; none while the field hasn't begun
export function wholeItems(raw: string, field: string): string[] {
  const at = new RegExp(`"${field}"\\s*:\\s*\\[`).exec(raw);
  if (!at) return [];
  const items: string[] = [];
  let depth = 0;
  let from = -1;
  for (let k = at.index + at[0].length; k < raw.length; k++) {
    const c = raw[k];
    if (c === '"') {
      const read = stringAt(raw, k + 1);
      if (!read.closed) break;
      k = read.end - 1;
    } else if (c === "{" || c === "[") {
      if (depth === 0) from = k;
      depth++;
    } else if (c === "}" || c === "]") {
      if (depth === 0) break; // the array's own end
      depth--;
      if (depth === 0 && from >= 0) items.push(raw.slice(from, k + 1));
    }
  }
  return items;
}
