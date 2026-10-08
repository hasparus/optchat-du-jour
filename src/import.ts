// `optchat import-optmem` (ref §10): OptMem's notes become the first messages of an empty chat,
// kind `note`, each at noon local time on its day.
import { Data, Effect } from "effect";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildFree } from "./compactor.ts";
import { appendMessage, appendNode, loadChat, lock, newMsg, saveView } from "./store.ts";
import type { Node } from "./records.ts";
import { dayOf, setNode } from "./tree.ts";
import { refold } from "./view.ts";

// where OptMem keeps its notes (ref §10)
export const OPTMEM_LOG = join(homedir(), ".optmem", "memory", "LOG.txt");

export class ImportError extends Data.TaggedError("ImportError")<{ readonly message: string }> {}

export type Note = { readonly n: number; readonly date: Date; readonly text: string };

// `#<n> <YYYY-MM-DD> <text>` (ref §10); the record's padding is trimmed off the text later
const RECORD = /^#([0-9]+) ([0-9-]{10}) (.*)$/s;

// the day a note was written, at noon local time, or null when the date names no real day
function noon(day: string): Date | null {
  const parts = day.split("-").map(Number);
  const [year = 0, month = 0, date = 0] = parts;
  const at = new Date(year, month - 1, date, 12);
  return parts.length === 3 && dayOf(at) === day ? at : null;
}

// LOG.txt holds one record per line. Nothing is written until the whole file has parsed; the
// first problem throws.
export function parseOptmem(raw: string): Note[] {
  const notes: Note[] = [];
  for (const [k, line] of raw.split("\n").entries()) {
    if (line.trim() === "") continue;
    const where = `LOG.txt line ${k + 1}`;
    const fields = RECORD.exec(line);
    if (fields === null) throw new ImportError({ message: `${where}: no #<n> <date> <text> record here` });
    const [n = "", day = "", text = ""] = fields.slice(1);
    if (Number(n) !== notes.length) throw new ImportError({ message: `${where}: note #${n} where #${notes.length} should be` });
    const date = noon(day);
    if (date === null) throw new ImportError({ message: `${where}: ${day} is not a calendar date` });
    notes.push({ date, n: notes.length, text: text.trim() });
  }
  return notes;
}

// Into an empty chat only, under the lock. The free nodes are built at once, so the chat reads
// well before the compactor ever runs. Everything is written first and the view folded once at
// the end, as appending every note would fold it, then saved: refitting it after every note and
// every node made a 10k-note import quadratic.
export const importOptmem = (dir: string, path = OPTMEM_LOG) =>
  Effect.scoped(
    Effect.gen(function* () {
      const notes = yield* Effect.try({
        catch: (e) => (e instanceof ImportError ? e : new ImportError({ message: `cannot read ${path}: ${String(e)}` })),
        try: () => parseOptmem(readFileSync(path, { encoding: "utf8" })),
      });
      yield* lock(dir);
      const { mem } = yield* loadChat(dir);
      const present = mem.root.length;
      if (present !== 0) return yield* new ImportError({ message: `refusing to import: ${dir} is not empty (${present} messages logged)` });
      for (const note of notes) {
        const entry = newMsg(note.n, "note", note.text, note.date);
        yield* appendMessage(dir, entry);
        mem.root.push(entry);
      }
      // saved and kept, not fitted: the fold below sees them all
      const keep = (n: Node) =>
        Effect.gen(function* () {
          yield* appendNode(dir, n);
          setNode(mem, n);
        });
      yield* buildFree(mem, keep);
      refold(mem);
      yield* saveView(dir, mem);
      return mem;
    }),
  );
