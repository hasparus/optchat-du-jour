// What an engine call can fail with (SPEC "How Effect maps onto the reference"). A chain moves on
// to its next engine only on the first two (SPEC "Failover"); the others are reported.
import { Data, Effect, Schema } from "effect";
import { Dollars, type Tokens } from "../usage.ts";

// What a failed call still cost, when the engine knows: usage.jsonl gets a line for it too (E11),
// with its dollars on an API key, so the budget counts it.
export type Spent = { readonly usage: Tokens; readonly model: string | null; readonly dollars?: number };
// `transient`: the failure is the vendor's passing trouble (an overload, a server error, a broken
// or quiet connection), so the same request may go through if sent again (E35, ./retry.ts); set
// where the failure is classified. `retryAfter`: how long the server asked us to wait, in ms.
// `lostLink`: the device runner's connection dropped mid-call and the runner killed claude there;
// the call never got its result (a subagent goes on from its side log after it, E40).
type Fields = {
  readonly message: string;
  readonly spent?: Spent | undefined;
  readonly transient?: boolean | undefined;
  readonly retryAfter?: number | undefined;
  readonly lostLink?: boolean | undefined;
};

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

// Why an Anthropic reply (the Messages API's, or Claude Code's result) stopped short of its end,
// when it did: its output limit, the model's context window, or a stop that isn't a normal end.
// A reply cut short says nothing about its input, so an empty one is no refusal (E33).
const ENDS: ReadonlySet<string> = new Set(["end_turn", "stop_sequence", "tool_use", "pause_turn", "refusal"]);
export const stoppedShort = (stop: string | null | undefined): string | undefined => {
  if (stop === null || stop === undefined || ENDS.has(stop)) return undefined;
  if (stop === "max_tokens") return "the reply reached its token limit";
  if (stop === "model_context_window_exceeded") return "the reply reached the model's context window";
  return `the reply stopped (${stop})`;
};

export const fromResult = (text: string, stopReason: string | null | undefined, spent?: Spent): EngineError => {
  if (stopReason === "refusal") return new Refusal({ message: "the model would not answer this message", spent });
  if (LIMIT.test(text)) return new UsageLimit({ message: text, spent });
  return new ModelError({ message: text, spent });
};

export const priceUsage = (spent: Spent, dollars: (usage: Tokens) => number): Effect.Effect<number, ModelError> => Effect.try({
  try: () => {
    const cost = dollars(spent.usage);
    if (!Schema.is(Dollars)(cost)) throw new Error("invalid price");
    return cost;
  },
  catch: () => new ModelError({ message: "API-key usage cannot be priced safely", spent }),
});

// Two spends as one: what an attempt that failed cost, added to the next one's (a request asked
// again, src/engines/retry.ts). Dollars add up only when both are priced.
export const addSpent = (a: Spent, b: Spent): Spent => {
  const usage = {
    cacheRead: a.usage.cacheRead + b.usage.cacheRead,
    cacheWrite: a.usage.cacheWrite + b.usage.cacheWrite,
    input: a.usage.input + b.usage.input,
    output: a.usage.output + b.usage.output,
  };
  const model = b.model ?? a.model;
  return a.dollars !== undefined && b.dollars !== undefined ? { dollars: a.dollars + b.dollars, model, usage } : { model, usage };
};

// A failure that has a bill: every engine error but an offline device.
export type Billed = ModelError | Refusal | UsageLimit;

// The same failure with some of its fields changed (`patch`), every other one kept: one place, so
// none is dropped on the way.
export const rebuild = (e: Billed, patch: Partial<Fields>): Billed => {
  const fields: Fields = { lostLink: e.lostLink, message: e.message, retryAfter: e.retryAfter, spent: e.spent, transient: e.transient, ...patch };
  switch (e._tag) {
    case "UsageLimit":
      return new UsageLimit(fields);
    case "Refusal":
      return new Refusal(fields);
    case "ModelError":
      return new ModelError(fields);
  }
};

// The failure a request ends with, once it won't be sent again (src/engines/retry.ts): `before`
// (what its earlier tries cost) added to its spend, and no longer marked as one that may pass.
export const settled = (e: EngineError, before: Spent | undefined): EngineError =>
  e._tag === "DeviceOffline" ? e : rebuild(e, { retryAfter: undefined, spent: before === undefined || e.spent === undefined ? (before ?? e.spent) : addSpent(before, e.spent), transient: undefined });

// the same failure, marked as one worth sending again (E35): an HTTP error the server's status or
// `x-should-retry` says will pass, with its `retry-after` (ms) when it gave one
export const passing = (e: EngineError, retryAfter: number | null): EngineError =>
  e._tag === "DeviceOffline" ? e : rebuild(e, { retryAfter: retryAfter ?? undefined, transient: true });

// the same failure with its spend priced: an API key's call that failed still costs dollars
export const priced = (e: EngineError, dollars: (usage: Tokens) => number): EngineError => {
  if (e._tag === "DeviceOffline" || e.spent === undefined) return e;
  let cost: number;
  try {
    cost = dollars(e.spent.usage);
    if (!Schema.is(Dollars)(cost)) throw new Error("invalid price");
  } catch {
    return new ModelError({ message: "API-key usage cannot be priced safely", spent: { ...e.spent, dollars: Schema.is(Dollars)(e.spent.dollars) ? e.spent.dollars : undefined } });
  }
  return rebuild(e, { spent: { ...e.spent, dollars: cost } });
};
