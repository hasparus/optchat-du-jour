// A tool call's input as the model writes it, before the call is whole (SPEC "Artifacts": an
// artifact's live draft): each piece of its JSON under the call's own id and name, then its end.
// The engines that stream tool input report it through this; it never changes what is logged.
import type { Effect } from "effect";

export type ToolInputHooks = {
  readonly delta: (call: { readonly id: string; readonly name: string }, delta: string) => Effect.Effect<void>;
  readonly end: (id: string) => Effect.Effect<void>;
};
