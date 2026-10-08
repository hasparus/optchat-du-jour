// The compactor on the ChatGPT plan (docs/optchat.md §4; E5): the turns' system prompt as
// `instructions` and their function tools (never called: tool choice `none`), so its requests share
// the turns' prefix (§7 mistake 6); then one user message of the context blocks and the task.
// Size retries stay in the same conversation: with `store: false` nothing is kept server-side, so
// each try re-sends the whole input, the earlier tries (their reasoning items included, as E26 has
// it) and the retry texts. The context blocks come first, a cache breakpoint on the last whole one
// (src/openai/responses.ts places it at `mark`), the same in every try and every node's call;
// the request end is cached implicitly.
import { Duration, Effect } from "effect";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT } from "../config.ts";
import { type EngineError, ModelError } from "../engines/errors.ts";
import { type Gate, prefixKey } from "../engines/inflight.ts";
import type { OpenAiPlan, Turn } from "../openai/responses.ts";
import { turnsOf } from "../providers/responses.ts";
import type { ToolDef } from "../tools/files.ts";
import type { UsageRecord } from "../usage.ts";
import type { Blocks } from "../view.ts";
import { type Try, contextBlocks, sizeRetries, task } from "./step.ts";

export type OpenAiPlanCompactorOptions = {
  readonly model: string;
  readonly effort: string;
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly device?: string; // where the call runs, for its usage record: the server's own machine
  readonly timeout?: Duration.Input; // CALL_TIMEOUT
  readonly instructions: string; // the one system prompt (docs/optchat.md §5)
  readonly tools: readonly ToolDef[]; // a turn's, on the default device
  readonly gate: Gate; // waits on a call writing the same marked prefix (docs/optchat.md §3.3)
};

// the context blocks, the last whole one marked (`mark`), then the task
export const firstInput = (job: Job, context: Blocks = contextBlocks(job)): Turn => ({ mark: context.mark, parts: [...context.blocks, task(job)], role: "user" });

// What a request sends up to its mark: the model, the system prompt, the tools and the context
// blocks up to the marked one; null when nothing before the request's end is marked. The mark is
// the marks helpers' (step.ts contextBlocks, view.ts viewBlocks).
export const keyOf = (o: { readonly engine: string; readonly model: string; readonly instructions: string; readonly tools: readonly ToolDef[] }, context: Blocks) =>
  context.mark === undefined ? null : prefixKey([o.engine, o.model, o.instructions, JSON.stringify(o.tools), ...context.blocks.slice(0, context.mark + 1)]);

export const openAiPlanCompactor = (o: OpenAiPlanCompactorOptions & { readonly plan: OpenAiPlan["Service"] }) => {
  const { instructions, tools } = o;
  const timeout = o.timeout ?? CALL_TIMEOUT;

  // the transport: one request per try, the whole conversation so far in each
  const call = (job: Job, failoverFrom: string | null) => {
    const context = contextBlocks(job);
    const input: Turn[] = [firstInput(job, context)];
    const key = keyOf({ ...o, engine: "openai-plan" }, context);
    return o.gate.through(key, (started) => {
      const ask = (t: Try) =>
        Effect.gen(function* () {
          if (t.retry !== null) input.push({ parts: [t.retry.text], role: "user" });
          const reply = yield* o.plan.respond({ effort: o.effort, input: [...input], instructions, model: o.model, onStart: started, toolChoice: "none", tools });
          input.push(...turnsOf(reply.output)); // what it answered, reasoning and all, for a retry to continue
          return reply;
        });
      return sizeRetries({ ask, auth: "chatgpt-pro", device: o.device, engine: "openai-plan", failoverFrom, job, log: o.log });
    });
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
