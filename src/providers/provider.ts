// A model behind a request/response API (SPEC "Engines"; M5): the conversation in a neutral form,
// and one call that streams its reply. Our tool loop (src/turn/loop.ts) runs the master on it;
// the api-key compactor sends it a compactor's tries. Each API's own shape is in ./responses.ts
// and ./api-key.ts.
import type { Effect, Schema } from "effect";
import type { EngineError } from "../engines/errors.ts";
import type { ToolDef } from "../tools/files.ts";
import type { Tokens, UsageRecord } from "../usage.ts";

// The conversation, provider-neutral. `stable` counts a user message's leading parts that stay
// byte-identical from call to call (the view blocks): where a provider puts its cache marks.
export type Item =
  | { readonly type: "user"; readonly parts: readonly string[]; readonly stable?: number }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "call"; readonly id: string; readonly name: string; readonly input: string }
  | { readonly type: "result"; readonly id: string; readonly output: string }
  // a provider's own block, sent back exactly as it came (Anthropic's thinking, with its signature)
  | { readonly type: "kept"; readonly block: Schema.Json };

export type Step = { readonly items: readonly Item[]; readonly usage: Tokens; readonly model: string; readonly dollars?: number };

export type Provider = {
  readonly engine: UsageRecord["engine"];
  readonly auth: UsageRecord["auth"];
  readonly call: (o: {
    readonly instructions: string;
    readonly history: readonly Item[];
    readonly tools: readonly ToolDef[];
    readonly final: boolean; // no tool calls in this one
    readonly onText: (delta: string) => Effect.Effect<void>;
  }) => Effect.Effect<Step, EngineError>;
};
