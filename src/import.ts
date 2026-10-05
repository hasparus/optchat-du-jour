// `optchat import-optmem` (ref §10): OptMem's notes become the first messages of an empty chat,
// kind `note`, each at noon local time on its day.
import { Data, Effect } from "effect";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { committer } from "./chat.ts";
import { buildFree } from "./compactor.ts";
import { appendMessage, loadChat, lock, newMsg } from "./store.ts";
import { addMessage } from "./view.ts";

export const OPTMEM_LOG = `${homedir()}/.optmem/memory/LOG.txt`;

export class ImportError extends Data.TaggedError("ImportError")<{ readonly message: string }> {}

export type Note = { readonly n: number; readonly date: Date; readonly text: string };

const RECORD = /^#(\d+) (\d{4})-(\d{2})-(\d{2}) (.*)$/s;

// LOG.txt: one `#<n> <YYYY-MM-DD> <text>` record per line, padded with spaces. Throws on the
// first thing that is off, before anything is written.
export function parseOptmem(raw: string): Note[] {
  const notes: Note[] = [];
  for (const [k, line] of raw.split("\n").entries()) {
    if (!line.trim()) continue;
    const m = RECORD.exec(line);
    if (!m) throw new ImportError({ message: `line ${k + 1}: not an OptMem record` });
    const [n = "", y = "", mo = "", d = "", text = ""] = m.slice(1);
    if (Number(n) !== notes.length) throw new ImportError({ message: `line ${k + 1}: expected #${notes.length}, found #${n}` });
    const date = new Date(Number(y), Number(mo) - 1, Number(d), 12);
    if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(mo) - 1 || date.getDate() !== Number(d))
      throw new ImportError({ message: `line ${k + 1}: bad date ${y}-${mo}-${d}` });
    notes.push({ date, n: notes.length, text: text.trim() });
  }
  return notes;
}

// into an empty chat only, under the lock; the free nodes are built at once, so the chat reads
// well before the compactor ever runs
export const importOptmem = (dir: string, path = OPTMEM_LOG) =>
  Effect.scoped(
    Effect.gen(function* () {
      const notes = yield* Effect.try({
        catch: (e) => (e instanceof ImportError ? e : new ImportError({ message: `cannot read ${path}: ${String(e)}` })),
        try: () => parseOptmem(readFileSync(path, "utf8")),
      });
      yield* lock(dir);
      const { mem } = yield* loadChat(dir);
      if (mem.root.length > 0) return yield* new ImportError({ message: `${dir} already holds ${mem.root.length} messages; import only into an empty chat` });
      for (const note of notes) {
        const m = newMsg(note.n, "note", note.text, note.date);
        yield* appendMessage(dir, m);
        addMessage(mem, m);
      }
      yield* buildFree(mem, committer(dir, mem));
      return mem;
    }),
  );
