// One line per model call in usage.jsonl (E11): who called, on which engine and plan, what it cost
// in tokens, and whether it found the view in the cache. A failed write costs the line, never the call.
import { Effect, Schema } from "effect";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { Usage as ClaudeUsage } from "./claude/events.ts";

export const Role = Schema.Literals(["turn", "prime", "compact", "subagent"]);
export const Engine = Schema.Literals(["claude-code", "openai-plan", "api-key"]);
export const Auth = Schema.Literals(["claude-max", "chatgpt-pro", "api-key"]);

export const Tokens = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
});
export type Tokens = typeof Tokens.Type;

export const UsageRecord = Schema.Struct({
  date: Schema.String,
  role: Role,
  engine: Engine,
  auth: Auth,
  model: Schema.NullOr(Schema.String),
  device: Schema.NullOr(Schema.String),
  level: Schema.NullOr(Schema.Number),
  usage: Tokens,
  cold: Schema.Boolean,
  attempt: Schema.Number,
  failoverFrom: Schema.NullOr(Schema.String),
  ms: Schema.Number,
  dollars: Schema.optional(Schema.Number),
});
export type UsageRecord = typeof UsageRecord.Type;

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
