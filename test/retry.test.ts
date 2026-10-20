// Our own HTTP engines ask a request again when it failed on the vendor's side (E35, after
// UniiChat's Agent.step; docs/uniichat.md), against a raw fake HTTP server (test/fake-http.ts):
// overloads, server errors and dropped connections are sent again, `retry-after` and
// `x-should-retry` are heeded, a limit that is no hiccup goes to the chain at once, a stream that
// goes quiet is cut, and nothing that already went out is ever asked for twice. No model.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { makeMessages, type MessagesAsk } from "../src/apikey/anthropic.ts";
import { HTTP_RETRY_BASE, HTTP_RETRY_LONGEST, HTTP_TRIES, IDLE_ANTHROPIC, IDLE_OPENAI } from "../src/config.ts";
import { type EngineError, UsageLimit } from "../src/engines/errors.ts";
import { EngineRetry, type RetryPolicy } from "../src/engines/retry.ts";
import { type Ask, makeResponses } from "../src/openai/responses.ts";
import { fakeHttp, sse, type Step } from "./fake-http.ts";

const server = fakeHttp();
afterAll(() => {
  server.stop();
});

// short pauses, so a test takes milliseconds; the shipped ones are checked below
const fast: RetryPolicy = { base: "5 millis", longest: "1 second", tries: 4 };
const run = async <A>(effect: Effect.Effect<A, EngineError>) =>
  Effect.runPromise(Effect.result(effect).pipe(Effect.provideService(EngineRetry, fast), Effect.provide(FetchHttpClient.layer)));
const fresh = (...steps: readonly Step[]) => {
  server.script.length = 0;
  server.bodies.length = 0;
  server.script.push(...steps);
};

// Anthropic's Messages stream: message_start (10 input tokens), a text block, the end
const USAGE = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 10, output_tokens: 1 };
const start = sse({ message: { model: "fake-opus", usage: USAGE }, type: "message_start" });
const text = (t: string) => [
  sse({ content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" }),
  sse({ delta: { text: t, type: "text_delta" }, index: 0, type: "content_block_delta" }),
  sse({ index: 0, type: "content_block_stop" }),
];
const stop = [sse({ delta: { stop_reason: "end_turn" }, type: "message_delta", usage: { output_tokens: 5 } }), sse({ type: "message_stop" })];
const whole = (t: string): Step => ({ chunks: [start, ...text(t), ...stop], after: "end" });
const apiError = (status: number, type: string, message = "no", headers: Readonly<Record<string, string>> = {}): Step => ({ body: JSON.stringify({ error: { message, type }, type: "error" }), headers, status });

const messages = Effect.runSync(makeMessages({ base: server.base, idle: "150 millis", key: Effect.succeed("sk-test") }).pipe(Effect.provide(FetchHttpClient.layer)));
const ask = (o: Partial<MessagesAsk> = {}): MessagesAsk => ({ history: [{ parts: ["hi"], type: "user" }], model: "claude-test", system: "SYSTEM", ...o });
const textOf = (r: { readonly items: readonly { readonly type: string; readonly text?: string }[] }) => r.items.map((i) => i.text ?? "").join("");

test("the shipped policy: 4 tries, from 1 s doubling, a retry-after of a minute at most; a stream quiet for 5 min (Anthropic) or 20 (OpenAI) is dead", () => {
  expect([HTTP_TRIES, HTTP_RETRY_BASE, HTTP_RETRY_LONGEST, IDLE_ANTHROPIC, IDLE_OPENAI]).toEqual([4, "1 second", "60 seconds", "5 minutes", "20 minutes"]);
});

test("Anthropic: an overload, a server error and a dropped connection are each sent again, the same request; the reply that gets through is the answer", async () => {
  fresh(apiError(529, "overloaded_error"), apiError(500, "api_error"), { drop: true }, whole("hello"));
  const out = await run(messages(ask()));
  expect(out._tag).toBe("Success");
  if (out._tag === "Success") expect(textOf(out.success)).toBe("hello");
  expect(server.bodies).toHaveLength(4);
  expect(new Set(server.bodies).size).toBe(1);
});

test("Anthropic: retry-after is waited for; one past HTTP_RETRY_LONGEST, a spent key or x-should-retry: false goes to the failover chain at once; out of tries, the last failure stands", async () => {
  fresh(apiError(429, "rate_limit_error", "slow down", { "retry-after-ms": "120" }), whole("after the wait"));
  const t0 = performance.now();
  const waited = await run(messages(ask()));
  expect(waited._tag).toBe("Success");
  expect(performance.now() - t0).toBeGreaterThanOrEqual(115);

  // a minute and more is a limit: the chain moves on now (E4), with the failure as it was
  fresh(apiError(429, "rate_limit_error", "come back later", { "retry-after": "3600" }));
  const later = await run(messages(ask()));
  expect(later._tag === "Failure" && later.failure).toBeInstanceOf(UsageLimit);
  expect(server.bodies).toHaveLength(1);

  fresh(apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.", { "x-should-retry": "true" }));
  const broke = await run(messages(ask()));
  expect(broke._tag).toBe("Failure");
  expect(server.bodies).toHaveLength(1);

  fresh(apiError(500, "api_error", "broken", { "x-should-retry": "false" }));
  const told = await run(messages(ask()));
  expect(told._tag === "Failure" && told.failure._tag).toBe("ModelError");
  expect(server.bodies).toHaveLength(1);

  // a 400 the server says to send again is sent again
  fresh(apiError(400, "invalid_request_error", "try me again", { "x-should-retry": "true" }), whole("ok"));
  const again = await run(messages(ask()));
  expect(again._tag).toBe("Success");

  fresh(...Array.from({ length: 6 }, () => apiError(529, "overloaded_error")));
  const spent = await run(messages(ask()));
  expect(spent._tag === "Failure" && spent.failure).toBeInstanceOf(UsageLimit); // overloaded: the chain's to move on
  expect(server.bodies).toHaveLength(4);
  // the retries are over: the failure the call ends with no longer says it may pass
  expect(spent._tag === "Failure" && spent.failure._tag !== "DeviceOffline" && [spent.failure.transient, spent.failure.retryAfter]).toEqual([undefined, undefined]);
});

test("Anthropic: a stream quiet for `idle` is cut and sent again, and what the cut try cost counts; once text went out it is not sent again", async () => {
  // started (10 input tokens told), then nothing: cut after 150 ms, and asked again
  fresh({ chunks: [start], after: "hang" }, whole("second try"));
  const quiet = await run(messages(ask()));
  expect(quiet._tag).toBe("Success");
  if (quiet._tag === "Success") {
    expect(textOf(quiet.success)).toBe("second try");
    expect(quiet.success.usage.input).toBe(20); // both tries' input
  }
  // a connection that breaks mid-stream, before any text: asked again too
  fresh({ chunks: [start], after: "cut" }, whole("ok"));
  const mended = await run(messages(ask()));
  expect(mended._tag).toBe("Success");
  expect(server.bodies).toHaveLength(2);

  // once a delta went out (to the log, to clients), a second answer would show twice: the failure stands
  const shown: string[] = [];
  fresh({ chunks: [start, text("par")[0] ?? "", text("par")[1] ?? ""], after: "hang" }, whole("never"));
  const cut = await run(messages(ask({ onText: (d) => Effect.sync(() => void shown.push(d)) })));
  expect(cut._tag === "Failure" && cut.failure.message).toBe("api-key: anthropic: no word from the API in 150ms");
  expect(cut._tag === "Failure" && cut.failure._tag !== "DeviceOffline" && cut.failure.spent?.usage.input).toBe(10);
  expect(shown).toEqual(["par"]);
  expect(server.bodies).toHaveLength(1);
});

test("Anthropic: a stream quiet after an artifact's input went out as a live draft is not sent again; after a Read's input, it is", async () => {
  const toolUse = (name: string) => [
    start,
    sse({ content_block: { id: "toolu_1", input: {}, name, type: "tool_use" }, index: 0, type: "content_block_start" }),
    sse({ delta: { partial_json: '{"name":"Plan"', type: "input_json_delta" }, index: 0, type: "content_block_delta" }),
  ];
  const pieces: string[] = [];
  const onToolInput = { delta: (_call: { readonly id: string; readonly name: string }, piece: string) => Effect.sync(() => void pieces.push(piece)), end: () => Effect.void };
  fresh({ after: "hang", chunks: toolUse("publish_artifact") }, whole("never"));
  const drafted = await run(messages(ask({ onToolInput })));
  expect(drafted._tag === "Failure" && drafted.failure.message).toBe("api-key: anthropic: no word from the API in 150ms");
  expect(pieces).toEqual(['{"name":"Plan"']);
  expect(server.bodies).toHaveLength(1);
  // a Read's input reaches no client: the quiet try is sent again
  fresh({ after: "hang", chunks: toolUse("Read") }, whole("read it"));
  const read = await run(messages(ask({ onToolInput })));
  expect(read._tag === "Success" && textOf(read.success)).toBe("read it");
  expect(server.bodies).toHaveLength(2);
});

test("Anthropic: what a try that may pass cost still counts when the try after it fails with what won't: a 400, a refusal, a spent key, a long retry-after", async () => {
  // 100,000 input tokens told, then silence: cut, and sent again
  const big = sse({ message: { model: "fake-opus", usage: { ...USAGE, input_tokens: 100_000 } }, type: "message_start" });
  const enders: readonly (readonly [string, Step])[] = [
    ["a 400", apiError(400, "invalid_request_error", "bad")],
    ["a refusal", { after: "end", chunks: [start, sse({ delta: { stop_reason: "refusal" }, type: "message_delta", usage: { output_tokens: 1 } }), sse({ type: "message_stop" })] }],
    ["a spent key", apiError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API.")],
    ["a retry-after of an hour", apiError(429, "rate_limit_error", "later", { "retry-after": "3600" })],
  ];
  for (const [what, end] of enders) {
    fresh({ after: "hang", chunks: [big] }, end);
    const out = await run(messages(ask()));
    expect(server.bodies).toHaveLength(2);
    const spent = out._tag === "Failure" && out.failure._tag !== "DeviceOffline" ? out.failure.spent : undefined;
    // the first try's 100,000, plus the second's own when it told any (the refusal's 10)
    expect([what, spent?.usage.input]).toEqual([what, what === "a refusal" ? 100_010 : 100_000]);
  }
});

// the Responses API (openai-plan; api-key on OpenAI)
const usage = { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 };
const done = (t: string): Step => ({
  chunks: [
    sse({ type: "response.created" }),
    sse({ delta: t, type: "response.output_text.delta" }),
    sse({ item: { content: [{ text: t, type: "output_text" }], type: "message" }, type: "response.output_item.done" }),
    sse({ response: { model: "fake-luna", usage }, type: "response.completed" }),
  ],
  after: "end",
});
const openAiError = (status: number, code: string): Step => ({ body: JSON.stringify({ error: { code, message: "no" } }), status });
const respond = Effect.runSync(
  makeResponses({ api: server.base, bearer: { current: Effect.succeed("token"), renew: () => Effect.succeed("token") }, idle: "150 millis", label: "openai-plan" }).pipe(Effect.provide(FetchHttpClient.layer)),
);
const askOpenAi: Ask = { input: [{ parts: ["hi"], role: "user" }], instructions: "SYSTEM", model: "gpt-test" };

test("Responses: a server error, an unavailable server and a failed stream are sent again; the plan's cap is the chain's at once", async () => {
  fresh(openAiError(500, "server_error"), openAiError(503, "unavailable"), { chunks: [sse({ type: "response.created" }), sse({ response: { error: { code: "server_error", message: "oops" }, usage }, type: "response.failed" })], after: "end" }, done("hello"));
  const out = await run(respond(askOpenAi));
  expect(out._tag === "Success" && out.success.text).toBe("hello");
  expect(out._tag === "Success" && out.success.usage.input).toBe(10); // the failed stream told its usage: counted
  expect(server.bodies).toHaveLength(4);

  // the weekly cap of the plan (and a key out of quota) is no hiccup
  fresh(openAiError(429, "subscription_sharing_usage_limit_exceeded"), done("never"));
  const capped = await run(respond(askOpenAi));
  expect(capped._tag === "Failure" && capped.failure).toBeInstanceOf(UsageLimit);
  expect(server.bodies).toHaveLength(1);

  // a refusal is the model's answer, never sent again
  fresh({ chunks: [sse({ delta: "no", type: "response.refusal.delta" }), sse({ response: { model: "fake-luna", usage }, type: "response.completed" })], after: "end" }, done("never"));
  const refused = await run(respond(askOpenAi));
  expect(refused._tag === "Failure" && refused.failure._tag).toBe("Refusal");
  expect(server.bodies).toHaveLength(1);
});

test("Responses: a stream quiet for `idle` is cut and sent again; one whose reasoning or text went out is not", async () => {
  fresh({ chunks: [sse({ type: "response.created" })], after: "hang" }, done("second"));
  const out = await run(respond(askOpenAi));
  expect(out._tag === "Success" && out.success.text).toBe("second");
  expect(server.bodies).toHaveLength(2);

  const shown: string[] = [];
  fresh({ chunks: [sse({ type: "response.created" }), sse({ delta: "half", type: "response.output_text.delta" })], after: "hang" }, done("never"));
  const cut = await run(respond({ ...askOpenAi, onText: (d) => Effect.sync(() => void shown.push(d)) }));
  expect(cut._tag === "Failure" && cut.failure.message).toBe("openai-plan: no word from the API in 150ms");
  expect(shown).toEqual(["half"]);
  expect(server.bodies).toHaveLength(1);
});

test("Responses: a stream quiet after an artifact's arguments went out as a live draft is not sent again; after a Read's, it is", async () => {
  const call = (name: string) => [
    sse({ type: "response.created" }),
    sse({ item: { call_id: "call_1", id: "fc_1", name, type: "function_call" }, output_index: 0, type: "response.output_item.added" }),
    sse({ delta: '{"name":"Plan"', item_id: "fc_1", output_index: 0, type: "response.function_call_arguments.delta" }),
  ];
  const pieces: string[] = [];
  const onToolInput = { delta: (_call: { readonly id: string; readonly name: string }, piece: string) => Effect.sync(() => void pieces.push(piece)), end: () => Effect.void };
  fresh({ after: "hang", chunks: call("edit_artifact") }, done("never"));
  const drafted = await run(respond({ ...askOpenAi, onToolInput }));
  expect(drafted._tag === "Failure" && drafted.failure.message).toBe("openai-plan: no word from the API in 150ms");
  expect(pieces).toEqual(['{"name":"Plan"']);
  expect(server.bodies).toHaveLength(1);
  fresh({ after: "hang", chunks: call("Read") }, done("read it"));
  const read = await run(respond({ ...askOpenAi, onToolInput }));
  expect(read._tag === "Success" && read.success.text).toBe("read it");
  expect(server.bodies).toHaveLength(2);
});

test("openai-plan: a failed try's cost is carried across a token renewed after a 401, to the failure that ends the call", async () => {
  let renewed = 0;
  const plan = Effect.runSync(
    makeResponses({ api: server.base, bearer: { current: Effect.succeed("old"), renew: () => Effect.sync(() => ((renewed += 1), "new")) }, idle: "150 millis", label: "openai-plan" }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  const failedStream: Step = { after: "end", chunks: [sse({ type: "response.created" }), sse({ response: { error: { code: "server_error", message: "oops" }, usage }, type: "response.failed" })] };
  fresh(failedStream, { body: JSON.stringify({ error: { code: "invalid_token", message: "expired" } }), status: 401 }, openAiError(400, "invalid_request_error"));
  const out = await run(plan(askOpenAi));
  expect(renewed).toBe(1);
  expect(server.bodies).toHaveLength(3);
  expect(out._tag === "Failure" && out.failure.message).toContain("400");
  expect(out._tag === "Failure" && out.failure._tag !== "DeviceOffline" && out.failure.spent?.usage.input).toBe(5); // the failed stream's
  // and to the reply, when the renewed token gets through
  fresh(failedStream, { body: JSON.stringify({ error: { code: "invalid_token", message: "expired" } }), status: 401 }, done("ok"));
  const through = await run(plan(askOpenAi));
  expect(through._tag === "Success" && through.success.usage.input).toBe(10);
});

test("openai-plan: a 401 on the last try renews the token and sends it again, a renewal never counted as a try; a second 401 is a sign-out", async () => {
  let renewed = 0;
  const plan = Effect.runSync(
    makeResponses({ api: server.base, bearer: { current: Effect.succeed("old"), renew: () => Effect.sync(() => ((renewed += 1), "new")) }, idle: "150 millis", label: "openai-plan" }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
  const unauthorized: Step = { body: JSON.stringify({ error: { code: "invalid_token", message: "expired" } }), status: 401 };
  // three tries the server failed, then the fourth and last meets a 401
  fresh(openAiError(503, "unavailable"), openAiError(503, "unavailable"), openAiError(503, "unavailable"), unauthorized, done("ok"));
  const out = await run(plan(askOpenAi));
  expect(out._tag === "Success" && out.success.text).toBe("ok");
  expect(renewed).toBe(1);
  expect(server.bodies).toHaveLength(5);
  // still unauthorized with the new token: signed out, for the chain, with no more tries
  fresh(unauthorized, unauthorized, done("never"));
  const again = await run(plan(askOpenAi));
  expect(again._tag === "Failure" && again.failure).toBeInstanceOf(UsageLimit);
  expect(again._tag === "Failure" && again.failure.message).toBe("openai-plan: still unauthorized after a refresh: {\"error\":{\"code\":\"invalid_token\",\"message\":\"expired\"}}");
  expect(server.bodies).toHaveLength(2);
});
