// A model behind a request/response API (SPEC "Engines"; M5): the conversation in a neutral form,
// and one call that streams its reply. Our tool loop (src/turn/loop.ts) runs the master on it;
// the api-key compactor sends it a compactor's tries. Each API's own shape is in ./responses.ts
// and ./api-key.ts.
import type { Effect, Schema } from "effect";
import type { EngineError, Tagged } from "../engines/errors.ts";
import type { Part } from "../media/part.ts";
import type { ToolDef } from "../tools/files.ts";
import type { Tokens, UsageRecord } from "../usage.ts";

// The conversation, provider-neutral. `marks` counts a user message's leading parts that each end
// at one of the view's cache marks (E26: the view, or a compactor's context, cut at MARKS; the
// piece after the last cut ends where the view does and is not one of them): a provider puts its
// cache breakpoint after each, the same ones in every request. A part is text or an image (SPEC
// "Media"); images come only after the view.
export type Item =
  | { readonly type: "user"; readonly parts: readonly Part[]; readonly marks?: number }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "call"; readonly id: string; readonly name: string; readonly input: string }
  | { readonly type: "result"; readonly id: string; readonly output: string }
  // a provider's own block, sent back exactly as it came to the provider that sent it: Anthropic's
  // thinking with its signature, a Responses reasoning item with its encrypted content (E26)
  | { readonly type: "kept"; readonly provider: "anthropic"; readonly block: Schema.Json }
  | { readonly type: "kept"; readonly provider: "openai"; readonly block: Readonly<Record<string, Schema.Json>> };

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
