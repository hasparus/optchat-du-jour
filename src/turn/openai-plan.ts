// The openai-plan turn engine (SPEC "Engines": the master's fallback, Sol on the ChatGPT plan;
// M5): our own tool loop (./loop.ts) on the Responses API, `stream: true` and `store: false`, so
// every request re-sends the whole turn so far. The system prompt goes in `instructions`, byte for
// byte what claude-code gets; the view blocks carry no marks, since OpenAI caches a stable prefix
// by itself. The same provider carries an OpenAI API key for the api-key engine.
import { Effect } from "effect";
import type { EngineError } from "../engines/errors.ts";
import { OpenAiPlan, type Respond, type Turn } from "../openai/responses.ts";
import type { Tokens } from "../usage.ts";
import { type Item, type Provider, type ToolBox, toolLoop } from "./loop.ts";

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

export const openAiPlanTurn = (o: { readonly model: string; readonly effort?: string; readonly instructions: string; readonly toolsFor: (device: string) => ToolBox }) =>
  Effect.gen(function* () {
    const plan = yield* OpenAiPlan;
    const provider = responsesProvider({ auth: "chatgpt-pro", effort: o.effort, engine: "openai-plan", model: o.model, respond: plan.respond });
    return toolLoop({ instructions: o.instructions, provider, ref: `openai-plan:${o.model}`, toolsFor: o.toolsFor });
  });
