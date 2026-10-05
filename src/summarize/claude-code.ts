// The claude-code compactor engine (ref §7 layout A, gist §4.2-§4.4, E5/E6/E11): one `claude -p`
// per node, no tools, our own cache marks on the context, and the size retries in the same
// conversation until the line fits in NODE bytes or TRIES are spent.
import { Duration, Effect } from "effect";
import { baseArgs } from "../claude/args.ts";
import type { TextBlock } from "../claude/events.ts";
import { Runner } from "../claude/process.ts";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT } from "../config.ts";
import { type EngineError, fromResult, ModelError } from "../engines/errors.ts";
import { COMPACT_FILE } from "../prompts.ts";
import { tokensOf, type UsageRecord } from "../usage.ts";
import { type Try, contextBlocks, sizeRetries, step } from "./step.ts";

export type CompactorOptions = {
  readonly model: string;
  readonly effort: string;
  readonly ttl: "1h" | "5m";
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly device?: string; // where the call runs, for its usage record: the server's own machine
  readonly timeout?: Duration.Input; // CALL_TIMEOUT
};

// The user message of a call (layout A): the context pieces (step.ts), each with our mark, then
// the step, unmarked. The pieces stay byte-stable from one call to the next, so the next call
// reads them from the cache.
export function blocks(job: Job, ttl: "1h" | "5m"): TextBlock[] {
  const context = contextBlocks(job).map((text): TextBlock => ({ cache_control: { ttl, type: "ephemeral" }, text, type: "text" }));
  return [...context, { text: step(job), type: "text" }];
}

export const claudeCodeCompactor = (o: CompactorOptions) =>
  Effect.gen(function* () {
    const runner = yield* Runner;
    const args = [...baseArgs({ effort: o.effort, model: o.model, systemFile: COMPACT_FILE, tools: "" }), "--safe-mode"];
    // our marks only (D6), every one with the same TTL (E6)
    const env = { CLAUDE_CODE_PROMPT_CACHE_TTL: o.ttl, DISABLE_PROMPT_CACHING: "1" };
    const timeout = o.timeout ?? CALL_TIMEOUT;

    // the transport: one process per node, each try a message into it, its result the answer
    const call = (job: Job, failoverFrom: string | null) =>
      Effect.gen(function* () {
        const claude = yield* runner.spawn({ args, env }).pipe(Effect.mapError((e) => new ModelError({ message: e.message })));
        const ask = (t: Try) =>
          Effect.gen(function* () {
            yield* claude.send(t.retry === null ? blocks(job, o.ttl) : [{ text: t.retry.text, type: "text" }]);
            const result = yield* claude.result.pipe(Effect.mapError((e) => new ModelError({ message: e.message })));
            const usage = tokensOf(result.usage), model = claude.model() ?? null;
            if (result.is_error || result.stop_reason === "refusal")
              return yield* fromResult(result.result ?? `the call ended with ${result.subtype ?? "an error"}`, result.stop_reason, { model, usage });
            return { model, text: result.result ?? "", usage };
          });
        return yield* sizeRetries({ ask, auth: "claude-max", device: o.device, engine: "claude-code", failoverFrom, job, log: o.log });
      }).pipe(
        Effect.scoped, // the process ends with the node
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new ModelError({ message: `no answer within ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
        }),
      );

    return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> => call(job, failoverFrom);
  });
