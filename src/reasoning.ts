// A turn's thinking, kept beside the log and never in it (SPEC "Reasoning", E29). docs/optchat.md
// §7 lists logging thoughts as a mistake: what the log holds is the memory, summarized into the tree
// and sent to every later turn. This side file is none of that. Nothing that builds a view, a
// compaction, a request or zoom's answer reads it; only the web UI does, to show what the model
// thought before a reply or a tool call.
//
// Two parts. `makePieces` gathers what a run streams into one piece per reply or tool call it came
// before, under the caps (pure: the session wires it to its events and to the file). `openReasoning`
// is the file: `chat/reasoning/YYYY-MM-DD.jsonl` in the stream's dir, beside `main/` and `tree/`,
// split by local day as they are (each commit stores the day's file whole, so a day's file bounds
// that cost), one line per piece (`ReasoningPiece`, src/wire.ts). Append-only, one write and one
// fsync per line, by the lock holder (the server opens it after openChat took the lock). A write that
// fails is reported once per streak and never fails the turn. Reads go through an index of where each
// piece's line is, made at startup by reading the files once and kept as pieces are added: a request
// for the pieces of a range reads none of their text, and a request for one piece reads its one line.
import { Effect, Option, Schema } from "effect";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { REASONING_PIECE, REASONING_TURN } from "./config.ts";
import { appendLine, DAY_FILE } from "./store.ts";
import { headOf } from "./text.ts";
import { dayOf } from "./tree.ts";
import { type ReasoningHead, ReasoningPiece, toHead, withCut } from "./wire.ts";

// ---- the pieces of one run ----

// A piece of thinking: what streamed before the next reply or tool call of the run. `at`: the log
// index it was expected before when it began; `cut`: characters left out past the caps.
type Piece = { readonly at: number; readonly started: number; readonly engine: string; text: string; cut: number };

export type Pieces = {
  // A delta of thinking: what of it to stream (`taken` from `offset` of the piece at `at`), or
  // null when the caps leave none of it. `at` and `engine` are read when a piece begins: the log's
  // length then, the engine running. A new thought (`fresh`) in the same piece starts a paragraph.
  readonly add: (o: { readonly at: number; readonly engine: string; readonly now: number; readonly delta: string; readonly fresh: boolean }) => { readonly at: number; readonly offset: number; readonly taken: string } | null;
  // The entry `i` (a reply or a tool call) is logged: the piece it takes, as its side file record
  readonly take: (i: number, now: number) => { readonly at: number; readonly record: ReasoningPiece } | null;
  // The run logged nothing after it: the `at` of the piece dropped
  readonly drop: () => number | null;
  // the piece streaming now, for a client that joins mid-thought
  readonly live: () => { readonly at: number; readonly text: string } | null;
};

// One run's pieces: at most `piece` characters each and `turn` in all, the head of each kept and
// the rest counted in `cut` (never streamed, so a page shows live what it shows after a reload).
// A new run makes new pieces, so the turn's budget starts again.
export type Caps = { readonly piece: number; readonly turn: number };
const CAPS: Caps = { piece: REASONING_PIECE, turn: REASONING_TURN };
export const makePieces = (caps: Caps = CAPS): Pieces => {
  let open: Piece | null = null;
  let kept = 0; // characters kept by this run's finished pieces
  return {
    add: ({ at, delta, engine, fresh, now }) => {
      if (delta === "") return null;
      open ??= { at, cut: 0, engine, started: now, text: "" };
      const piece = open;
      const said = fresh && piece.text !== "" ? `\n\n${delta}` : delta;
      const room = Math.max(0, Math.min(caps.piece, caps.turn - kept) - piece.text.length);
      const taken = headOf(said, room);
      piece.cut += said.length - taken.length;
      if (taken === "") return null;
      const offset = piece.text.length;
      piece.text += taken;
      return { at: piece.at, offset, taken };
    },
    drop: () => {
      const at = open?.at ?? null;
      open = null;
      return at;
    },
    live: () => open && { at: open.at, text: open.text },
    take: (i, now) => {
      const piece = open;
      if (!piece) return null;
      open = null;
      kept += piece.text.length;
      const record = withCut({ date: new Date(now).toISOString(), engine: piece.engine, i, ms: Math.max(0, now - piece.started), text: piece.text }, piece.cut);
      return { at: piece.at, record };
    },
  };
};

// ---- the side file ----

const decodePiece = Schema.decodeUnknownOption(Schema.fromJsonString(ReasoningPiece));
const encodePiece = Schema.encodeSync(ReasoningPiece);

// where in which day file a piece's line is, and its head
type Where = { readonly file: string; readonly offset: number; readonly length: number; readonly head: ReasoningHead };

export type Reasoning = {
  // adds a piece to the side file (when kept at all); never fails: a write that can't be made is reported
  readonly keep: (record: ReasoningPiece) => Effect.Effect<void>;
  // the pieces kept before entries from..to-1, oldest first, without their text
  readonly heads: (from: number, to: number) => readonly ReasoningHead[];
  // one piece with its text; null when none was kept before entry i, or its line can't be read
  readonly piece: (i: number) => Effect.Effect<ReasoningPiece | null>;
};

const NEWLINE = 0x0A;

// `len` bytes of `path` from `offset`
const readAt = (path: string, offset: number, len: number) => {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, offset);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
};

// The index of the day files under `folder`: each line that decodes, by its entry; a later line for
// the same entry wins. A last line without its newline (a write a crash cut short) is ended with
// one, so the next append starts a line of its own; a line that doesn't decode is counted.
const indexOf = (folder: string) => {
  const index = new Map<number, Where>();
  let damaged = 0;
  if (!existsSync(folder)) return { damaged, index };
  for (const day of readdirSync(folder).filter((name) => DAY_FILE.test(name)).toSorted()) {
    const file = `${folder}/${day}`;
    const raw = readFileSync(file);
    if (raw.length > 0 && raw.at(-1) !== NEWLINE) appendLine(folder, day, "\n");
    let offset = 0;
    while (offset < raw.length) {
      const end = raw.indexOf(NEWLINE, offset);
      const stop = end === -1 ? raw.length : end;
      const line = raw.subarray(offset, stop).toString("utf8");
      if (line !== "") {
        const found = decodePiece(line);
        if (Option.isSome(found)) index.set(found.value.i, { file, head: toHead(found.value), length: stop - offset, offset });
        else damaged++;
      }
      offset = stop + 1;
    }
  }
  return { damaged, index };
};

// where the next line of `file` starts, and whether it must first end a line a failed write left
// unfinished (an ENOSPC halfway through): appended to it, the next piece would read back as one
// damaged line after a restart
const nextLine = (file: string) => {
  const size = existsSync(file) ? statSync(file).size : 0;
  const torn = size > 0 && readAt(file, size - 1, 1).at(0) !== NEWLINE;
  return { offset: torn ? size + 1 : size, prefix: torn ? "\n" : "" };
};

// The stream's side file in `dir` (the stream's data dir), for the lock holder. `keep`: whether new
// pieces are written (reasoning.keep); the ones already there are served either way.
export const openReasoning = (dir: string, o: { readonly keep: boolean; readonly report: (message: string) => Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const folder = `${dir}/chat/reasoning`;
    const read = yield* Effect.try({ catch: (e) => (e instanceof Error ? e.message : String(e)), try: () => indexOf(folder) }).pipe(
      Effect.catch((error) => o.report(`reasoning: cannot read ${folder} (${error}); the thinking kept there doesn't show`).pipe(Effect.as({ damaged: 0, index: new Map<number, Where>() }))),
    );
    const { index } = read;
    if (read.damaged > 0) yield* o.report(`reasoning: ${read.damaged} unreadable lines in ${folder}, ignored`);
    let failing = false;

    const keep = (record: ReasoningPiece): Effect.Effect<void> =>
      o.keep
        ? Effect.try({
            catch: (e) => (e instanceof Error ? e.message : String(e)),
            try: () => {
              const day = `${dayOf(new Date(record.date))}.jsonl`;
              const file = `${folder}/${day}`;
              const line = JSON.stringify(encodePiece(record));
              const { offset, prefix } = existsSync(folder) ? nextLine(file) : { offset: 0, prefix: "" };
              appendLine(folder, day, `${prefix}${line}\n`);
              index.set(record.i, { file, head: toHead(record), length: Buffer.byteLength(line), offset });
            },
          }).pipe(
            Effect.matchEffect({
              onFailure: (why) => (failing ? Effect.void : Effect.sync(() => (failing = true)).pipe(Effect.andThen(o.report(`reasoning: the thinking before entry ${record.i} was not kept (${why}); the turn goes on`)))),
              onSuccess: () => Effect.sync(() => (failing = false)),
            }),
          )
        : Effect.void;

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
          const found = decodePiece(readAt(at.file, at.offset, at.length).toString("utf8"));
          return Option.isSome(found) && found.value.i === i ? found.value : null;
        } catch {
          return null;
        }
      });

    return { heads, keep, piece } satisfies Reasoning;
  });

// for a session with no side file (tests): nothing is kept or found
export const noReasoning: Reasoning = { heads: () => [], keep: () => Effect.void, piece: () => Effect.succeed(null) };

// what persist leaves out of its commits with reasoning.commit off (src/persist.ts, a pattern in
// the data repo's own .git/info/exclude); files committed before stay tracked
export const REASONING_UNCOMMITTED = "/streams/*/chat/reasoning/";
export const reasoningLeftOut = (commit: boolean): readonly string[] => (commit ? [] : [REASONING_UNCOMMITTED]);
