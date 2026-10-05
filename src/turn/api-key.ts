// The api-key engine as a provider for our tool loop (SPEC "Engines", api-key: overflow only):
// Anthropic with our own cache marks (`cache.apiKeyTtls`) or OpenAI's Responses API, each call
// first asking the monthly budget and then priced from the table in optchat.config.ts
// (SPEC "Usage and cost tracking"). The master runs it with the same read-only tools as
// openai-plan; the compactor (src/summarize/api-key.ts) runs it with none.
import { Effect } from "effect";
import { type ApiKeys } from "../apikey/clients.ts";
import { type Budget, dollarsOf } from "../apikey/budget.ts";
import { apiKeyRef, type Settings } from "../config.ts";
import { UsageLimit } from "../engines/errors.ts";
import { type Provider, type ToolBox, toolLoop } from "./loop.ts";
import { responsesProvider } from "./openai-plan.ts";

export type ApiKeyOptions = {
  readonly ref: string; // api-key:anthropic/<model> or api-key:openai/<model>
  readonly settings: Settings;
  readonly clients: ApiKeys["Service"];
  readonly budget: Budget;
  readonly effort?: string;
};

export const apiKeyProvider = (o: ApiKeyOptions): Provider => {
  const parsed = apiKeyRef(o.ref);
  const { apiKey } = o.settings;
  const name = parsed === null ? o.ref : `${parsed.provider}/${parsed.model}`;
  const price = apiKey?.prices[name];
  // nothing is spent without a budget and a price: an unpriced call could never be stopped
  const before = Effect.suspend(() => {
    if (parsed === null) return Effect.fail(new UsageLimit({ message: `api-key: ${o.ref} names no provider` }));
    if (apiKey === undefined) return Effect.fail(new UsageLimit({ message: "api-key: no apiKey budget in optchat.config.ts" }));
    if (price === undefined) return Effect.fail(new UsageLimit({ message: `api-key: no price for ${name} in optchat.config.ts apiKey.prices` }));
    return o.budget.check;
  });
  const model = parsed?.model ?? "";
  if (parsed?.provider === "openai")
    return responsesProvider({ auth: "api-key", before, dollars: (u) => (price ? dollarsOf(price, u) : 0), effort: o.effort, engine: "api-key", model, respond: o.clients.openai });
  return {
    auth: "api-key",
    call: (c) =>
      Effect.gen(function* () {
        yield* before;
        const reply = yield* o.clients.anthropic({
          effort: o.effort,
          history: c.history,
          maxTokens: apiKey?.maxTokens,
          model,
          onText: c.onText,
          system: c.instructions,
          toolChoice: c.final ? "none" : "auto",
          tools: c.tools,
          ttls: o.settings.cache.apiKeyTtls,
        });
        return { dollars: price ? dollarsOf(price, reply.usage, reply.writes) : 0, items: reply.items, model: reply.model, usage: reply.usage };
      }),
    engine: "api-key",
  };
};

export const apiKeyTurn = (o: ApiKeyOptions & { readonly instructions: string; readonly toolsFor: (device: string) => ToolBox }) =>
  toolLoop({ instructions: o.instructions, provider: apiKeyProvider(o), ref: o.ref, toolsFor: o.toolsFor });
