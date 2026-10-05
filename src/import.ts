// import-optmem (ref §10). LOG.txt holds fixed-width records, space padded: `#<n> <YYYY-MM-DD> <text>`.
// Note n becomes message n, kind note, at 12:00 local time on its day: a fixed, recognizably
// synthetic time. Only into an empty chat; a file that doesn't parse whole writes nothing.
import { Data, Effect } from "effect";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { committer } from "./chat.ts";
import { buildFree } from "./compactor.ts";
import { appendMessage, loadChat, lock, newMsg, StoreError } from "./store.ts";
import { addMessage } from "./view.ts";

export const OPTMEM_LOG = `${homedir()}/.optmem/memory/LOG.txt`;

export class ImportError extends Data.TaggedError("ImportError")<{ readonly message: string }> {}

export type Note = { readonly date: Date; readonly n: number; readonly text: string };

export function parseOptmem(raw: string): Note[] {
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, k) => {
    const m = /^#(\d+) (\d{4})-(\d{2})-(\d{2}) (.*)$/.exec(line);
    if (!m) throw new Error(`line ${k + 1} is not "#<n> <YYYY-MM-DD> <text>"`);
    const [n, y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    if (n !== k) throw new Error(`line ${k + 1}: ids must be contiguous from 0, expected #${k}, found #${n}`);
    const date = new Date(y, mo - 1, d, 12);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d)
      throw new Error(`line ${k + 1}: bad date ${m[2]}-${m[3]}-${m[4]}`);
    return { date, n, text: (m[5] ?? "").trim() };
  });
}

export const importOptmem = Effect.fn("importOptmem")(function* (dir: string, path: string = OPTMEM_LOG) {
  const notes = yield* Effect.try({
    catch: (e) => new ImportError({ message: e instanceof Error ? e.message : String(e) }),
    try: () => parseOptmem(readFileSync(path, "utf8")),
  });
  yield* lock(dir);
  const { mem } = yield* loadChat(dir);
  if (mem.root.length > 0)
    return yield* new StoreError({ message: `${dir} already holds ${mem.root.length} messages: import only into an empty chat` });
  for (const note of notes) {
    const m = newMsg(note.n, "note", note.text, note.date);
    yield* appendMessage(dir, m);
    addMessage(mem, m);
  }
  yield* buildFree(mem, committer(dir, mem)); // so the chat reads at once
  return mem;
}, Effect.scoped);
