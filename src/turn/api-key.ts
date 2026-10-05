// The api-key engine as the master (SPEC "Engines", api-key: overflow only): its provider
// (src/providers/api-key.ts) in our tool loop, with the same read-only tools as openai-plan.
import { type ApiKeyOptions, apiKeyProvider } from "../providers/api-key.ts";
import type { ToolBox } from "../tools/box.ts";
import { toolLoop } from "./loop.ts";

export const apiKeyTurn = (o: ApiKeyOptions & { readonly instructions: string; readonly toolsFor: (device: string) => ToolBox }) =>
  toolLoop({ instructions: o.instructions, provider: apiKeyProvider(o), ref: o.ref.ref, toolsFor: o.toolsFor });
