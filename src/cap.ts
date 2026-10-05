// A tool result as the log keeps it (gist §7, ref §5.3), whichever engine ran the tool: Claude
// Code's tools or our own tool loop's (M5).
import { CAP } from "./config.ts";
import { headOf, tailOf } from "./text.ts";

// A tool result as the log keeps it: at most CAP characters, the head and the tail, with what
// was cut in between (gist §7, ref §5.3). Characters are UTF-16 code units, as the reference
// counts them, so a cut ASCII result is byte-identical to its; but neither cut splits a surrogate
// pair, and N counts every unit left out. A lone surrogate the tool itself wrote becomes U+FFFD:
// the log is sent to models again and again, and must stay well-formed text.
export function cap(full: string): string {
  const text = full.toWellFormed();
  if (text.length <= CAP) return text;
  const head = headOf(text, CAP / 2), tail = tailOf(text, CAP / 2);
  return `${head}\n[… ${text.length - head.length - tail.length} chars cut …]\n${tail}`;
}
