// What an engine call can fail with (SPEC "How Effect maps onto the reference"). A chain moves on
// to its next engine only on the first two (SPEC "Failover"); the others are reported.
import { Data } from "effect";
import type { Tokens } from "../usage.ts";

// What a failed call still cost, when the engine knows: usage.jsonl gets a line for it too (E11),
// with its dollars on an API key, so the budget counts it.
export type Spent = { readonly usage: Tokens; readonly model: string | null; readonly dollars?: number };
type Fields = { readonly message: string; readonly spent?: Spent | undefined };

export class UsageLimit extends Data.TaggedError("UsageLimit")<Fields> {}
export class DeviceOffline extends Data.TaggedError("DeviceOffline")<{ readonly message: string }> {}
export class Refusal extends Data.TaggedError("Refusal")<Fields> {}
export class ModelError extends Data.TaggedError("ModelError")<Fields> {}

export type EngineError = DeviceOffline | ModelError | Refusal | UsageLimit;
// any failure with a tag: what an engine's callers may add to its errors (a log that refuses, say)
export type Tagged = { readonly _tag: string };
const ENGINE_ERRORS: ReadonlySet<string> = new Set<EngineError["_tag"]>(["DeviceOffline", "ModelError", "Refusal", "UsageLimit"]);
export const isEngineError = (e: Tagged): e is EngineError => ENGINE_ERRORS.has(e._tag);

// Claude Code reports a spent plan or a rate limit as an error result whose text says so. An
// overload (529) fails over too, though it is transient: the next engine answers now, where a
// failed turn would have the user send again (SPEC "Failover", E4).
const LIMIT = /usage limit|rate limit|rate_limit|overloaded|\b429\b/i;

export const fromResult = (text: string, stopReason: string | null | undefined, spent?: Spent): EngineError => {
  if (stopReason === "refusal") return new Refusal({ message: "the model would not answer this message", spent });
  if (LIMIT.test(text)) return new UsageLimit({ message: text, spent });
  return new ModelError({ message: text, spent });
};

// the same failure with its spend priced: an API key's call that failed still costs dollars
export const priced = (e: EngineError, dollars: (usage: Tokens) => number): EngineError => {
  if (e._tag === "DeviceOffline" || e.spent === undefined) return e;
  const fields = { message: e.message, spent: { ...e.spent, dollars: dollars(e.spent.usage) } };
  switch (e._tag) {
    case "UsageLimit":
      return new UsageLimit(fields);
    case "Refusal":
      return new Refusal(fields);
    case "ModelError":
      return new ModelError(fields);
  }
};
