// What the api-key engine may spend (SPEC "Usage and cost tracking"): a dollar figure per call
// from the price table in optchat.config.ts, and a monthly budget. Before each call the engine asks
// the budget; once this calendar month's api-key dollars in usage.jsonl reach it, every call fails
// with UsageLimit (the chain moves on, or the turn fails visibly) and the UI hears it once.
import { Effect } from "effect";
import type { Price } from "../config.ts";
import { UsageLimit } from "../engines/errors.ts";
import { readUsage, type Tokens, type UsageRecord } from "../usage.ts";

// cache writes split by TTL, when the API reports it (Anthropic's usage.cache_creation)
export type Writes = { readonly m5: number; readonly h1: number };

// dollars for one call; writes not split by TTL are priced at the dearer rate, so the budget errs
// on the side of stopping early
export const dollarsOf = (p: Price, u: Tokens, writes?: Writes) => {
  const w5 = p.cacheWrite5m ?? p.input, w1 = p.cacheWrite1h ?? p.input;
  const writeCost = writes ? writes.m5 * w5 + writes.h1 * w1 : u.cacheWrite * Math.max(w5, w1);
  return (u.input * p.input + u.cacheRead * p.cacheRead + writeCost + u.output * p.output) / 1_000_000;
};

const pad = (n: number) => String(n).padStart(2, "0");
// the local calendar month, "2026-10"
export const monthOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export type Budget = {
  readonly check: Effect.Effect<void, UsageLimit>;
  // every usage record passes here before it is appended to usage.jsonl
  readonly note: (record: UsageRecord) => Effect.Effect<void>;
  readonly spent: () => number;
};

// The month's spend is read from usage.jsonl once per month, then kept up to date in memory.
export const makeBudget = (o: {
  readonly usagePath: string;
  readonly monthly: number;
  readonly report: (message: string) => Effect.Effect<void>;
  readonly now?: () => Date;
}): Budget => {
  const now = o.now ?? (() => new Date());
  let month = "", spent = 0, told = "";
  const roll = () => {
    const m = monthOf(now());
    if (m === month) return;
    month = m;
    spent = readUsage(o.usagePath)
      .filter((r) => r.auth === "api-key" && monthOf(new Date(r.date)) === m)
      .reduce((sum, r) => sum + (r.dollars ?? 0), 0);
  };
  const check = Effect.suspend(() => {
    roll();
    if (spent < o.monthly) return Effect.void;
    const message = `API-key budget for ${month} spent: $${spent.toFixed(2)} of $${o.monthly.toFixed(2)}`;
    const once = told === month ? Effect.void : o.report(message);
    told = month;
    return once.pipe(Effect.andThen(Effect.fail(new UsageLimit({ message }))));
  });
  const note = (record: UsageRecord) =>
    Effect.sync(() => {
      roll();
      if (record.auth === "api-key" && monthOf(new Date(record.date)) === month) spent += record.dollars ?? 0;
    });
  return { check, note, spent: () => spent };
};
