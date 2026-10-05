// The compactor on an API key (SPEC "Compactor calls", api-key; E5): the context pieces first, a
// cache mark at each of their cuts, then the step; the request's end is cached too (gist §8), so a
// size retry reads the try before it. OpenAI gets what openai-plan gets. Size retries stay in the
// same conversation, each try re-sent with the reply it got (thinking blocks included). Every try
// is priced and counted against the monthly budget; the size retries are step.ts's.
import { Duration, Effect } from "effect";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT } from "../config.ts";
import { type EngineError, ModelError } from "../engines/errors.ts";
import { COMPACT } from "../prompts.ts";
import type { Item, Provider } from "../providers/provider.ts";
import type { UsageRecord } from "../usage.ts";
import { type Try, contextBlocks, sizeRetries, step } from "./step.ts";

// `provider` is the api-key one, from the registry's `providerOf`; its `engine` and `auth` name the
// usage records
export const apiKeyCompactor = (o: {
  readonly provider: Provider;
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly device?: string;
  readonly timeout?: Duration.Input;
}) => {
  const { provider } = o;
  const instructions = COMPACT;
  const timeout = o.timeout ?? CALL_TIMEOUT;

  // the transport: one request per try, the whole conversation so far in each
  const call = (job: Job, failoverFrom: string | null) => {
    const context = contextBlocks(job);
    const history: Item[] = [{ marks: context.length - 1, parts: [...context, step(job)], type: "user" }];
    const ask = (t: Try) =>
      Effect.gen(function* () {
        if (t.retry !== null) history.push({ parts: [t.retry.text], type: "user" });
        const reply = yield* provider.call({ final: true, history, instructions, onText: () => Effect.void, tools: [] });
        history.push(...reply.items); // thinking blocks included, so the retry continues the same conversation
        const text = reply.items.flatMap((i) => (i.type === "text" ? [i.text] : [])).join("");
        return { dollars: reply.dollars, model: reply.model, text, usage: reply.usage };
      });
    return sizeRetries({ ask, auth: provider.auth, device: o.device, engine: provider.engine, failoverFrom, job, log: o.log });
  };

  return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> =>
    Effect.suspend(() => call(job, failoverFrom)).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new ModelError({ message: `api-key: no reply after ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
      }),
    );
};
