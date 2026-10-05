// The terminal's raw input as keys (ref §10): printable text, Enter, Backspace, Ctrl-U, Ctrl-C,
// Ctrl-D, Ctrl-Z and bracketed pastes, from chunks cut anywhere, even inside a marker or a
// character. A paste is one piece of text with its newlines; any other sequence is dropped.
export type Key =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "enter" | "backspace" | "clear" | "interrupt" | "eof" | "suspend" };

const PASTE_START = "\u001B[200~";
const PASTE_END = "\u001B[201~";
const CONTROL: Record<string, Key> = {
  "\u0003": { type: "interrupt" },
  "\u0004": { type: "eof" },
  "\u0008": { type: "backspace" },
  "\u0015": { type: "clear" },
  "\u001A": { type: "suspend" },
  "\r": { type: "enter" },
  "\n": { type: "enter" },
  "\u007F": { type: "backspace" },
};

// the end of an escape sequence: CSI (ESC [ ... final byte), SS3 (ESC O x), or ESC and one char
function escapeLength(s: string, at: number): number | null {
  if (at + 1 >= s.length) return null;
  const next = s[at + 1];
  if (next === "[") {
    for (let k = at + 2; k < s.length; k++) {
      const c = s.charCodeAt(k);
      if (c >= 0x40 && c <= 0x7e) return k - at + 1;
    }
    return null;
  }
  if (next === "O") return at + 2 < s.length ? 3 : null;
  return 2;
}

export function makeKeys() {
  const decoder = new TextDecoder();
  let buf = "", paste: string | null = null;
  return (chunk: Uint8Array): Key[] => {
    buf += decoder.decode(chunk, { stream: true });
    const keys: Key[] = [];
    let text = "";
    const flush = () => {
      if (text) keys.push({ text, type: "text" });
      text = "";
    };
    for (;;) {
      if (paste !== null) {
        const end = buf.indexOf(PASTE_END);
        if (end < 0) {
          // keep what could be the start of the end marker
          const keep = [...Array(PASTE_END.length).keys()].findLast((k) => k > 0 && buf.endsWith(PASTE_END.slice(0, k))) ?? 0;
          paste += buf.slice(0, buf.length - keep);
          buf = buf.slice(buf.length - keep);
          break;
        }
        keys.push({ text: (paste + buf.slice(0, end)).replaceAll(/\r\n?/g, "\n"), type: "paste" });
        buf = buf.slice(end + PASTE_END.length);
        paste = null;
        continue;
      }
      if (!buf) break;
      const c = buf[0] ?? "";
      if (c === "\u001B") {
        if (buf.startsWith(PASTE_START)) {
          flush();
          paste = "";
          buf = buf.slice(PASTE_START.length);
          continue;
        }
        if (PASTE_START.startsWith(buf)) break; // maybe a paste marker cut short: wait for more
        const n = escapeLength(buf, 0);
        if (n === null) break;
        buf = buf.slice(n); // arrows and the rest: dropped
        continue;
      }
      const control = CONTROL[c];
      if (control) {
        flush();
        // CRLF is one Enter
        keys.push(control);
        buf = buf.slice(c === "\r" && buf[1] === "\n" ? 2 : 1);
        continue;
      }
      buf = buf.slice(1);
      if (c >= " " || c === "\t") text += c;
    }
    flush();
    return keys;
  };
}
