// The claude-code compactor engine (ref §7 layout A, gist §4.2-§4.4, E5/E6/E11): one `claude -p`
// per node, no tools, our own cache marks on the context, and the size retries in the same
// conversation until the line fits in NODE bytes or TRIES are spent.
import { Clock, Duration, Effect } from "effect";
import { baseArgs } from "../claude/args.ts";
import type { Block } from "../claude/events.ts";
import { Runner } from "../claude/process.ts";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT, NODE, TRIES } from "../config.ts";
import { type EngineError, fromResult, ModelError } from "../engines/errors.ts";
import { COMPACT_FILE, SCALE } from "../prompts.ts";
import { bytes } from "../tree.ts";
import { isCold, tokensOf, type UsageRecord } from "../usage.ts";
import { cutBlocks, flat } from "../view.ts";

export type CompactorOptions = {
  readonly model: string;
  readonly effort: string;
  readonly ttl: "1h" | "5m";
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly device?: string; // where the call runs, for its usage record: the server's own machine
  readonly timeout?: Duration.Input; // CALL_TIMEOUT
};

// what the gist's step block says above the message or the two lines (gist §4.2)
export function step(job: Job): string {
  const scale = `For scale, this line is exactly ${NODE} bytes:\n${SCALE}\n\n`;
  if ("msg" in job) return `${scale}Compress this message into one line, in at most ${NODE} bytes:\n${job.msg.kind}: ${job.msg.text}`;
  return `${scale}Merge these two lines into one, in at most ${NODE} bytes:\n${flat(job.a)}\n${flat(job.b)}`;
}

// The user message of a call (layout A): the context as <chat>, bare lines, </chat>, cut at
// MARKS with a mark on every piece, then the step, unmarked. The pieces stay byte-stable from
// one call to the next, so the next call reads them from the cache.
export function blocks(job: Job, ttl: "1h" | "5m"): Block[] {
  const chat = ["<chat>", ...job.ctx, "</chat>"].join("\n");
  const context = cutBlocks(chat).map((text): Block => ({ cache_control: { ttl, type: "ephemeral" }, text, type: "text" }));
  return [...context, { text: step(job), type: "text" }];
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

// the shortest try in bytes; the first of equals
function shortest(tries: readonly string[]): string {
  let best = tries[0] ?? "";
  for (const t of tries) if (bytes(t) < bytes(best)) best = t;
  return best;
}

export const claudeCodeCompactor = (o: CompactorOptions) =>
  Effect.gen(function* () {
    const runner = yield* Runner;
    const args = [...baseArgs({ effort: o.effort, model: o.model, systemFile: COMPACT_FILE, tools: "" }), "--safe-mode"];
    // our marks only (D6), every one with the same TTL (E6)
    const env = { CLAUDE_CODE_PROMPT_CACHE_TTL: o.ttl, DISABLE_PROMPT_CACHING: "1" };
    const timeout = o.timeout ?? CALL_TIMEOUT;

    const call = (job: Job, failoverFrom: string | null) =>
      Effect.gen(function* () {
        const claude = yield* runner.spawn({ args, env }).pipe(Effect.mapError((e) => new ModelError({ message: e.message })));
        const tries: string[] = [];
        let message: readonly Block[] = blocks(job, o.ttl);
        for (;;) {
          const sent = yield* Clock.currentTimeMillis;
          yield* claude.send(message);
          const result = yield* claude.result.pipe(Effect.mapError((e) => new ModelError({ message: e.message })));
          const usage = tokensOf(result.usage);
          yield* o.log({
            attempt: tries.length + 1,
            auth: "claude-max",
            cold: isCold(usage),
            date: new Date(yield* Clock.currentTimeMillis).toISOString(),
            device: o.device ?? null,
            engine: "claude-code",
            failoverFrom,
            level: job.l,
            model: claude.model() ?? null,
            ms: (yield* Clock.currentTimeMillis) - sent,
            role: "compact",
            usage,
          });
          if (result.is_error || result.stop_reason === "refusal")
            return yield* fromResult(result.result ?? `the call ended with ${result.subtype ?? "an error"}`, result.stop_reason);
          const answer = result.result?.trim() ?? "";
          if (answer === "") return yield* new ModelError({ message: "the compactor answered with an empty line" });
          tries.push(answer);
          const fits = bytes(answer) <= NODE;
          if (fits || tries.length === TRIES) return shortest(tries);
          message = [{ text: retryText(answer), type: "text" }];
        }
      }).pipe(
        Effect.scoped, // the process ends with the node
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new ModelError({ message: `no answer within ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
        }),
      );

    return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> => call(job, failoverFrom);
  });
