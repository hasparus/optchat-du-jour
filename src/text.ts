// Cutting text by length without splitting a character (SPEC "Constants and configuration"). A
// length here is in UTF-16 code units, as JavaScript counts a string, but a cut never falls
// between the two halves of a surrogate pair: a lone half is ill-formed text, which a provider
// may refuse outright (gist §7: what is logged is sent again on every later call). No imports, so
// the Grep worker can use it too.

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
