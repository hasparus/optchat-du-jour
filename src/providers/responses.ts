// The Responses API as a provider (./provider.ts): the ChatGPT plan's for openai-plan, or an
// OpenAI API key's for api-key. `stream: true` and `store: false`, so every request re-sends the
// whole conversation, the reply's reasoning items included, with their encrypted content (E26
// §8): the model keeps its reasoning across tool rounds, and the cached prefix stays the same.
import { Effect } from "effect";
import { type EngineError, isEngineError, priced } from "../engines/errors.ts";
import type { Out, Respond, Turn } from "../openai/responses.ts";
import type { Tokens } from "../usage.ts";
import type { Item, Provider } from "./provider.ts";

const itemOf = (out: Out): Item => {
  switch (out.type) {
    case "text":
      return out;
    case "call":
      return { id: out.id, input: out.arguments, name: out.name, type: "call" };
    case "reasoning":
      return { block: out.item, provider: "openai", type: "kept" };
  }
};

const turnOf = (item: Item): Turn[] => {
  switch (item.type) {
    case "user":
      return [{ mark: item.mark, parts: item.parts, role: "user" }];
    case "text":
      return [{ role: "assistant", text: item.text }];
    case "call":
      return [{ arguments: item.input, id: item.id, name: item.name, role: "call" }];
    case "result":
      return [{ id: item.id, output: item.output, role: "output" }];
    case "kept":
      return item.provider === "openai" ? [{ item: item.block, role: "reasoning" }] : []; // another provider's block goes nowhere
  }
};

// a reply's output as the next request sends it back (its text, calls and reasoning, in order),
// for a caller that keeps the Responses API's own conversation (the openai-plan compactor)
export const turnsOf = (output: readonly Out[]): Turn[] => output.map(itemOf).flatMap(turnOf);

export const responsesProvider = (o: {
  readonly respond: Respond;
  readonly model: string;
  readonly effort?: string;
  readonly engine: Provider["engine"];
  readonly auth: Provider["auth"];
  readonly before?: Effect.Effect<void, EngineError>; // e.g. the api-key budget, checked first
  readonly dollars?: (usage: Tokens) => number; // an API key's price; a failed call that cost something is priced too
}): Provider => ({
  auth: o.auth,
  call: (c) =>
    Effect.gen(function* () {
      if (o.before) yield* o.before;
      const { onItem } = c;
      const reply = yield* o.respond({
        effort: o.effort,
        input: c.history.flatMap(turnOf),
        instructions: c.instructions,
        model: o.model,
        onOut: onItem && ((out) => onItem(itemOf(out))),
        onStart: c.onStart,
        onText: c.onText,
        onThinking: c.onThinking,
        toolChoice: c.final ? "none" : "auto",
        tools: c.tools.length === 0 ? undefined : c.tools, // a compactor's call has none
      });
      return { dollars: o.dollars?.(reply.usage), items: reply.output.map(itemOf), model: reply.model, usage: reply.usage };
    }).pipe(Effect.mapError((e) => (o.dollars && isEngineError(e) ? priced(e, o.dollars) : e))),
  engine: o.engine,
});
