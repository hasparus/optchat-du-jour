// The api-key engine (SPEC "Engines", api-key; "Usage and cost tracking") against a fake Messages
// API: our marks with 1-hour entries before 5-minute ones, every call priced from the table, the
// thinking sent back on a retry, and a spent monthly budget that stops the key and says so once.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeBudget } from "../src/apikey/budget.ts";
import { ApiKeys, KEY_SECRETS, apiKeysLayer } from "../src/apikey/clients.ts";
import type { Job } from "../src/compactor.ts";
import { type Settings, loadSettings } from "../src/config.ts";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { memorySecrets } from "../src/secrets.ts";
import { newMsg } from "../src/store.ts";
import { apiKeyCompactor } from "../src/summarize/api-key.ts";
import { apiKeyProvider } from "../src/turn/api-key.ts";
import { type UsageRecord, logUsage } from "../src/usage.ts";
import { fakeAnthropic } from "./fake-anthropic.ts";

const dir = mkdtempSync(`${tmpdir()}/oa-`);
const fake = fakeAnthropic("sk-test");
afterAll(async () => {
  await fake.server.stop(true);
  rmSync(dir, { force: true, recursive: true });
});

const REF = "api-key:anthropic/claude-opus-5-5";
const price = { cacheRead: 0.2, cacheWrite1h: 8, cacheWrite5m: 5, input: 4, output: 20 };
// 100 in × $4 + 500 read × $0.2 + 2000 5-min writes × $5 + 1000 1-hour writes × $8 + 50 out × $20, per million
const DOLLARS = (100 * 4 + 500 * 0.2 + 2000 * 5 + 1000 * 8 + 50 * 20) / 1_000_000;

const settings = (monthlyBudget: number): Settings => ({
  allowedLogins: [],
  apiKey: { anthropicUrl: fake.base, monthlyBudget, prices: { "anthropic/claude-opus-5-5": price } },
  cache: { apiKeyTtls: ["1h", "5m", "5m"], claudeCodeTtl: "1h", primeTtl: "1h" },
  compactor: { byLevel: [{ chain: [REF], from: 0 }], effort: "medium" },
  defaultDevice: "mini",
  devices: { mini: { folders: [], url: "http://127.0.0.1:9" } },
  master: { chain: [REF], effort: "high", permissionMode: "bypassPermissions" },
  openai: DEFAULT_ENDPOINTS,
});

const clients = Effect.runSync(
  Effect.gen(function* () {
    return yield* ApiKeys;
  }).pipe(Effect.provide(apiKeysLayer({ anthropicUrl: fake.base }).pipe(Layer.provide([memorySecrets({ [KEY_SECRETS.anthropic]: "sk-test" }), FetchHttpClient.layer])))),
);

// a compactor engine whose records go through the budget into usage.jsonl, as the server's do
const rig = (monthly: number, usagePath: string) => {
  const reports: string[] = [], records: UsageRecord[] = [];
  const budget = makeBudget({ monthly, report: (m) => Effect.sync(() => void reports.push(m)), usagePath });
  const log = (r: UsageRecord) =>
    budget.note(r).pipe(
      Effect.andThen(logUsage(usagePath, r)),
      Effect.andThen(Effect.sync(() => void records.push(r))),
    );
  const compact = apiKeyCompactor({ budget, clients, effort: "medium", log, ref: REF, settings: settings(monthly) });
  return { budget, compact, records, reports };
};

// enough context for three pieces (cut at 50k and 80k characters)
const job: Job = { ctx: Array.from({ length: 90 }, (_, k) => `user: line ${k} ${"z".repeat(1000)}`), i: 90, l: 0, msg: newMsg(90, "user", "squeeze me") };

const Block = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  cache_control: Schema.optional(Schema.Struct({ ttl: Schema.String })),
});
const Body = Schema.Struct({
  system: Schema.Array(Block),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Array(Block) })),
  tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, input_schema: Schema.Json }))),
  tool_choice: Schema.optional(Schema.Struct({ type: Schema.String })),
  output_config: Schema.optional(Schema.Struct({ effort: Schema.String })),
});
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Body));

test("Anthropic gets 1-hour marks before 5-minute ones on the stable blocks, the thinking back on a retry, and every call is priced", async () => {
  const r = rig(5, `${dir}/priced.jsonl`);
  fake.state.seen.length = 0;
  fake.state.script = [{ text: `user: ${"x".repeat(600)}`, thinking: "too long, but first" }, { text: "user: squeeze me" }];
  expect(await Effect.runPromise(r.compact(job))).toBe("user: squeeze me");

  const [first, retry] = fake.state.seen.map((b) => decodeBody(b));
  expect(fake.state.headers[0]?.get("anthropic-version")).toBe("2023-06-01");
  expect(first?.system.every((b) => b.cache_control === undefined)).toBe(true);
  expect(first?.messages[0]?.content.map((b) => b.cache_control?.ttl ?? null)).toEqual(["1h", "5m", "5m", null]); // three context pieces, the step unmarked
  expect(first?.output_config?.effort).toBe("medium");
  expect(retry?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(JSON.stringify(retry?.messages[0])).toBe(JSON.stringify(first?.messages[0])); // byte-stable, so the marks hit
  expect(retry?.messages[1]?.content[0]).toEqual({ signature: "sig-1", thinking: "too long, but first", type: "thinking" });
  expect(r.records.map((x) => [x.engine, x.auth, x.attempt, x.dollars])).toEqual([
    ["api-key", "api-key", 1, DOLLARS],
    ["api-key", "api-key", 2, DOLLARS],
  ]);

  // as the master: the view's blocks marked, the read-only tools offered, the last round without tools
  const provider = apiKeyProvider({ budget: r.budget, clients, effort: "high", ref: REF, settings: settings(5) });
  const history = [{ parts: ["<chat>\n0+1|user: hi\n</chat>", "what now?"], stable: 1, type: "user" as const }];
  const tools = [{ description: "Read a file", name: "Read", parameters: { properties: { file_path: { type: "string" } }, type: "object" } }];
  await Effect.runPromise(provider.call({ final: false, history, instructions: "MASTER", onText: () => Effect.void, tools }));
  await Effect.runPromise(provider.call({ final: true, history, instructions: "MASTER", onText: () => Effect.void, tools }));
  const [turn, last] = fake.state.seen.slice(-2).map((b) => decodeBody(b));
  expect(turn?.messages[0]?.content.map((b) => b.cache_control?.ttl ?? null)).toEqual(["1h", null]);
  expect(turn?.tools?.map((t) => t.name)).toEqual(["Read"]);
  expect([turn?.tool_choice?.type, last?.tool_choice?.type]).toEqual(["auto", "none"]);
});

// an api-key compactor record from `date` that cost `dollars`
const record = (date: Date, dollars: number): UsageRecord => ({
  attempt: 1,
  auth: "api-key",
  cold: false,
  date: date.toISOString(),
  device: null,
  dollars,
  engine: "api-key",
  failoverFrom: null,
  level: 0,
  model: "claude-opus-5-5",
  ms: 1,
  role: "compact",
  usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
});

test("a spent monthly budget is a UsageLimit, reported once, and nothing more reaches the API", async () => {
  const usagePath = `${dir}/spent.jsonl`;
  const now = new Date();
  // $4.99 this month; last month's $100 doesn't count
  writeFileSync(usagePath, `${JSON.stringify(record(now, 4.99))}\n${JSON.stringify(record(new Date(now.getFullYear(), now.getMonth() - 1, 15), 100))}\n`);
  const r = rig(5, usagePath);
  fake.state.seen.length = 0;
  fake.state.script = [{ text: "user: fits" }];
  expect(await Effect.runPromise(r.compact(job))).toBe("user: fits"); // under budget: this call tips it over
  expect(r.budget.spent()).toBeCloseTo(4.99 + DOLLARS, 9);

  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  for (let k = 0; k < 2; k++) {
    const error = await Effect.runPromise(Effect.flip(r.compact(job)));
    expect(error._tag).toBe("UsageLimit");
    expect(error.message).toBe(`API-key budget for ${month} spent: $5.01 of $5.00`);
  }
  expect(r.reports).toEqual([`API-key budget for ${month} spent: $5.01 of $5.00`]);
  expect(fake.state.seen).toHaveLength(1);
});

test("the config refuses a 5-minute mark before a 1-hour one", async () => {
  const path = `${dir}/optchat.config.ts`;
  const bad = { ...settings(5), cache: { apiKeyTtls: ["5m", "1h"], claudeCodeTtl: "1h", primeTtl: "1h" } };
  writeFileSync(path, `export default ${JSON.stringify(bad)};\n`);
  const error = await Effect.runPromise(Effect.flip(loadSettings(path)));
  expect(error.message).toContain('every "1h" before any "5m"');
});
