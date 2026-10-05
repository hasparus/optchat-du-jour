// The compactor on the ChatGPT plan (SPEC "Compactor calls", openai-plan; E5): compact.txt as
// `instructions`, one user message of the context blocks and the step. Size retries stay in the
// same conversation: with `store: false` nothing is kept server-side, so each try re-sends the
// whole input, the earlier tries (their reasoning items included, as gist §8 asks) and the retry
// texts. The context blocks come first, with a cache breakpoint at each cut, the same in every try
// and every node's call; the request end is cached implicitly.
import { Duration, Effect } from "effect";
import { readFileSync } from "node:fs";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT } from "../config.ts";
import { type EngineError, ModelError } from "../engines/errors.ts";
import { type OpenAiPlan, type Turn, turnsOf } from "../openai/responses.ts";
import { COMPACT_FILE } from "../prompts.ts";
import type { UsageRecord } from "../usage.ts";
import { type Try, contextBlocks, sizeRetries, step } from "./step.ts";

export type OpenAiPlanCompactorOptions = {
  readonly model: string;
  readonly effort: string;
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly device?: string; // where the call runs, for its usage record: the server's own machine
  readonly timeout?: Duration.Input; // CALL_TIMEOUT
};

export const firstInput = (job: Job): Turn => {
  const context = contextBlocks(job);
  return { marks: context.length - 1, parts: [...context, step(job)], role: "user" };
};

export const openAiPlanCompactor = (o: OpenAiPlanCompactorOptions & { readonly plan: OpenAiPlan["Service"] }) => {
  const instructions = readFileSync(COMPACT_FILE, "utf8");
  const timeout = o.timeout ?? CALL_TIMEOUT;

  // the transport: one request per try, the whole conversation so far in each
  const call = (job: Job, failoverFrom: string | null) => {
    const input: Turn[] = [firstInput(job)];
    const ask = (t: Try) =>
      Effect.gen(function* () {
        if (t.retry !== null) input.push({ parts: [t.retry.text], role: "user" });
        const reply = yield* o.plan.respond({ effort: o.effort, input: [...input], instructions, model: o.model });
        input.push(...turnsOf(reply.output)); // what it answered, reasoning and all, for a retry to continue
        return reply;
      });
    return sizeRetries({ ask, auth: "chatgpt-pro", device: o.device, engine: "openai-plan", failoverFrom, job, log: o.log });
  };

  return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> =>
    Effect.suspend(() => call(job, failoverFrom)).pipe(
      // a hung call must free its slot (ref §7)
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new ModelError({ message: `openai-plan: no reply after ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
      }),
    );
};
