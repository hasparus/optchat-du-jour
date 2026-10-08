// Cutting text by length without splitting a character (SPEC "Constants and configuration"). A
// length here is in UTF-16 code units, as JavaScript counts a string, but a cut never falls
// between the two halves of a surrogate pair: a lone half is ill-formed text, which a provider
// may refuse outright (docs/optchat.md §1: what is logged is sent again on every later call). No runtime imports, so
// the Grep worker can use it too (the one type import is erased).
import type { Schema } from "effect";

// whether the code unit at `k` begins a surrogate pair, so a cut just after it would split one
const pairAt = (text: string, k: number) => k >= 0 && (text.codePointAt(k) ?? 0) > 0xFF_FF;

// the first `n` code units of `text`, one fewer when the last of them begins a surrogate pair
export const headOf = (text: string, n: number): string => {
  if (n >= text.length) return text;
  const end = Math.max(0, n);
  return text.slice(0, pairAt(text, end - 1) ? end - 1 : end);
};

// the last `n` code units of `text`, one fewer when the first of them ends a surrogate pair
export const tailOf = (text: string, n: number): string => {
  if (n >= text.length) return text;
  if (n <= 0) return "";
  const start = text.length - n;
  return text.slice(pairAt(text, start - 1) ? start + 1 : start);
};

// JSON for a model's wire, every string in it made well-formed first: a lone surrogate becomes
// U+FFFD. JSON.stringify alone would write it as a \udXXX escape, which the provider decodes back
// into the ill-formed text it refuses. Each encoder of what a model reads goes through this one
// place (Anthropic's and the Responses API's request bodies, claude's stream-json input, the MCP
// answers), so a line logged before cap() kept pairs whole, or a message that arrived with a lone
// half, can't wedge the pump or a turn. Well-formed text is unchanged, so no cached prefix moves.
// SAFETY: the replacer sees each value of an already-typed Json; its strings are the only ones to change.
// oxlint-disable-next-line anti-slop/no-runtime-typeof
export const wireJson = (value: Schema.Json): string => JSON.stringify(value, (_key, v: Schema.Json) => (typeof v === "string" ? v.toWellFormed() : v));
