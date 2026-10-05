// The openai-plan turn engine (SPEC "Engines": the master's fallback, Sol on the ChatGPT plan;
// M5): our own tool loop (./loop.ts) on the Responses API, `stream: true` and `store: false`, so
// every request re-sends the whole turn so far. The system prompt goes in `instructions`, byte for
// byte what claude-code gets; the view blocks carry no marks, since OpenAI caches a stable prefix
// by itself. The same provider carries an OpenAI API key for the api-key engine.
import type { OpenAiPlan } from "../openai/responses.ts";
import { responsesProvider } from "../providers/responses.ts";
import type { ToolBox } from "../tools/box.ts";
import { toolLoop } from "./loop.ts";

export const openAiPlanTurn = (o: {
  readonly model: string;
  readonly effort?: string;
  readonly instructions: string;
  readonly toolsFor: (device: string) => ToolBox;
  readonly plan: OpenAiPlan["Service"];
}) => {
  const provider = responsesProvider({ auth: "chatgpt-pro", effort: o.effort, engine: "openai-plan", model: o.model, respond: o.plan.respond });
  return toolLoop({ instructions: o.instructions, provider, ref: `openai-plan:${o.model}`, toolsFor: o.toolsFor });
};
