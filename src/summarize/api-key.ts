// The compactor on an API key (docs/optchat.md §4; E5): the turns' system prompt and tools (never
// called: tool choice `none`), the bytes an api-key turn sends before its view (§7 mistake 6);
// then the context pieces, a cache mark on the last whole one (the provider places it at
// `mark`), and the task; the request's end is cached too (docs/optchat.md §3.3), so a size retry
// reads the try before it. Size retries stay in the same conversation, each try re-sent with the
// reply it got (thinking blocks included). Every try is priced and counted against the monthly
// budget; the size retries are step.ts's.
import { Duration, Effect } from "effect";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT } from "../config.ts";
import { type EngineError, ModelError } from "../engines/errors.ts";
import type { Gate } from "../engines/inflight.ts";
import type { Item, Provider } from "../providers/provider.ts";
import type { ToolDef } from "../tools/files.ts";
import type { UsageRecord } from "../usage.ts";
import { keyOf } from "./openai-plan.ts";
import { type Try, contextBlocks, sizeRetries, task } from "./step.ts";

// `provider` is the api-key one, from the registry's `providerOf`; its `engine` and `auth` name the
// usage records
export const apiKeyCompactor = (o: {
  readonly provider: Provider;
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly device?: string;
  readonly timeout?: Duration.Input;
  readonly instructions: string; // the one system prompt (docs/optchat.md §5)
  readonly tools: readonly ToolDef[]; // an api-key turn's, on the default device
  readonly gate: Gate; // waits on a call writing the same marked prefix (docs/optchat.md §3.3)
  readonly model: string; // for the in-flight key
}) => {
  const { instructions, provider, tools } = o;
  const timeout = o.timeout ?? CALL_TIMEOUT;

  // the transport: one request per try, the whole conversation so far in each
  const call = (job: Job, failoverFrom: string | null) => {
    const context = contextBlocks(job);
    const history: Item[] = [{ mark: context.mark, parts: [...context.blocks, task(job)], type: "user" }];
    return o.gate.through(keyOf({ engine: `api-key:${provider.engine}`, instructions, model: o.model, tools }, context), (started) => {
      const ask = (t: Try) =>
        Effect.gen(function* () {
          if (t.retry !== null) history.push({ parts: [t.retry.text], type: "user" });
          const reply = yield* provider.call({ final: true, history, instructions, onStart: started, onText: () => Effect.void, tools });
          history.push(...reply.items); // thinking blocks included, so the retry continues the same conversation
          const text = reply.items.flatMap((i) => (i.type === "text" ? [i.text] : [])).join("");
          return { dollars: reply.dollars, model: reply.model, text, usage: reply.usage };
        });
      return sizeRetries({ ask, auth: provider.auth, device: o.device, engine: provider.engine, failoverFrom, job, log: o.log });
    });
  };

  return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> =>
    Effect.suspend(() => call(job, failoverFrom)).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new ModelError({ message: `api-key: no reply after ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
      }),
    );
};
