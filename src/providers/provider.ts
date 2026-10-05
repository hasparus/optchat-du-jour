// A model behind a request/response API (SPEC "Engines"; M5): the conversation in a neutral form,
// and one call that streams its reply. Our tool loop (src/turn/loop.ts) runs the master on it;
// the api-key compactor sends it a compactor's tries. Each API's own shape is in ./responses.ts
// and ./api-key.ts.
import type { Effect, Schema } from "effect";
import type { EngineError, Tagged } from "../engines/errors.ts";
import type { Part } from "../media/part.ts";
import type { ToolDef } from "../tools/files.ts";
import type { Tokens, UsageRecord } from "../usage.ts";

// The conversation, provider-neutral. `stable` counts a user message's leading parts that stay
// byte-identical from call to call (the view blocks): where a provider puts its cache marks. A
// part is text or an image (SPEC "Media"); images come only after the stable parts.
export type Item =
  | { readonly type: "user"; readonly parts: readonly Part[]; readonly stable?: number }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "call"; readonly id: string; readonly name: string; readonly input: string }
  | { readonly type: "result"; readonly id: string; readonly output: string }
  // a provider's own block, sent back exactly as it came (Anthropic's thinking, with its signature)
  | { readonly type: "kept"; readonly block: Schema.Json };

// A reply: its items in order, what it cost, and `cut` when it stopped short of its end (the
// output limit), so the caller can say so.
export type Step = { readonly items: readonly Item[]; readonly usage: Tokens; readonly model: string; readonly dollars?: number; readonly cut?: string };

export type Call<E extends Tagged> = {
  readonly instructions: string;
  readonly history: readonly Item[];
  readonly tools: readonly ToolDef[];
  readonly final: boolean; // no tool calls in this one
  readonly onText: (delta: string) => Effect.Effect<void>; // live text as it streams
  readonly onThinking?: (tokens: number) => Effect.Effect<void>; // the size of the thought so far; its text is never kept
  // every text and call item of the reply as it completes, in reply order, before the call returns
  readonly onItem?: (item: Item) => Effect.Effect<void, E>;
};

// A failure that still cost something carries it as `spent`, priced on an API key.
export type Provider = {
  readonly engine: UsageRecord["engine"];
  readonly auth: UsageRecord["auth"];
  readonly call: <E extends Tagged = never>(c: Call<E>) => Effect.Effect<Step, EngineError | E>;
};
