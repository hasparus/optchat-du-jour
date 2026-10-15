// A turn's thinking, kept beside the log and never in it (SPEC "Reasoning", E29). docs/optchat.md
// §7 lists logging thoughts as a mistake: what the log holds is the memory, summarized into the tree
// and sent to every later turn. This side file is none of that. Nothing that builds a view, a
// compaction, a request or zoom's answer reads it; only the web UI does, to show what the model
// thought before a reply or a tool call.
//
// `chat/reasoning/YYYY-MM-DD.jsonl` in the stream's dir, beside `main/` and `tree/`, split by local
// day as they are (each commit stores the day's file whole, so a day's file bounds that cost), one
// line per piece: `{i, text, engine, date, ms, cut?}`. `i` is the log index of the `talk` or `tool`
// entry the thinking came before; `ms` how long it ran (first token to that entry); `cut` how many
// characters past REASONING_PIECE or REASONING_TURN were left out, only when some were. Append-only,
// one write and one fsync per line, by the lock holder only. A write that fails is reported once
// per streak and never fails the turn. Reads go through an index of where each piece's line is, made
// at startup by reading the files once and kept as pieces are added: a request for the pieces of a
// range reads none of their text, and a request for one piece reads its one line.
import { Effect, Option, Schema } from "effect";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { appendLine, DAY_FILE } from "./store.ts";
import { dayOf } from "./tree.ts";
import type { ReasoningHead, ReasoningPiece } from "./wire.ts";

export const ReasoningRecord = Schema.Struct({
  i: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  text: Schema.String,
  engine: Schema.String,
  date: Schema.String,
  ms: Schema.Number,
  cut: Schema.optional(Schema.Int),
});
export type ReasoningRecord = typeof ReasoningRecord.Type;
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(ReasoningRecord));

// where in which day file a piece's line is, and its head
type Where = { readonly file: string; readonly offset: number; readonly length: number; readonly head: ReasoningHead };

export type Reasoning = {
  // adds a piece to the side file (when kept at all); never fails: a write that can't be made is reported
  readonly keep: (record: ReasoningRecord) => Effect.Effect<void>;
  // the pieces kept before entries from..to-1, oldest first, without their text
  readonly heads: (from: number, to: number) => readonly ReasoningHead[];
  // one piece with its text; null when none was kept before entry i, or its line can't be read
  readonly piece: (i: number) => Effect.Effect<ReasoningPiece | null>;
};

// the head of a record: what /api/reasoning says of it without its text
const headOf = (r: ReasoningRecord): ReasoningHead => ({ chars: r.text.length, cut: r.cut, engine: r.engine, i: r.i, ms: r.ms }); // JSON leaves `cut` out when undefined

// `len` bytes of `path` from `offset`
const readAt = (path: string, offset: number, len: number) => {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, offset);
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const NEWLINE = 0x0A;

// The index of the day files under `folder`: each line that decodes, by its entry; a later line for
// the same entry wins. A last line without its newline (a write a crash cut short) is ended with
// one, so the next append starts a line of its own; a line that doesn't decode is counted.
const indexOf = (folder: string, writer: boolean) => {
  const index = new Map<number, Where>();
  let damaged = 0;
  if (!existsSync(folder)) return { damaged, index };
  for (const day of readdirSync(folder).filter((name) => DAY_FILE.test(name)).toSorted()) {
    const file = `${folder}/${day}`;
    const raw = readFileSync(file);
    if (writer && raw.length > 0 && raw.at(-1) !== NEWLINE) appendLine(folder, day, "\n");
    let offset = 0;
    while (offset < raw.length) {
      const end = raw.indexOf(NEWLINE, offset);
      const stop = end === -1 ? raw.length : end;
      const line = raw.subarray(offset, stop).toString("utf8");
      if (line !== "") {
        const found = decodeRecord(line);
        if (Option.isSome(found)) index.set(found.value.i, { file, head: headOf(found.value), length: stop - offset, offset });
        else damaged++;
      }
      offset = stop + 1;
    }
  }
  return { damaged, index };
};

// The stream's side file in `dir` (the stream's data dir). `keep`: whether new pieces are written
// (reasoning.keep); the ones already there are served either way. `writer`: this process holds the
// stream's lock (only it repairs or writes).
export const openReasoning = (dir: string, o: { readonly keep: boolean; readonly writer?: boolean; readonly report: (message: string) => Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const folder = `${dir}/chat/reasoning`;
    const writer = o.writer ?? true;
    const read = yield* Effect.try({ catch: (e) => (e instanceof Error ? e.message : String(e)), try: () => indexOf(folder, writer) }).pipe(
      Effect.catch((error) => o.report(`reasoning: cannot read ${folder} (${error}); the thinking kept there doesn't show`).pipe(Effect.as({ damaged: 0, index: new Map<number, Where>() }))),
    );
    const { index } = read;
    if (read.damaged > 0) yield* o.report(`reasoning: ${read.damaged} unreadable lines in ${folder}, ignored`);
    let failing = false;

    const keep = (record: ReasoningRecord): Effect.Effect<void> =>
      !o.keep || !writer
        ? Effect.void
        : Effect.try({
            catch: (e) => (e instanceof Error ? e.message : String(e)),
            try: () => {
              const day = `${dayOf(new Date(record.date))}.jsonl`;
              const file = `${folder}/${day}`;
              const line = JSON.stringify(Schema.encodeSync(ReasoningRecord)(record));
              const offset = existsSync(file) ? statSync(file).size : 0;
              appendLine(folder, day, `${line}\n`);
              index.set(record.i, { file, head: headOf(record), length: Buffer.byteLength(line), offset });
            },
          }).pipe(
            Effect.matchEffect({
              onFailure: (why) => (failing ? Effect.void : Effect.sync(() => (failing = true)).pipe(Effect.andThen(o.report(`reasoning: the thinking before entry ${record.i} was not kept (${why}); the turn goes on`)))),
              onSuccess: () => Effect.sync(() => (failing = false)),
            }),
          );

    const heads = (from: number, to: number) => {
      const out: ReasoningHead[] = [];
      for (let i = Math.max(0, from); i < to; i++) {
        const at = index.get(i);
        if (at) out.push(at.head);
      }
      return out;
    };

    const piece = (i: number): Effect.Effect<ReasoningPiece | null> =>
      Effect.sync(() => {
        const at = index.get(i);
        if (!at) return null;
        try {
          const found = decodeRecord(readAt(at.file, at.offset, at.length));
          return Option.isSome(found) && found.value.i === i ? { ...headOf(found.value), date: found.value.date, text: found.value.text } : null;
        } catch {
          return null;
        }
      });

    return { heads, keep, piece } satisfies Reasoning;
  });

// for a session with no side file (tests, a reader): nothing is kept or found
export const noReasoning: Reasoning = { heads: () => [], keep: () => Effect.void, piece: () => Effect.succeed(null) };
