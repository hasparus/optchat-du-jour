// What an engine call can fail with (SPEC "How Effect maps onto the reference"). A chain moves on
// to its next engine only on the first two (SPEC "Failover"); the others are reported.
import { Data } from "effect";

export class UsageLimit extends Data.TaggedError("UsageLimit")<{ readonly message: string }> {}
export class DeviceOffline extends Data.TaggedError("DeviceOffline")<{ readonly message: string }> {}
export class Refusal extends Data.TaggedError("Refusal")<{ readonly message: string }> {}
export class ModelError extends Data.TaggedError("ModelError")<{ readonly message: string }> {}

export type EngineError = DeviceOffline | ModelError | Refusal | UsageLimit;

// Claude Code reports a spent plan or a rate limit as an error result whose text says so
const LIMIT = /usage limit|rate limit|rate_limit|overloaded|\b429\b/i;

export const fromResult = (text: string, stopReason: string | null | undefined): EngineError => {
  if (stopReason === "refusal") return new Refusal({ message: "the model refused this request" });
  if (LIMIT.test(text)) return new UsageLimit({ message: text });
  return new ModelError({ message: text });
};
