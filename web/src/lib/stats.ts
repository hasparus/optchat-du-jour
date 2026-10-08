// usage.jsonl summed up for the Stats screen (SPEC "Web UI", Stats; E11): calls, tokens and cache
// hit rate per local day or week, split by role or engine; per model and effort; cold versus warm
// turns; failovers.
// Pure, so the screen only draws.
import { Engine, Role, type UsageRecord } from "@wire";

export type Period = "day" | "week";
export type Split = "role" | "engine";

export const ROLES = Role.literals;
export const ENGINES = Engine.literals;

export type Bucket = {
  readonly period: string; // YYYY-MM-DD: the day, or the Monday that starts the week
  readonly calls: Readonly<Record<string, number>>; // per role or engine
  readonly tokens: Readonly<Record<string, number>>; // input + cache read + cache write + output
  readonly hitRate: number | null; // cache read / everything read, null with nothing read
  readonly cold: number; // turns that read less than half the view from the cache
  readonly warm: number;
};

export type Totals = {
  readonly calls: number;
  readonly tokens: number;
  readonly hitRate: number | null;
  readonly coldTurns: number;
  readonly turns: number;
  readonly dollars: number;
  readonly failovers: readonly UsageRecord[];
};

const pad = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function periodOf(iso: string, period: Period): string {
  const d = new Date(iso);
  if (period === "week") d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // back to Monday
  return day(d);
}

const read = (r: UsageRecord) => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
const tokens = (r: UsageRecord) => read(r) + r.usage.output;
const rate = (cacheRead: number, all: number) => (all > 0 ? cacheRead / all : null);

export function buckets(records: readonly UsageRecord[], period: Period, split: Split): Bucket[] {
  const acc = new Map<string, { calls: Record<string, number>; tokens: Record<string, number>; cacheRead: number; read: number; cold: number; warm: number }>();
  for (const r of records) {
    const key = periodOf(r.date, period);
    const b = acc.get(key) ?? { cacheRead: 0, calls: {}, cold: 0, read: 0, tokens: {}, warm: 0 };
    const series = split === "role" ? r.role : r.engine;
    b.calls[series] = (b.calls[series] ?? 0) + 1;
    b.tokens[series] = (b.tokens[series] ?? 0) + tokens(r);
    b.cacheRead += r.usage.cacheRead;
    b.read += read(r);
    if (r.role === "turn") {
      if (r.cold) b.cold++;
      else b.warm++;
    }
    acc.set(key, b);
  }
  return [...acc.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, b]) => ({ calls: b.calls, cold: b.cold, hitRate: rate(b.cacheRead, b.read), period: key, tokens: b.tokens, warm: b.warm }));
}

// a bucket's calls or tokens over every series
export function total(series: Readonly<Record<string, number>>) {
  let n = 0;
  for (const v of Object.values(series)) n += v;
  return n;
}

export function totals(records: readonly UsageRecord[]): Totals {
  let cacheRead = 0, all = 0, sum = 0, dollars = 0, coldTurns = 0, turns = 0;
  for (const r of records) {
    cacheRead += r.usage.cacheRead;
    all += read(r);
    sum += tokens(r);
    dollars += r.dollars ?? 0;
    if (r.role === "turn") {
      turns++;
      if (r.cold) coldTurns++;
    }
  }
  return {
    calls: records.length,
    coldTurns,
    dollars,
    failovers: records.filter((r) => r.failoverFrom !== null),
    hitRate: rate(cacheRead, all),
    tokens: sum,
    turns,
  };
}

// what a call ran on, as its record says: the engine, the model and the effort it asked for
// ("claude-code:claude-opus-5-5@xhigh"), so one model at two efforts reads apart
export const ranOn = (r: UsageRecord) => `${r.engine}${r.model === null ? "" : `:${r.model}`}${r.effort === undefined ? "" : `@${r.effort}`}`;

export type ModelRow = { readonly name: string; readonly calls: number; readonly tokens: number; readonly hitRate: number | null };

// calls, tokens and the cache hit rate per model and effort (`ranOn`), the most called first
export function byModel(records: readonly UsageRecord[]): ModelRow[] {
  const acc = new Map<string, { calls: number; tokens: number; cacheRead: number; read: number }>();
  for (const r of records) {
    const name = ranOn(r);
    const m = acc.get(name) ?? { cacheRead: 0, calls: 0, read: 0, tokens: 0 };
    m.calls++;
    m.tokens += tokens(r);
    m.cacheRead += r.usage.cacheRead;
    m.read += read(r);
    acc.set(name, m);
  }
  return [...acc.entries()]
    .map(([name, m]) => ({ calls: m.calls, hitRate: rate(m.cacheRead, m.read), name, tokens: m.tokens }))
    .toSorted((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}
