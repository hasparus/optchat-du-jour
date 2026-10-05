// The terminal's raw input as keys (ref §10): printable text, Enter, Backspace, Ctrl-U, Ctrl-C,
// Ctrl-D, Ctrl-Z and bracketed pastes, from chunks cut anywhere, even inside a marker or a
// character. A paste is one piece of text with its newlines; any other sequence is dropped.
export type Key =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "backspace" | "clear" | "enter" | "eof" | "interrupt" | "suspend" };

const PASTE_START = "\u001B[200~";
const PASTE_END = "\u001B[201~";
const CONTROL = new Map<string, Key>([
  ["\u0003", { type: "interrupt" }],
  ["\u0004", { type: "eof" }],
  ["\u0008", { type: "backspace" }],
  ["\u0015", { type: "clear" }],
  ["\u001A", { type: "suspend" }],
  ["\r", { type: "enter" }],
  ["\n", { type: "enter" }],
  ["\u007F", { type: "backspace" }],
]);

// the end of an escape sequence: CSI (ESC [ ... final byte), SS3 (ESC O x), or ESC and one char
function escapeLength(s: string, at: number): number | null {
  if (at + 1 >= s.length) return null;
  const next = s[at + 1];
  if (next === "[") {
    for (let k = at + 2; k < s.length; k++) {
      const c = s.codePointAt(k) ?? 0;
      if (c >= 0x40 && c <= 0x7E) return k - at + 1;
    }
    return null;
  }
  if (next === "O") return at + 2 < s.length ? 3 : null;
  return 2;
}

// what is left after the control keys: tab and everything from space up; other C0 bytes are dropped
const printable = (ch: string) => ch === "\t" || (ch.codePointAt(0) ?? 0) > 0x1F;

export function makeKeys() {
  let buf = ""; // decoded, not yet turned into keys
  let paste: string | null = null; // inside a bracketed paste: its text so far
  const decoder = new TextDecoder(); // keeps a character cut between two chunks
  return (chunk: Uint8Array): Key[] => {
    buf += decoder.decode(chunk, { stream: true });
    const keys: Key[] = [];
    // typed characters in a row become one text key: a new one is joined to a text key just before it
    const typed = (ch: string) => {
      const last = keys.at(-1);
      if (last?.type === "text") keys[keys.length - 1] = { text: last.text + ch, type: "text" };
      else keys.push({ text: ch, type: "text" });
    };
    for (;;) {
      if (paste !== null) {
        const end = buf.indexOf(PASTE_END);
        if (end === -1) {
          // keep what could be the start of the end marker
          const keep = Array.from({ length: PASTE_END.length }, (_, k) => k).findLast((k) => k > 0 && buf.endsWith(PASTE_END.slice(0, k))) ?? 0;
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
      const key = CONTROL.get(c);
      if (key) {
        // CRLF is one Enter
        keys.push(key);
        buf = buf.slice(c === "\r" && buf[1] === "\n" ? 2 : 1);
        continue;
      }
      buf = buf.slice(1);
      if (printable(c)) typed(c);
    }
    return keys;
  };
}
