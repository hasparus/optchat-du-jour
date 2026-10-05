// One line per model call in usage.jsonl (E11): who called, on which engine and plan, what it cost
// in tokens, and whether it found the view in the cache. A failed write costs the line, never the call.
import { Effect, Schema } from "effect";
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
