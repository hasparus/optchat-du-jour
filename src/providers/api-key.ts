// The api-key engine as a provider (./provider.ts; SPEC "Engines", api-key: overflow only):
// Anthropic with our cache layout (docs/optchat.md §3.3: a mark on the view's last whole block
// and the request end, both 5-minute) or OpenAI's Responses API, each call
// first asking the monthly budget and then priced from the table in optchat.config.ts (SPEC
// "Usage and cost tracking"). The master runs it in our tool loop with the read-only tools; the
// compactor (src/summarize/api-key.ts) runs it with none.
import { Cause, Effect } from "effect";
import type { ApiKeys } from "../apikey/clients.ts";
import { type Budget, dollarsOf } from "../apikey/budget.ts";
import type { ApiKeyRef, Settings } from "../config.ts";
import { MAX_TOKENS } from "../apikey/anthropic.ts";
import { isEngineError, ModelError, priced, priceUsage, stoppedShort, UsageLimit } from "../engines/errors.ts";
import type { Provider } from "./provider.ts";
import { responsesProvider } from "./responses.ts";

export type ApiKeyOptions = {
  readonly ref: ApiKeyRef;
  readonly settings: Settings;
  readonly clients: ApiKeys["Service"];
  readonly budget: Budget;
  readonly effort?: string;
};

export const apiKeyProvider = (o: ApiKeyOptions): Provider => {
  const { apiKey } = o.settings;
  const name = `${o.ref.provider}/${o.ref.model}`;
  const price = apiKey?.prices[name];
  // nothing is spent without a budget and a price: an unpriced call could never be stopped
  if (apiKey === undefined || price === undefined) {
    const message = apiKey === undefined ? "api-key: no apiKey budget in optchat.config.ts" : `api-key: no price for ${name} in optchat.config.ts apiKey.prices`;
    return { auth: "api-key", call: () => Effect.fail(new UsageLimit({ message })), engine: "api-key" };
  }
  const before = Effect.try({
    try: () => dollarsOf(price, { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }),
    catch: () => new ModelError({ message: "API-key price configuration is invalid" }),
  }).pipe(Effect.andThen(o.budget.check));
  if (o.ref.provider === "openai")
    return responsesProvider({ auth: "api-key", before, dollars: (u) => dollarsOf(price, u), effort: o.effort, engine: "api-key", model: o.ref.model, respond: o.clients.openai });
  return {
    auth: "api-key",
    effort: o.effort,
    call: (c) =>
      Effect.gen(function* () {
        yield* before;
        const { onSettledUsage } = c;
        const reply = yield* o.clients.anthropic({
          effort: o.effort,
          history: c.history,
          maxTokens: apiKey.maxTokens,
          model: o.ref.model,
          onItem: c.onItem,
          onSettledUsage: onSettledUsage && ((spent, writes) => priceUsage(spent, (u) => dollarsOf(price, u, writes)).pipe(
            Effect.match({ onFailure: () => spent, onSuccess: (dollars) => ({ ...spent, dollars }) }),
            Effect.flatMap(onSettledUsage),
          )),
          onStart: c.onStart,
          onText: c.onText,
          onReasoning: c.onReasoning,
          onThinking: c.onThinking,
          onToolInput: c.onToolInput,
          system: c.instructions,
          toolChoice: c.final ? "none" : "auto",
          tools: c.tools,
        });
        const cut = reply.stop === "max_tokens" ? `the reply reached its ${apiKey.maxTokens ?? MAX_TOKENS}-token limit` : stoppedShort(reply.stop);
        const dollars = yield* priceUsage({ model: reply.model, usage: reply.usage }, (u) => dollarsOf(price, u, reply.writes));
        return { cut, dollars, items: reply.items, model: reply.model, usage: reply.usage };
      }).pipe(Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, (e) => (isEngineError(e) ? priced(e, (u) => dollarsOf(price, u)) : e))))),
    engine: "api-key",
  };
};
