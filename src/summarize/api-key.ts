// The compactor on an API key (SPEC "Compactor calls", api-key; E5): Anthropic gets layout A, the
// context pieces with our marks and `cache.apiKeyTtls`, the step unmarked; OpenAI gets what
// openai-plan gets. Size retries stay in the same conversation, each try re-sent with the reply
// it got (thinking blocks included). Every try is priced and counted against the monthly budget.
import { Clock, Duration, Effect } from "effect";
import { readFileSync } from "node:fs";
import type { Job } from "../compactor.ts";
import { CALL_TIMEOUT, TRIES } from "../config.ts";
import { type EngineError, ModelError } from "../engines/errors.ts";
import { COMPACT_FILE } from "../prompts.ts";
import { type ApiKeyOptions, apiKeyProvider } from "../turn/api-key.ts";
import type { Item } from "../turn/loop.ts";
import { isCold, type UsageRecord } from "../usage.ts";
import { contextBlocks, enough, retryText, shortest, step } from "./step.ts";

export const apiKeyCompactor = (o: ApiKeyOptions & { readonly log: (record: UsageRecord) => Effect.Effect<void>; readonly timeout?: Duration.Input }) => {
  const provider = apiKeyProvider(o);
  const instructions = readFileSync(COMPACT_FILE, "utf8");
  const timeout = o.timeout ?? CALL_TIMEOUT;

  const call = (job: Job, failoverFrom: string | null) =>
    Effect.gen(function* () {
      const context = contextBlocks(job);
      const history: Item[] = [{ parts: [...context, step(job)], stable: context.length, type: "user" }];
      const tries: string[] = [];
      for (;;) {
        const sent = yield* Clock.currentTimeMillis;
        const reply = yield* provider.call({ final: true, history, instructions, onText: () => Effect.void, tools: [] });
        const now = yield* Clock.currentTimeMillis;
        yield* o.log({
          attempt: tries.length + 1,
          auth: "api-key",
          cold: isCold(reply.usage),
          date: new Date(now).toISOString(),
          device: null,
          engine: "api-key",
          failoverFrom,
          level: job.l,
          model: reply.model,
          ms: now - sent,
          role: "compact",
          usage: reply.usage,
          dollars: reply.dollars,
        });
        const line = reply.items.flatMap((i) => (i.type === "text" ? [i.text] : [])).join("").trim();
        if (!line) return yield* new ModelError({ message: "api-key: empty reply" });
        tries.push(line);
        if (enough(tries, TRIES)) return shortest(tries);
        history.push(...reply.items, { parts: [retryText(line)], type: "user" });
      }
    });

  return (job: Job, failoverFrom: string | null = null): Effect.Effect<string, EngineError> =>
    call(job, failoverFrom).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new ModelError({ message: `api-key: no reply after ${Duration.format(Duration.fromInputUnsafe(timeout))}` })),
      }),
    );
};
