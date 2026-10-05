// The Responses API as a provider (./provider.ts): the ChatGPT plan's for openai-plan, or an
// OpenAI API key's for api-key. `stream: true` and `store: false`, so every request re-sends the
// whole conversation; nothing of OpenAI's own (reasoning items) is kept between requests.
import { Effect } from "effect";
import type { EngineError } from "../engines/errors.ts";
import type { Respond, Turn } from "../openai/responses.ts";
import type { Tokens } from "../usage.ts";
import type { Item, Provider } from "./provider.ts";

const turnOf = (item: Item): Turn[] => {
  switch (item.type) {
    case "user":
      return [{ parts: item.parts, role: "user" }];
    case "text":
      return [{ role: "assistant", text: item.text }];
    case "call":
      return [{ arguments: item.input, id: item.id, name: item.name, role: "call" }];
    case "result":
      return [{ id: item.id, output: item.output, role: "output" }];
    case "kept":
      return []; // another provider's block; nothing of the Responses API's is kept
  }
};

export const responsesProvider = (o: {
  readonly respond: Respond;
  readonly model: string;
  readonly effort?: string;
  readonly engine: Provider["engine"];
  readonly auth: Provider["auth"];
  readonly before?: Effect.Effect<void, EngineError>; // e.g. the api-key budget, checked first
  readonly dollars?: (usage: Tokens) => number;
}): Provider => ({
  auth: o.auth,
  call: (c) =>
    Effect.gen(function* () {
      if (o.before) yield* o.before;
      const reply = yield* o.respond({
        effort: o.effort,
        input: c.history.flatMap(turnOf),
        instructions: c.instructions,
        model: o.model,
        onText: c.onText,
        toolChoice: c.final ? "none" : "auto",
        tools: c.tools.length === 0 ? undefined : c.tools, // a compactor's call has none
      });
      const items = reply.output.map((out): Item => (out.type === "text" ? out : { id: out.id, input: out.arguments, name: out.name, type: "call" }));
      return { dollars: o.dollars?.(reply.usage), items, model: reply.model, usage: reply.usage };
    }),
  engine: o.engine,
});
