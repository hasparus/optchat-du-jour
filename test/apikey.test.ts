// The api-key engine (SPEC "Engines", api-key; "Usage and cost tracking") against a fake Messages
// API: our cache layout (docs/optchat.md §3.3: a 5-minute mark on the view's last whole block and
// the top-level automatic one), every call priced from the table, the thinking sent back on a retry, and a spent
// monthly budget that stops the key and says so once.
import { afterAll, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { makeBudget } from "../src/apikey/budget.ts";
import { ApiKeys, KEY_SECRETS, apiKeysLayer } from "../src/apikey/clients.ts";
import type { Job } from "../src/compactor.ts";
import { type ApiKeyRef, Settings, loadSettings, parseSettings } from "../src/config.ts";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { memorySecrets } from "../src/secrets.ts";
import { newMsg } from "../src/store.ts";
import { type EngineNeeds, providerOf } from "../src/engines/registry.ts";
import { apiKeyCompactor } from "../src/summarize/api-key.ts";
import { apiKeyProvider } from "../src/providers/api-key.ts";
import type { ToolBox } from "../src/tools/box.ts";
import type { TurnEvents, TurnInput } from "../src/turn/engine.ts";
import { toolLoop } from "../src/turn/loop.ts";
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

const settings = (monthlyBudget: number): Settings =>
  parseSettings({
    allowedLogins: [],
    apiKey: { anthropicUrl: fake.base, monthlyBudget, prices: { "anthropic/claude-opus-5-5": price } },
    cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
    compactor: { byLevel: [{ chain: [REF], from: 0 }], effort: "medium" },
    defaultDevice: "mini",
    devices: { mini: { folders: [], url: "http://127.0.0.1:9" } },
    master: { chain: [REF], effort: "high", permissionMode: "bypassPermissions" },
    openai: DEFAULT_ENDPOINTS,
  });
// REF as the config decodes it
const API_KEY: ApiKeyRef = { engine: "api-key", model: "claude-opus-5-5", provider: "anthropic", ref: REF };

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
  const needs: EngineNeeds = { apiKeys: Effect.succeed(clients), budget, log, plan: Effect.never, report: () => Effect.void, settings: settings(monthly) };
  const compact = apiKeyCompactor({ log, provider: Effect.runSync(providerOf(API_KEY, needs, "medium")) });
  return { budget, compact, records, reports };
};

// <chat>, 110 lines, </chat>: 27 whole blocks of 4 lines, then the partial one with </chat>
const job: Job = { ctx: Array.from({ length: 110 }, (_, k) => `user: line ${k} ${"z".repeat(1000)}`), i: 110, l: 0, msg: newMsg(110, "user", "squeeze me") };

const Block = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  cache_control: Schema.optional(Schema.Struct({ type: Schema.String, ttl: Schema.optional(Schema.String) })),
});
const Body = Schema.Struct({
  system: Schema.Array(Block),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Array(Block) })),
  tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, input_schema: Schema.Json }))),
  tool_choice: Schema.optional(Schema.Struct({ type: Schema.String })),
  output_config: Schema.optional(Schema.Struct({ effort: Schema.String })),
  cache_control: Schema.optional(Schema.Struct({ type: Schema.String, ttl: Schema.optional(Schema.String) })),
});
const decodeBody = Schema.decodeUnknownSync(Schema.fromJsonString(Body));

// a block's mark as sent, "5m" for one with no TTL (the API's default), null for none
const markOf = (b: typeof Block.Type) => (b.cache_control === undefined ? null : `${b.cache_control.type} ${b.cache_control.ttl ?? "5m"}`);

test("Anthropic gets our cache layout: a 5-minute mark on the last whole block and the request end, the thinking back on a retry, and every call is priced", async () => {
  const r = rig(5, `${dir}/priced.jsonl`);
  fake.state.seen.length = 0;
  fake.state.script = [{ text: `user: ${"x".repeat(600)}`, thinking: "too long, but first" }, { text: "user: squeeze me" }];
  expect(await Effect.runPromise(r.compact(job))).toBe("user: squeeze me");

  const [first, retry] = fake.state.seen.map((b) => decodeBody(b));
  expect(fake.state.headers[0]?.get("anthropic-version")).toBe("2023-06-01");
  expect(first?.system.every((b) => b.cache_control === undefined)).toBe(true);
  // 28 context pieces, a mark on the last whole one (the 27th); the partial piece and the step are
  // read through the request end's automatic mark, so the size retry reads the whole first try
  expect(first?.messages[0]?.content.map(markOf)).toEqual(Array.from({ length: 29 }, (_, k) => (k === 26 ? "ephemeral 5m" : null)));
  expect(first?.cache_control).toEqual({ type: "ephemeral" });
  expect(fake.state.seen.every((b) => !b.includes('"1h"'))).toBe(true);
  expect(first?.output_config?.effort).toBe("medium");
  expect(retry?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(JSON.stringify(retry?.messages[0])).toBe(JSON.stringify(first?.messages[0])); // byte-stable, so the marks hit
  expect(retry?.cache_control).toEqual({ type: "ephemeral" });
  expect(retry?.messages[1]?.content[0]).toEqual({ signature: "sig-1", thinking: "too long, but first", type: "thinking" });
  expect(r.records.map((x) => [x.engine, x.auth, x.attempt, x.dollars])).toEqual([
    ["api-key", "api-key", 1, DOLLARS],
    ["api-key", "api-key", 2, DOLLARS],
  ]);

  // as the master: the view's blocks marked, the read-only tools offered, the last round without tools
  const provider = apiKeyProvider({ budget: r.budget, clients, effort: "high", ref: API_KEY, settings: settings(5) });
  const history = [{ mark: 0, parts: ["<chat>\n0+1|user: hi\n", "1+1|talk: hello\n</chat>", "what now?"], type: "user" as const }];
  const tools = [{ description: "Read a file", name: "Read", parameters: { properties: { file_path: { type: "string" } }, type: "object" } }];
  await Effect.runPromise(provider.call({ final: false, history, instructions: "MASTER", onText: () => Effect.void, tools }));
  await Effect.runPromise(provider.call({ final: true, history, instructions: "MASTER", onText: () => Effect.void, tools }));
  const [turn, last] = fake.state.seen.slice(-2).map((b) => decodeBody(b));
  expect(turn?.messages[0]?.content.map(markOf)).toEqual(["ephemeral 5m", null, null]);
  expect([turn?.cache_control, last?.cache_control]).toEqual([{ type: "ephemeral" }, { type: "ephemeral" }]);
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

test("an older config with cache.apiKeyTtls still loads, the key ignored; an engine ref the config can't decode is refused", async () => {
  const written = Schema.encodeSync(Settings)(settings(5));
  let configs = 0;
  // an older config's shape: what Settings takes, and anything it no longer does
  const write = (config: typeof Settings.Encoded | Readonly<Record<string, Schema.Json>>) => {
    const path = `${dir}/optchat-${++configs}.config.ts`; // a module is imported once per path
    writeFileSync(path, `export default ${JSON.stringify(config)};\n`);
    return path;
  };
  const refused = async (config: typeof Settings.Encoded) => {
    const error = await Effect.runPromise(Effect.flip(loadSettings(write(config))));
    return error.message;
  };
  // docs/optchat.md §3.3 leaves nothing to set on a key; the old setting is dropped like any unknown key
  const old = await Effect.runPromise(loadSettings(write({ ...written, cache: { ...written.cache, apiKeyTtls: ["1h", "5m", "5m", "5m"] } })));
  expect(old.cache).toEqual({ claudeCodeTtl: "1h", primeTtl: "1h" });
  expect(await refused({ ...written, master: { ...written.master, chain: ["gpt:x"] } })).toContain("engine gpt:x: no such engine");
  expect(await refused({ ...written, master: { ...written.master, chain: ["api-key:claude-sonnet"] } })).toContain("must be api-key:anthropic/<model>");
});

// the master's tool loop on the api-key engine, run as the session runs it: entries logged, live
// text with the log index its entry will get, thoughts, notices and usage records kept
const turnRig = (rounds?: number) => {
  const usagePath = `${dir}/turn-${crypto.randomUUID()}.jsonl`;
  const reports: string[] = [], records: UsageRecord[] = [], log: [string, string][] = [], texts: [number, string][] = [], infos: string[] = [], thoughts: number[] = [];
  const budget = makeBudget({ monthly: 5, report: (m) => Effect.sync(() => void reports.push(m)), usagePath });
  const box: ToolBox = { defs: [{ description: "Read a file", name: "Read", parameters: { type: "object" } }], run: (name) => Effect.succeed(`${name} ran`) };
  const engine = toolLoop({ instructions: "MASTER", provider: apiKeyProvider({ budget, clients, effort: "high", ref: API_KEY, settings: settings(5) }), ref: REF, rounds, toolsFor: () => box, vision: false });
  const out: TurnEvents = {
    info: (m) => Effect.sync(() => void infos.push(m)),
    log: (kind, text) => Effect.sync(() => void log.push([kind, text])),
    text: (delta) => Effect.sync(() => void texts.push([log.length, delta])),
    thinking: (tokens) => Effect.sync(() => void thoughts.push(tokens)),
    took: () => Effect.void,
    usage: (r) => budget.note(r).pipe(Effect.andThen(Effect.sync(() => void records.push(r)))),
  };
  const input: TurnInput = { device: "mini", earlier: [], media: [], mid: { next: Effect.never, ready: Effect.succeed([]) }, texts: ["go"], view: "<chat>\n</chat>" };
  const run = Effect.runPromise(Effect.flip(engine.run(input, out, null)).pipe(Effect.option));
  return { budget, infos, log, records, run, texts, thoughts };
};

test("on the tool loop each block is logged as it completes, so text after a call streams as its own entry; thoughts go out by size, a cut reply is said", async () => {
  fake.state.script = [
    { after: "Then I answer.", calls: [{ input: { file_path: "a.txt" }, name: "Read" }], text: "Let me look.", thinking: "x".repeat(40) },
    { stop: "max_tokens", text: "Done." },
  ];
  const t = turnRig();
  expect(Option.isNone(await t.run)).toBe(true);
  expect(t.log).toEqual([
    ["talk", "Let me look."],
    ["tool", 'Read {"file_path":"a.txt"}'],
    ["talk", "Then I answer."],
    ["echo", "Read ran"],
    ["talk", "Done."],
  ]);
  // each piece of live text names the index its own entry then got
  expect(t.texts).toEqual([
    [0, "Let me look."],
    [2, "Then I answer."],
    [4, "Done."],
  ]);
  expect(t.thoughts).toEqual([10]);
  expect(t.infos).toEqual([`${REF}: the reply reached its 64000-token limit, so it may stop mid-sentence or mid-call`]);
});

test("a call on the last request is answered in the log as not run; a refused request still records what it cost, against the budget", async () => {
  fake.state.script = [{ calls: [{ input: { file_path: "a.txt" }, name: "Read" }] }];
  const last = turnRig(1);
  expect(Option.isNone(await last.run)).toBe(true);
  expect(last.log).toEqual([
    ["tool", 'Read {"file_path":"a.txt"}'],
    ["echo", "not run: this turn used its 1 requests"],
  ]);
  expect(last.infos).toEqual([`${REF} stopped after 1 requests with tool calls left`]);

  fake.state.script = [{ stop: "refusal", text: "" }];
  const refused = turnRig();
  const error = await refused.run;
  expect(Option.getOrUndefined(error)?._tag).toBe("Refusal");
  expect(refused.records.map((r) => [r.role, r.model, r.dollars])).toEqual([["turn", "fake-opus", (100 * 4 + 500 * 0.2 + 3000 * 8 + 50 * 20) / 1_000_000]]);
  expect(refused.budget.spent()).toBeGreaterThan(0);

  // a compactor try that is refused is priced too
  const compactor = rig(5, `${dir}/refused.jsonl`);
  fake.state.script = [{ stop: "refusal", text: "" }];
  const declined = await Effect.runPromise(Effect.flip(compactor.compact(job)));
  expect(declined._tag).toBe("Refusal");
  expect(compactor.records.map((r) => [r.role, r.dollars])).toEqual([["compact", (100 * 4 + 500 * 0.2 + 3000 * 8 + 50 * 20) / 1_000_000]]);
});
