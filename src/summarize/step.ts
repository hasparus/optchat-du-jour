// What every compactor engine sends (docs/optchat.md §4), whatever carries it: the compaction view
// as <chat> and its id+n|text lines in blocks of BLOCK lines, the task under it, the retry text for
// a line over NODE, and the size retries themselves. The engines add only their transport and
// marks; the system prompt and tools are the turns' (docs/optchat.md §5, §7 mistake 6).
import { Clock, Effect } from "effect";
import type { Job } from "../compactor.ts";
import { NODE, TRIES } from "../config.ts";
import { type EngineError, ModelError } from "../engines/errors.ts";
import { bytes, children, label, span } from "../tree.ts";
import { type Tokens, type UsageRecord, isCold } from "../usage.ts";
import { type Blocks, flat, viewBlocks } from "../view.ts";

// The context pieces: <chat>, the compaction view's lines, </chat>, in blocks of BLOCK lines, and
// the last whole one, where an engine puts its mark (view.ts viewBlocks). Byte-stable from call
// to call.
export const contextBlocks = (job: Job): Blocks => viewBlocks(["<chat>", ...job.ctx, "</chat>"].join("\n"));

// Models can't count bytes, so the task shows the length: a ruler of NODE dashes (docs/optchat.md §4
// "The size"; a real sample line as the ruler got its content copied)
export const RULER = "-".repeat(NODE);

// The task, verbatim from docs/optchat.md §4: compress a message, whole, or merge two adjacent lines,
// each as the view shows it (id+n|text). A merge's messages run from its first to its last.
export function task(job: Job): string {
  const limit = `of at most\n${NODE} bytes (about 70 words), the length of this ruler:\n${RULER}\n`;
  if ("msg" in job)
    return `Compaction: compress message ${job.i} into one line of at most ${NODE} bytes\n(about 70 words), the length of this ruler:\n${RULER}\n<input>\n${job.msg.kind}: ${job.msg.text}\n</input>`;
  const [a, b] = children(job);
  const { id, n } = span(job);
  return [
    `Compaction: merge lines ${label(a)} and ${label(b)}, adjacent, into one line ${limit}<chat> may hold their messages, ${id} to ${id + n - 1}, in more detail: take details`,
    "of them from there too.",
    "<input>",
    `${label(a)}|${flat(job.a)}`,
    `${label(b)}|${flat(job.b)}`,
    "</input>",
  ].join("\n");
}

// the first `limit` bytes of a line, never ending inside a UTF-8 character (docs/optchat.md §4 "The size")
export function cut(line: string, limit = NODE): string {
  const raw = Buffer.from(line, "utf8");
  if (raw.length <= limit) return line;
  let end = limit;
  while (end > 0 && ((raw[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end--; // a continuation byte: back up to its start
  return raw.subarray(0, end).toString("utf8");
}

// the retry, in the same conversation, verbatim from docs/optchat.md §4 "The size"
export const retryText = (line: string) =>
  `Too long: your line is ${bytes(line)} bytes, over the ${NODE}-byte limit. Write\nthe whole line again for the same <input>, cutting just enough of the\nleast valuable items to fit before this cut:\n${cut(line)}| ← LIMIT`;

// done once the last try fits or the tries run out
const enough = (tries: readonly string[]) => {
  const last = tries.at(-1);
  return last !== undefined && (bytes(last) <= NODE || tries.length >= TRIES);
};

// the node's text: the shortest try in bytes, the first of equals (docs/optchat.md §4 "The size")
function shortest(tries: readonly string[]): string {
  let best = tries[0] ?? "";
  for (const t of tries) if (bytes(t) < bytes(best)) best = t;
  return best;
}

// One try: the first message (attempt 1), or the retry text that answers the line before it.
export type Try = { readonly attempt: number; readonly retry: { readonly line: string; readonly text: string } | null };
export type Answer = { readonly text: string; readonly usage: Tokens; readonly model: string | null; readonly dollars?: number };

// The size retries (docs/optchat.md §4 "The size"), for any engine: ask, log what the try cost, and retry in the same
// conversation until the line fits or TRIES are spent; the shortest try wins. Every try that
// reports usage gets its usage.jsonl line (E11), a failed one too when the engine knows its cost.
export const sizeRetries = (o: {
  readonly job: Job;
  readonly engine: UsageRecord["engine"];
  readonly auth: UsageRecord["auth"];
  readonly device?: string | undefined; // where the call runs (the server's own machine)
  readonly failoverFrom: string | null;
  readonly effort: string | undefined; // what the engine asks for, for the records
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly ask: (t: Try) => Effect.Effect<Answer, EngineError>;
}): Effect.Effect<string, EngineError> =>
  Effect.gen(function* () {
    const tries: string[] = [];
    let retry: Try["retry"] = null;
    for (;;) {
      const attempt = tries.length + 1;
      const sent = yield* Clock.currentTimeMillis;
      const record = (usage: Tokens, model: string | null, dollars?: number) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const line: UsageRecord = {
            attempt,
            auth: o.auth,
            cold: isCold(usage),
            date: new Date(now).toISOString(),
            device: o.device ?? null,
            effort: o.effort,
            engine: o.engine,
            failoverFrom: o.failoverFrom,
            level: o.job.l,
            model,
            ms: now - sent,
            role: "compact",
            usage,
          };
          yield* o.log(dollars === undefined ? line : { ...line, dollars });
        });
      const answer: Answer = yield* o.ask({ attempt, retry }).pipe(
        Effect.tapError((e) => (e._tag !== "DeviceOffline" && e.spent !== undefined ? record(e.spent.usage, e.spent.model, e.spent.dollars) : Effect.void)),
      );
      yield* record(answer.usage, answer.model, answer.dollars);
      const line = answer.text.trim();
      // an empty answer ends the call: a line tried before it still stands, the shortest of them
      if (!line) return tries.length > 0 ? shortest(tries) : yield* new ModelError({ message: "the compactor answered with an empty line" });
      tries.push(line);
      if (enough(tries)) return shortest(tries);
      retry = { line, text: retryText(line) };
    }
  });
