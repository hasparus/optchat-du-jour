// The compactor on an API key (SPEC "Compactor calls", api-key; E5): Anthropic gets layout A, the
// context pieces with our marks and `cache.apiKeyTtls`, the step unmarked; OpenAI gets what
// openai-plan gets. Size retries stay in the same conversation, each try re-sent with the reply
// it got (thinking blocks included). Every try is priced and counted against the monthly budget; the size retries are step.ts's.
import { Duration, Effect } from "effect";
import { readFileSync } from "node:fs";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT } from "../config.ts";
import { type EngineError, ModelError } from "../engines/errors.ts";
import { COMPACT_FILE } from "../prompts.ts";
import { type ApiKeyOptions, apiKeyProvider } from "../turn/api-key.ts";
import type { Item } from "../turn/loop.ts";
import type { UsageRecord } from "../usage.ts";
import { type Try, contextBlocks, sizeRetries, step } from "./step.ts";

export const apiKeyCompactor = (
  o: ApiKeyOptions & { readonly log: (record: UsageRecord) => Effect.Effect<void>; readonly device?: string; readonly timeout?: Duration.Input },
) => {
  const provider = apiKeyProvider(o);
  const instructions = readFileSync(COMPACT_FILE, "utf8");
  const timeout = o.timeout ?? CALL_TIMEOUT;

  // the transport: one request per try, the whole conversation so far in each
  const call = (job: Job, failoverFrom: string | null) => {
    const context = contextBlocks(job);
    const history: Item[] = [{ parts: [...context, step(job)], stable: context.length, type: "user" }];
    const ask = (t: Try) =>
      Effect.gen(function* () {
        if (t.retry !== null) history.push({ parts: [t.retry.text], type: "user" });
        const reply = yield* provider.call({ final: true, history, instructions, onText: () => Effect.void, tools: [] });
        history.push(...reply.items); // thinking blocks included, so the retry continues the same conversation
        const text = reply.items.flatMap((i) => (i.type === "text" ? [i.text] : [])).join("");
        return { dollars: reply.dollars, model: reply.model, text, usage: reply.usage };
      });
    return sizeRetries({ ask, auth: "api-key", device: o.device, engine: "api-key", failoverFrom, job, log: o.log });
  };

  return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> =>
    Effect.suspend(() => call(job, failoverFrom)).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new ModelError({ message: `api-key: no reply after ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
      }),
    );
};
