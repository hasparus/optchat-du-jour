// A tool result as the log keeps it (gist §7, ref §5.3), whichever engine ran the tool: Claude
// Code's tools or our own tool loop's (M5).
import { CAP } from "./config.ts";

// A tool result as the log keeps it: at most CAP characters, the head and the tail, with what
// was cut in between (gist §7, ref §5.3).
export function cap(full: string): string {
  const over = full.length - CAP;
  if (over <= 0) return full;
  const keep = CAP / 2;
  const head = full.slice(0, keep), tail = full.slice(full.length - keep);
  return `${head}\n[… ${over} chars cut …]\n${tail}`;
}
