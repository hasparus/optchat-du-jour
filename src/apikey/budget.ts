// What the api-key engine may spend (SPEC "Usage and cost tracking"): a dollar figure per call
// from the price table in optchat.config.ts, and a monthly budget. Before each call the engine asks
// the budget; once this calendar month's api-key dollars in usage.jsonl reach it, every call fails
// with UsageLimit (the chain moves on, or the turn fails visibly) and the UI hears it once.
import { Effect, Schema } from "effect";
import type { Price } from "../config.ts";
import { ModelError, UsageLimit } from "../engines/errors.ts";
import { Dollars, readBudgetUsage, type Tokens, type UsageRecord } from "../usage.ts";

// cache writes split by TTL, when the API reports it (Anthropic's usage.cache_creation)
export type Writes = { readonly m5: number; readonly h1: number };

// dollars for one call; writes not split by TTL are priced at the dearer rate, so the budget errs
// on the side of stopping early
export const dollarsOf = (p: Price, u: Tokens, writes?: Writes) => {
  const w5 = p.cacheWrite5m ?? p.input, w1 = p.cacheWrite1h ?? p.input;
  if (![p.input, p.output, p.cacheRead, w5, w1].every(validDollars) || !Object.values(u).every(Schema.is(Schema.Natural)) ||
    (writes !== undefined && (!Object.values(writes).every(Schema.is(Schema.Natural)) || writes.m5 + writes.h1 !== u.cacheWrite))) throw new Error("API-key usage cannot be priced safely");
  const writeCost = writes ? writes.m5 * w5 + writes.h1 * w1 : u.cacheWrite * Math.max(w5, w1);
  const total = u.input * p.input + u.cacheRead * p.cacheRead + writeCost + u.output * p.output;
  const dollars = Number.isFinite(total) ? total / 1_000_000 :
    (u.input / 1_000_000) * p.input + (u.cacheRead / 1_000_000) * p.cacheRead + (u.output / 1_000_000) * p.output +
    (writes ? (writes.m5 / 1_000_000) * w5 + (writes.h1 / 1_000_000) * w1 : (u.cacheWrite / 1_000_000) * Math.max(w5, w1));
  if (!validDollars(dollars)) throw new Error("API-key usage cannot be priced safely");
  return dollars;
};

const pad = (n: number) => String(n).padStart(2, "0");
// the local calendar month, "2026-10"
export const monthOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export type Budget = {
  readonly check: Effect.Effect<void, UsageLimit | ModelError>;
  // every usage record passes here before it is appended to usage.jsonl
  readonly note: (record: UsageRecord) => Effect.Effect<void>;
  readonly spent: () => number;
};

type Balance = { spent: number; quarantined: boolean };
const validDollars = Schema.is(Dollars);
const unavailable = () => new ModelError({ message: "API-key budget unavailable: usage ledger cannot establish a safe balance; reconcile the ledger before restarting" });

export const makeBudget = (o: {
  readonly usagePath: string;
  readonly monthly: number;
  readonly report: (message: string) => Effect.Effect<void>;
  readonly now?: () => Date;
}): Budget => {
  const now = o.now ?? (() => new Date());
  const months = new Map<string, Balance>();
  const told = new Set<string>();
  let spent = 0;
  const load = (month: string): Balance => {
    const known = months.get(month);
    if (known) return known;
    let total = 0;
    for (const r of readBudgetUsage(o.usagePath)) {
      if (r.auth !== "api-key" || monthOf(new Date(r.date)) !== month) continue;
      total += r.dollars!;
      if (!validDollars(total)) throw unavailable();
    }
    const balance = { quarantined: false, spent: total };
    months.set(month, balance);
    return balance;
  };
  const check = Effect.gen(function* () {
    const result = yield* Effect.try({
      try: () => {
        const month = monthOf(now());
        const balance = load(month);
        spent = balance.spent;
        if (balance.quarantined) throw unavailable();
        if (balance.spent < o.monthly) return null;
        const message = `API-key budget for ${month} spent: $${balance.spent.toFixed(2)} of $${o.monthly.toFixed(2)}`;
        const report = !told.has(month);
        told.add(month);
        return { message, report };
      },
      catch: unavailable,
    });
    if (result === null) return;
    if (result.report) yield* Effect.suspend(() => o.report(result.message)).pipe(Effect.catchCause(() => Effect.void));
    return yield* new UsageLimit({ message: result.message });
  });
  const note = (record: UsageRecord) => Effect.sync(() => {
    if (record.auth !== "api-key") return;
    const date = new Date(record.date);
    const month = monthOf(Number.isFinite(date.getTime()) ? date : now());
    let balance: Balance;
    try {
      balance = load(month);
    } catch {
      balance = { quarantined: true, spent: 0 };
      months.set(month, balance);
    }
    if (!Number.isFinite(date.getTime()) || !validDollars(record.dollars)) balance.quarantined = true;
    else {
      const total = balance.spent + record.dollars;
      if (validDollars(total)) balance.spent = total;
      else balance.quarantined = true;
    }
    if (month === monthOf(now())) spent = balance.spent;
  });
  return { check, note, spent: () => spent };
};
