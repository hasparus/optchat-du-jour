// What an engine call can fail with (SPEC "How Effect maps onto the reference"). A chain moves on
// to its next engine only on the first two (SPEC "Failover"); the others are reported.
import { Data } from "effect";
import type { Tokens } from "../usage.ts";

// What a failed call still cost, when the engine knows: usage.jsonl gets a line for it too (E11).
export type Spent = { readonly usage: Tokens; readonly model: string | null };
type Fields = { readonly message: string; readonly spent?: Spent | undefined };

export class UsageLimit extends Data.TaggedError("UsageLimit")<Fields> {}
export class DeviceOffline extends Data.TaggedError("DeviceOffline")<{ readonly message: string }> {}
export class Refusal extends Data.TaggedError("Refusal")<Fields> {}
export class ModelError extends Data.TaggedError("ModelError")<Fields> {}

export type EngineError = DeviceOffline | ModelError | Refusal | UsageLimit;

// Claude Code reports a spent plan or a rate limit as an error result whose text says so
const LIMIT = /usage limit|rate limit|rate_limit|overloaded|\b429\b/i;

export const fromResult = (text: string, stopReason: string | null | undefined, spent?: Spent): EngineError => {
  if (stopReason === "refusal") return new Refusal({ message: "the model refused this request", spent });
  if (LIMIT.test(text)) return new UsageLimit({ message: text, spent });
  return new ModelError({ message: text, spent });
};
