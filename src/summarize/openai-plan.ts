// The compactor on the ChatGPT plan (SPEC "Compactor calls", openai-plan; E5): compact.txt as
// `instructions`, one user message of the context blocks and the step. Size retries stay in the
// same conversation: with `store: false` nothing is kept server-side, so each try re-sends the
// whole input, the earlier tries and the retry texts. No cache marks: OpenAI caches a stable
// prefix by itself, and the context blocks come first and never change within a node.
import { Clock, Duration, Effect } from "effect";
import { readFileSync } from "node:fs";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT, TRIES } from "../config.ts";
import { type EngineError, ModelError } from "../engines/errors.ts";
import { OpenAiPlan, type Turn } from "../openai/responses.ts";
import { COMPACT_FILE } from "../prompts.ts";
import { type UsageRecord, isCold } from "../usage.ts";
import { contextBlocks, enough, retryText, shortest, step } from "./step.ts";

export type OpenAiPlanCompactorOptions = {
  readonly model: string;
  readonly effort?: string;
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly timeout?: Duration.Input;
};

export const firstInput = (job: Job): Turn => ({ parts: [...contextBlocks(job), step(job)], role: "user" });

export const openAiPlanCompactor = (o: OpenAiPlanCompactorOptions) =>
  Effect.gen(function* () {
    const plan = yield* OpenAiPlan;
    const instructions = readFileSync(COMPACT_FILE, "utf8");
    const timeout = o.timeout ?? CALL_TIMEOUT;

    const call = (job: Job, failoverFrom: string | null) =>
      Effect.gen(function* () {
        const input: Turn[] = [firstInput(job)];
        const tries: string[] = [];
        for (;;) {
          const sent = yield* Clock.currentTimeMillis;
          const reply = yield* plan.respond({ effort: o.effort, input, instructions, model: o.model });
          yield* o.log({
            attempt: tries.length + 1,
            auth: "chatgpt-pro",
            cold: isCold(reply.usage),
            date: new Date(yield* Clock.currentTimeMillis).toISOString(),
            device: null,
            engine: "openai-plan",
            failoverFrom,
            level: job.l,
            model: reply.model,
            ms: (yield* Clock.currentTimeMillis) - sent,
            role: "compact",
            usage: reply.usage,
          });
          const line = reply.text.trim();
          if (!line) return yield* new ModelError({ message: "openai-plan: empty reply" });
          tries.push(line);
          if (enough(tries, TRIES)) return shortest(tries);
          input.push({ role: "assistant", text: line }, { parts: [retryText(line)], role: "user" });
        }
      });

    return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> =>
      call(job, failoverFrom).pipe(
        // a hung call must free its slot (ref §7)
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new ModelError({ message: `openai-plan: no reply after ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
        }),
      );
  });
