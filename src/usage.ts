// One line per model call in usage.jsonl (E11): who called, on which engine and plan, what it cost
// in tokens, and whether it found the view in the cache. A failed write costs the line, never the call.
import { Effect, Predicate, Schema } from "effect";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Usage as ClaudeUsage } from "./claude/events.ts";
import { type Tokens, UsageRecord } from "./wire.ts";

// the record's schema is the clients' too (src/wire.ts: /api/usage)
export { Auth, Engine, Role, Tokens, UsageRecord } from "./wire.ts";

export const tokensOf = (u: ClaudeUsage | undefined): Tokens => ({
  input: u?.input_tokens ?? 0,
  cacheRead: u?.cache_read_input_tokens ?? 0,
  cacheWrite: u?.cache_creation_input_tokens ?? 0,
  output: u?.output_tokens ?? 0,
});

// cold: less than half of what the call read came from the cache (most of it is the view)
export const isCold = (t: Tokens) => t.cacheRead * 2 < t.input + t.cacheRead + t.cacheWrite;

export const logUsage = (path: string, record: UsageRecord) =>
  Effect.sync(() => {
    try {
      appendFileSync(path, `${JSON.stringify(record)}\n`);
      return null;
    } catch (error) {
      return `usage.jsonl: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(UsageRecord));

export const Dollars = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const ValidDate = Schema.String.check(Schema.makeFilter((s) => Number.isFinite(Date.parse(s))));
const BudgetRecord = Schema.Struct({
  ...UsageRecord.fields,
  date: ValidDate,
  dollars: Schema.optional(Dollars),
  usage: Schema.Struct({ input: Schema.Natural, output: Schema.Natural, cacheRead: Schema.Natural, cacheWrite: Schema.Natural }),
}).check(Schema.makeFilter((r) => r.auth !== "api-key" || r.dollars !== undefined));
const decodeBudgetLine = Schema.decodeUnknownOption(Schema.fromJsonString(BudgetRecord));
const decodeLegacyLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  date: ValidDate,
  kind: Schema.String,
  model: Schema.NullOr(Schema.String),
  usage: Schema.Record(Schema.String, Schema.Json),
})), { onExcessProperty: "error" });

export function readBudgetUsage(path: string, read: (path: string) => string = (p) => readFileSync(p, "utf8")): UsageRecord[] {
  let text: string;
  try {
    text = read(path);
  } catch (error) {
    if (Predicate.isObject(error) && "code" in error && error.code === "ENOENT") return [];
    throw new Error("API-key usage ledger is unavailable");
  }
  const records: UsageRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const decoded = decodeBudgetLine(line);
    if (decoded._tag === "Some") records.push(decoded.value);
    else if (decodeLegacyLine(line)._tag !== "Some") throw new Error("API-key usage ledger is invalid");
  }
  return records;
}

// every readable record; lines from the reference's older format ({date, kind, model, usage}) are skipped
export function readUsage(path: string): UsageRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      const r = decodeLine(line);
      return r._tag === "Some" ? [r.value] : [];
    });
}
