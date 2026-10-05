// What every compactor engine sends (SPEC "Compactor calls", gist §4.2–§4.3), whatever carries it:
// the context as <chat> and bare view lines cut at MARKS, the step under it, the retry text for a
// line over NODE, and the size retries themselves. The engines add only their transport and marks.
import { Clock, Effect } from "effect";
import type { Job } from "../compactor.ts";
import { MARKS, NODE, TRIES } from "../config.ts";
import { type EngineError, ModelError } from "../engines/errors.ts";
import { SCALE } from "../prompts.ts";
import { bytes } from "../tree.ts";
import { type Tokens, type UsageRecord, isCold } from "../usage.ts";
import { cutBlocks, flat } from "../view.ts";

// The context pieces: <chat>, the bare lines, </chat>, cut at the marks. No ids anywhere: shown
// `id+n|text`, the model starts copying the format (gist §4.2). Byte-stable from call to call.
export const contextBlocks = (job: Job, marks: readonly number[] = MARKS) => cutBlocks(["<chat>", ...job.ctx, "</chat>"].join("\n"), marks);

// what the gist's step block says above the message or the two lines (gist §4.2): the message
// whole with its newlines, the two lines written out again, flattened
export function step(job: Job): string {
  const scale = `For scale, this line is exactly ${NODE} bytes:\n${SCALE}\n\n`;
  if ("msg" in job) return `${scale}Compress this message into one line, in at most ${NODE} bytes:\n${job.msg.kind}: ${job.msg.text}`;
  return `${scale}Merge these two lines into one, in at most ${NODE} bytes:\n${flat(job.a)}\n${flat(job.b)}`;
}

// the first `limit` bytes of a line, never ending inside a UTF-8 character (gist §4.3)
export function cut(line: string, limit = NODE): string {
  const raw = Buffer.from(line, "utf8");
  if (raw.length <= limit) return line;
  let end = limit;
  while (end > 0 && ((raw[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end--; // a continuation byte: back up to its start
  return raw.subarray(0, end).toString("utf8");
}

// the gist's retry message, word for word (gist §4.3)
export const retryText = (line: string) =>
  `That line is ${bytes(line)} bytes; the limit is ${NODE}. It must end where it is cut here:\n${cut(line)}| ← LIMIT`;

// done once the last try fits or the tries run out
export const enough = (tries: readonly string[], limit: number) => {
  const last = tries.at(-1);
  return last !== undefined && (bytes(last) <= NODE || tries.length >= limit);
};

// the node's text: the shortest try in bytes, the first of equals (gist §4.3)
export function shortest(tries: readonly string[]): string {
  let best = tries[0] ?? "";
  for (const t of tries) if (bytes(t) < bytes(best)) best = t;
  return best;
}

// One try: the first message (attempt 1), or the retry text that answers the line before it.
export type Try = { readonly attempt: number; readonly retry: { readonly line: string; readonly text: string } | null };
export type Answer = { readonly text: string; readonly usage: Tokens; readonly model: string | null };

// The size retries (gist §4.3), for any engine: ask, log what the try cost, and retry in the same
// conversation until the line fits or TRIES are spent; the shortest try wins. Every try that
// reports usage gets its usage.jsonl line (E11), a failed one too when the engine knows its cost.
export const sizeRetries = (o: {
  readonly job: Job;
  readonly engine: UsageRecord["engine"];
  readonly auth: UsageRecord["auth"];
  readonly failoverFrom: string | null;
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly ask: (t: Try) => Effect.Effect<Answer, EngineError>;
  readonly tries?: number; // TRIES
}): Effect.Effect<string, EngineError> =>
  Effect.gen(function* () {
    const tries: string[] = [];
    let retry: Try["retry"] = null;
    for (;;) {
      const attempt = tries.length + 1;
      const sent = yield* Clock.currentTimeMillis;
      const record = (usage: Tokens, model: string | null) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          yield* o.log({
            attempt,
            auth: o.auth,
            cold: isCold(usage),
            date: new Date(now).toISOString(),
            device: null,
            engine: o.engine,
            failoverFrom: o.failoverFrom,
            level: o.job.l,
            model,
            ms: now - sent,
            role: "compact",
            usage,
          });
        });
      const answer: Answer = yield* o.ask({ attempt, retry }).pipe(
        Effect.tapError((e) => ("usage" in e && e.usage !== undefined ? record(e.usage, e.model ?? null) : Effect.void)),
      );
      yield* record(answer.usage, answer.model);
      const line = answer.text.trim();
      if (!line) return yield* new ModelError({ message: `${o.engine}: the compactor answered with an empty line` });
      tries.push(line);
      if (enough(tries, o.tries ?? TRIES)) return shortest(tries);
      retry = { line, text: retryText(line) };
    }
  });
