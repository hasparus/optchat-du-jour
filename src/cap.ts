// A tool result as the log keeps it (docs/optchat.md §1, ref §5.3), whichever engine ran the tool: Claude
// Code's tools or our own tool loop's (M5).
import { CAP } from "./config.ts";
import { headOf, tailOf } from "./text.ts";

// A tool result as the log keeps it: at most CAP characters, the head and the tail, with what
// was cut in between (docs/optchat.md §1, ref §5.3). Characters are UTF-16 code units, as the reference
// counts them, so a cut ASCII result is byte-identical to its; but neither cut splits a surrogate
// pair, and N counts every unit left out. A lone surrogate the tool itself wrote becomes U+FFFD:
// the log is sent to models again and again, and must stay well-formed text.
export function cap(full: string): string {
  return clipMiddle(full.toWellFormed(), CAP, (cut) => `[… ${cut} chars cut …]`);
}

// A text longer than `limit` characters as its head and its tail, half each, neither cut inside a
// character, with a line between them that `note` writes from how many characters were left out
// and where they began; the text itself when it fits. cap() and a compaction's leaf (E49) cut so.
export function clipMiddle(text: string, limit: number, note: (cut: number, at: number) => string): string {
  if (text.length <= limit) return text;
  const head = headOf(text, limit / 2), tail = tailOf(text, limit / 2);
  return `${head}\n${note(text.length - head.length - tail.length, head.length)}\n${tail}`;
}
