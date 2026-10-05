// The compactor on the ChatGPT plan (SPEC "Compactor calls", openai-plan; E5): compact.txt as
// `instructions`, one user message of the context blocks and the step. Size retries stay in the
// same conversation: with `store: false` nothing is kept server-side, so each try re-sends the
// whole input, the earlier tries and the retry texts. No cache marks: OpenAI caches a stable
// prefix by itself, and the context blocks come first and never change within a node.
import { Duration, Effect } from "effect";
import { readFileSync } from "node:fs";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT } from "../config.ts";
import { type EngineError, ModelError } from "../engines/errors.ts";
import { OpenAiPlan, type Turn } from "../openai/responses.ts";
import { COMPACT_FILE } from "../prompts.ts";
import type { UsageRecord } from "../usage.ts";
import { type Try, contextBlocks, sizeRetries, step } from "./step.ts";

export type OpenAiPlanCompactorOptions = {
  readonly model: string;
  readonly effort: string;
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly timeout?: Duration.Input; // CALL_TIMEOUT
};

export const firstInput = (job: Job): Turn => ({ parts: [...contextBlocks(job), step(job)], role: "user" });

export const openAiPlanCompactor = (o: OpenAiPlanCompactorOptions) =>
  Effect.gen(function* () {
    const plan = yield* OpenAiPlan;
    const instructions = readFileSync(COMPACT_FILE, "utf8");
    const timeout = o.timeout ?? CALL_TIMEOUT;

    // the transport: one request per try, the whole conversation so far in each
    const call = (job: Job, failoverFrom: string | null) => {
      const input: Turn[] = [firstInput(job)];
      const ask = (t: Try) => {
        if (t.retry !== null) input.push({ role: "assistant", text: t.retry.line }, { parts: [t.retry.text], role: "user" });
        return plan.respond({ effort: o.effort, input: [...input], instructions, model: o.model });
      };
      return sizeRetries({ ask, auth: "chatgpt-pro", engine: "openai-plan", failoverFrom, job, log: o.log });
    };

    return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> =>
      Effect.suspend(() => call(job, failoverFrom)).pipe(
        // a hung call must free its slot (ref §7)
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.fail(new ModelError({ message: `openai-plan: no reply after ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
        }),
      );
  });
