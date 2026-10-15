import { expect, test } from "bun:test";
import { Cause, Deferred, Effect, Fiber, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { readMessages, requestBody } from "../src/apikey/anthropic.ts";
import { dollarsOf } from "../src/apikey/budget.ts";
import type { ApiKeys } from "../src/apikey/clients.ts";
import { parseSettings, type Price } from "../src/config.ts";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { apiKeyProvider } from "../src/providers/api-key.ts";
import { ModelError, priced, Refusal, type Spent, UsageLimit } from "../src/engines/errors.ts";
import { body, makeResponses, readStream } from "../src/openai/responses.ts";
import { responsesProvider } from "../src/providers/responses.ts";

type Json = string | number | boolean | null | undefined | readonly Json[] | { readonly [key: string]: Json };
const stream = (events: readonly Json[]) => Stream.make(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e).replaceAll('"NONFINITE_COUNTER"', "1e999")}\n\n`).join("")));
const ask = { history: [], model: "fake", system: "test" };
const start = (usage: Json) => ({ message: { model: "fake", usage }, type: "message_start" });
const delta = (usage: Json) => ({ delta: {}, type: "message_delta", usage });
const stop = { type: "message_stop" };
const first = { cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 2 }, cache_creation_input_tokens: 3, input_tokens: 5, output_tokens: 0 };
const price = { cacheRead: 1, cacheWrite1h: 4, cacheWrite5m: 2, input: 1, output: 2 };

for (const n of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "NONFINITE_COUNTER"]) test(`OpenAI/Anthropic reject invalid counter ${n}`, async () => {
  const a = await Effect.runPromise(Effect.flip(readMessages(stream([start(first), delta({ output_tokens: n }), stop]), ask)));
  expect(a._tag).toBe("ModelError");
  if (a._tag !== "DeviceOffline") expect(a.spent?.usage).toEqual({ cacheRead: 0, cacheWrite: 3, input: 5, output: 0 });
  const o = await Effect.runPromise(Effect.flip(readStream(stream([{ response: { usage: { input_tokens: n, output_tokens: 1 }, private: "secret-body" }, type: "response.completed" }]), "fake")));
  expect(o._tag).toBe("ModelError");
  expect(o.message).not.toContain("secret-body");
  expect(o.message.length).toBeLessThan(180);
});

test("OpenAI rejects cached-over-input and invalid optional cached counters", async () => {
  for (const cached of [3, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const e = await Effect.runPromise(Effect.flip(readStream(stream([{ response: { usage: { input_tokens: 2, input_tokens_details: { cached_tokens: cached }, output_tokens: 1 } }, type: "response.completed" }]), "fake")));
    expect(e._tag).toBe("ModelError");
  }
});

test("Anthropic merged TTL contradiction preserves earlier valid spend", async () => {
  for (const usage of [{ cache_creation: { ephemeral_1h_input_tokens: 9, ephemeral_5m_input_tokens: 2 } }, { cache_creation_input_tokens: 8, cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 2 } }]) {
    const e = await Effect.runPromise(Effect.flip(readMessages(stream([start(first), delta(usage), stop]), ask)));
    expect(e._tag).toBe("ModelError");
    if (e._tag !== "DeviceOffline") expect(e.spent?.usage.cacheWrite).toBe(3);
    expect(e.message.length).toBeLessThan(180);
  }
});

test("Anthropic output-only deltas retain split; aggregate-only update invalidates stale split without rejecting", async () => {
  const retained = await Effect.runPromise(readMessages(stream([start(first), delta({ output_tokens: 7 }), stop]), ask));
  expect(retained.writes).toEqual({ h1: 1, m5: 2 });
  expect(retained.usage.output).toBe(7);
  const changed = await Effect.runPromise(readMessages(stream([start(first), delta({ cache_creation_input_tokens: 8 }), delta({ output_tokens: 7 }), stop]), ask));
  expect(changed.writes).toBeUndefined();
  expect(changed.usage.cacheWrite).toBe(8);
  expect(dollarsOf(price, changed.usage, changed.writes)).toBe((5 + 8 * 4 + 7 * 2) / 1_000_000);
});

test("partial TTL components accumulate, absent later fields never erase them; incomplete split is dearer", async () => {
  const partial = { ...first, cache_creation: { ephemeral_5m_input_tokens: 2 } };
  const one = await Effect.runPromise(readMessages(stream([start(partial), delta({ output_tokens: 1 }), stop]), ask));
  expect(one.writes).toBeUndefined();
  const both = await Effect.runPromise(readMessages(stream([start(partial), delta({ cache_creation: { ephemeral_1h_input_tokens: 1 } }), delta({ output_tokens: 1 }), stop]), ask));
  expect(both.writes).toEqual({ h1: 1, m5: 2 });
});

test("malformed recognized usage never leaks schema body and retains partial usage", async () => {
  const e = await Effect.runPromise(Effect.flip(readMessages(stream([start(first), delta({ output_tokens: "private-body" }), stop]), ask)));
  expect(e.message).not.toContain("private-body");
  if (e._tag !== "DeviceOffline") expect(e.spent?.usage.input).toBe(5);
});

test("zero, missing optional usage, extra fields and unknown events remain compatible", async () => {
  const r = await Effect.runPromise(readMessages(stream([start({ input_tokens: 0, future: true }), { type: "new-event" }, delta({ output_tokens: 0 }), stop]), ask));
  expect(r.usage).toEqual({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0 });
  const noUsage = await Effect.runPromise(Effect.flip(readMessages(stream([{ message: {}, type: "message_start" }, { error: { type: "rate_limit_error" }, type: "error" }]), ask)));
  if (noUsage._tag !== "DeviceOffline") expect(noUsage.spent).toBeUndefined();
  const openai = await Effect.runPromise(readStream(stream([{ type: "unknown" }, { response: { usage: { input_tokens: 0, output_tokens: 0, future: 5 } }, type: "response.completed" }]), "fake"));
  expect(openai.usage.input).toBe(0);
});

test("absent reports on refusals/errors stay absent, distinct from explicit zero", async () => {
  for (const usage of [undefined, null, {}, { input_tokens: null, output_tokens: null, cache_creation: null }]) {
    const a = await Effect.runPromise(Effect.flip(readMessages(stream([start(usage), { error: { type: "rate_limit_error" }, type: "error" }]), ask)));
    if (a._tag !== "DeviceOffline") expect(a.spent).toBeUndefined();
  }
  for (const usage of [undefined, null, { input_tokens: 0, output_tokens: 0 }]) {
    const o = await Effect.runPromise(Effect.flip(readStream(stream([{ delta: "no", type: "response.refusal.delta" }, { response: { usage }, type: "response.completed" }]), "fake")));
    expect(o._tag).toBe("Refusal");
    if (o._tag !== "DeviceOffline") expect(o.spent === undefined).toBe(usage == null);
  }
});

for (const field of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) test(`Anthropic validates optional ${field}`, async () => {
  for (const count of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, "NONFINITE_COUNTER"]) {
    const e = await Effect.runPromise(Effect.flip(readMessages(stream([start(first), delta({ [field]: count }), stop]), ask)));
    expect(e._tag).toBe("ModelError");
    if (e._tag !== "DeviceOffline") expect(e.spent?.usage.input).toBe(5);
  }
});

test("Anthropic validates both optional TTL counters before committing", async () => {
  for (const field of ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"]) for (const count of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, "NONFINITE_COUNTER"]) {
    const e = await Effect.runPromise(Effect.flip(readMessages(stream([start(first), delta({ cache_creation: { [field]: count } }), stop]), ask)));
    expect(e._tag).toBe("ModelError");
    if (e._tag !== "DeviceOffline") expect(e.spent?.usage.cacheWrite).toBe(3);
  }
});

test("invalid operands and arithmetic overflow never manufacture zero/negative dollars", async () => {
  const u = { cacheRead: 0, cacheWrite: 0, input: 2, output: 0 };
  for (const input of [-1, Infinity]) expect(() => dollarsOf({ ...price, input }, u)).toThrow();
  const overflow = { ...u, input: Number.MAX_SAFE_INTEGER };
  expect(() => dollarsOf({ ...price, input: Number.MAX_VALUE }, overflow)).toThrow();
  for (const input of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity]) expect(() => dollarsOf(price, { ...u, input })).toThrow();
  const provider = responsesProvider({ auth: "api-key", dollars: (usage) => dollarsOf({ ...price, input: Number.MAX_VALUE }, usage), engine: "api-key", model: "fake", respond: () => Effect.succeed({ model: "fake", output: [], text: "", usage: overflow }) });
  const e = await Effect.runPromise(Effect.flip(provider.call({ final: true, history: [], instructions: "", onText: () => Effect.void, tools: [] })));
  expect(e._tag).toBe("ModelError");
  if (e._tag !== "DeviceOffline") { expect(e.spent?.usage).toEqual(overflow); expect(e.spent?.dollars).toBeUndefined(); }
  const failed = priced(new Refusal({ message: "no", spent: { model: "fake", usage: u } }), () => { throw new Error("private price"); });
  expect(failed._tag).toBe("ModelError");
  expect(failed.message).not.toContain("private price");
  const uncharged = new ModelError({ message: "no usage" });
  expect(priced(uncharged, () => 42)).toBe(uncharged);
});

test("large finite charges do not overflow unscaled intermediates", () => {
  const u = { cacheRead: 0, cacheWrite: 0, input: 1000, output: 0 };
  expect(dollarsOf({ ...price, input: 1e308 }, u) / 1e305).toBeCloseTo(1, 12);
  expect(dollarsOf({ ...price, input: 1e308, output: 1e308 }, { ...u, input: 1, output: 1 }) / 2e302).toBeCloseTo(1, 12);
  const writes = { ...u, cacheWrite: 1000, input: 0 };
  expect(dollarsOf({ ...price, cacheWrite1h: 1e308 }, writes) / 1e305).toBeCloseTo(1, 12);
  expect(dollarsOf({ ...price, cacheWrite1h: 1e308 }, writes, { h1: 1000, m5: 0 }) / 1e305).toBeCloseTo(1, 12);
});

for (const complete of [false, true]) for (const output of [undefined, 0]) test(`Anthropic TTL-only writes are known on success/error (${complete}, ${output})`, async () => {
  const usage = { cache_creation: complete ? { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 2 } : { ephemeral_5m_input_tokens: 2 }, output_tokens: output };
  const reply = await Effect.runPromise(readMessages(stream([start(usage), stop]), ask));
  expect(reply.usage.cacheWrite).toBe(complete ? 3 : 2);
  expect(reply.writes).toEqual(complete ? { h1: 1, m5: 2 } : undefined);
  expect(dollarsOf(price, reply.usage, reply.writes)).toBe(8 / 1_000_000);
  const error = await Effect.runPromise(Effect.flip(readMessages(stream([start(usage), { error: { type: "rate_limit_error" }, type: "error" }]), ask)));
  if (error._tag !== "DeviceOffline") expect(error.spent?.usage.cacheWrite).toBe(complete ? 3 : 2);
});

test("Anthropic TTL components arriving separately retain aggregate provenance", async () => {
  const partial = { cache_creation: { ephemeral_5m_input_tokens: 2 } };
  const reply = await Effect.runPromise(readMessages(stream([start(partial), delta({ cache_creation: { ephemeral_1h_input_tokens: 1 } }), stop]), ask));
  expect(reply.usage.cacheWrite).toBe(3);
  expect(reply.writes).toEqual({ h1: 1, m5: 2 });
  const reported = await Effect.runPromise(readMessages(stream([start(partial), delta({ cache_creation_input_tokens: 5 }), stop]), ask));
  expect(reported.usage.cacheWrite).toBe(5);
  expect(reported.writes).toBeUndefined();
});

test("Anthropic unsafe derived TTL sums never replace prior valid usage", async () => {
  const unsafe = { cache_creation: { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: Number.MAX_SAFE_INTEGER } };
  const fresh = await Effect.runPromise(Effect.flip(readMessages(stream([start(unsafe), stop]), ask)));
  expect(fresh._tag).toBe("ModelError");
  if (fresh._tag !== "DeviceOffline") expect(fresh.spent).toBeUndefined();
  const partial = { cache_creation: { ephemeral_5m_input_tokens: Number.MAX_SAFE_INTEGER } };
  const error = await Effect.runPromise(Effect.flip(readMessages(stream([start(partial), delta({ cache_creation: { ephemeral_1h_input_tokens: 1 } }), stop]), ask)));
  expect(error._tag).toBe("ModelError");
  if (error._tag !== "DeviceOffline") expect(error.spent?.usage.cacheWrite).toBe(Number.MAX_SAFE_INTEGER);
});

test("Anthropic explicit zero TTL usage is known, unlike an empty TTL report", async () => {
  for (const count of [undefined, 0]) {
    const error = await Effect.runPromise(Effect.flip(readMessages(stream([start({ cache_creation: { ephemeral_5m_input_tokens: count } }), { error: { type: "rate_limit_error" }, type: "error" }]), ask)));
    if (error._tag !== "DeviceOffline") expect(error.spent === undefined).toBe(count === undefined);
  }
});

for (const ErrorType of [ModelError, Refusal, UsageLimit]) test(`Anthropic transport ${ErrorType.name} retains known partial usage`, async () => {
  const error = new ErrorType({ message: "synthetic disconnect" });
  const interrupted = stream([start({ input_tokens: 100, output_tokens: 0 })]).pipe(Stream.concat(Stream.fail(error)));
  const result = await Effect.runPromise(Effect.flip(readMessages(interrupted, ask)));
  expect(result._tag).toBe(error._tag);
  expect(result.message).toBe(error.message);
  if (result._tag !== "DeviceOffline") expect(result.spent).toEqual({ model: "fake", usage: { cacheRead: 0, cacheWrite: 0, input: 100, output: 0 } });
});

test("Anthropic transport preserves existing spent and does not fabricate absent reports", async () => {
  const error = new ModelError({ message: "disconnect", spent: { dollars: 3, model: "earlier", usage: { cacheRead: 0, cacheWrite: 0, input: 7, output: 1 } } });
  const failed = stream([start(first)]).pipe(Stream.concat(Stream.fail(error)));
  expect(await Effect.runPromise(Effect.flip(readMessages(failed, ask)))).toBe(error);
  const absent = new ModelError({ message: "no report" });
  expect(await Effect.runPromise(Effect.flip(readMessages(Stream.fail(absent), ask)))).toBe(absent);
});

test("Anthropic partial transport failure and interruption retain causes and known usage", async () => {
  const error = new ModelError({ message: "disconnect" });
  const defect = Cause.makeDieReason("transport defect");
  const interrupt = Cause.makeInterruptReason(456);
  for (const withFailure of [false, true]) {
    const cause = Cause.fromReasons(withFailure ? [Cause.makeFailReason(error), defect, interrupt] : [interrupt]);
    const failed = stream([start(first)]).pipe(Stream.concat(Stream.failCause(cause)));
    const recorded: Spent[] = [];
    const exit = await Effect.runPromiseExit(readMessages(failed, { ...ask, onSettledUsage: (spent) => Effect.sync(() => { recorded.push(spent); }) }));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.usage.input).toBe(5);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(exit.cause.reasons).toContain(interrupt);
      expect(exit.cause.reasons).toHaveLength(withFailure ? 3 : 1);
      if (withFailure) expect(exit.cause.reasons).toContain(defect);
      const reason = exit.cause.reasons.find((r) => r._tag === "Fail");
      expect(reason?._tag).toBe(withFailure ? "Fail" : undefined);
      if (reason?._tag === "Fail" && reason.error._tag !== "DeviceOffline") expect(reason.error.spent?.usage.input).toBe(5);
    }
  }
});

test("actual SSE retry directive becomes a nonretryable ModelError", async () => {
  const error = await Effect.runPromise(Effect.flip(readMessages(Stream.make(new TextEncoder().encode("retry: 1000\n\n")), ask)));
  expect(error._tag).toBe("ModelError");
  expect(error.message).toContain("the stream asked to reconnect");
});

for (const protocol of ["Anthropic", "OpenAI"] as const) {
  const events = protocol === "Anthropic"
    ? [start(first), { content_block: { text: "hello", type: "text" }, index: 0, type: "content_block_start" }, { index: 0, type: "content_block_stop" }]
    : [{ delta: "hello", type: "response.output_text.delta" }, { response: { usage: { input_tokens: 5, output_tokens: 1 } }, type: "response.completed" }];

  for (const tag of ["CallerError", "Retry", "SchemaError", "ModelError", "UsageLimit", "Refusal"] as const) test(`${protocol} known partial usage preserves foreign callback ${tag} identity`, async () => {
    const foreign = { _tag: tag, marker: "caller" };
    const callback = () => Effect.fail(foreign);
    const result = await Effect.runPromise(Effect.flip(protocol === "Anthropic"
      ? readMessages(stream(events), { ...ask, onItem: callback }).pipe(Effect.asVoid)
      : readStream(stream(events), "fake", { onOut: callback }).pipe(Effect.asVoid)));
    expect(result).toBe(foreign);
  });

  test(`${protocol} preserves composite foreign SchemaError callback failure and defect`, async () => {
    const foreign = { _tag: "SchemaError", marker: "caller" } as const;
    const defect = Cause.makeDieReason("callback defect");
    const original = Cause.fromReasons([Cause.makeFailReason(foreign), defect]);
    const callback = () => Effect.failCause(original);
    const exit = await Effect.runPromiseExit(protocol === "Anthropic"
      ? readMessages(stream(events), { ...ask, onItem: callback }).pipe(Effect.asVoid)
      : readStream(stream(events), "fake", { onOut: callback }).pipe(Effect.asVoid));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(exit.cause).toEqual(original);
      expect(exit.cause.reasons).toContain(defect);
      expect(exit.cause.reasons.some((r) => r._tag === "Fail" && r.error === foreign)).toBe(true);
    }
  });
}

for (const succeeds of [false, true]) test(`producer settled hook observes ordinary success/failure once (${succeeds})`, async () => {
  const recorded: Spent[] = [];
  const onSettledUsage = (spent: Spent) => Effect.sync(() => { recorded.push(spent); });
  const a = readMessages(stream([start(first), ...(succeeds ? [stop] : [{ error: { type: "rate_limit_error" }, type: "error" }])]), { ...ask, onSettledUsage });
  const o = readStream(stream([{ response: { usage: { input_tokens: 5, output_tokens: 1 } }, type: succeeds ? "response.completed" : "response.failed" }]), "fake", { onSettledUsage });
  const aExit = await Effect.runPromiseExit(a), oExit = await Effect.runPromiseExit(o);
  expect(aExit._tag).toBe(succeeds ? "Success" : "Failure");
  expect(oExit._tag).toBe(succeeds ? "Success" : "Failure");
  expect(recorded).toEqual([
    { model: "fake", usage: { cacheRead: 0, cacheWrite: 3, input: 5, output: 0 } },
    { model: "fake", usage: { cacheRead: 0, cacheWrite: 0, input: 5, output: 1 } },
  ]);
});

for (const cleanupDefect of [false, true]) test(`Anthropic actual interruption finalizes latest validated usage once (${cleanupDefect})`, async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<null>();
    const recorded: Spent[] = [];
    const events = [start(first), delta({ output_tokens: 7 }), { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" }, { delta: { text: "cat", type: "text_delta" }, index: 0, type: "content_block_delta" }];
    const work = readMessages(stream(events), {
      ...ask,
      onSettledUsage: (spent) => Effect.sync(() => { recorded.push(spent); }).pipe(Effect.andThen(cleanupDefect ? Effect.die("cleanup defect") : Effect.void)),
      onText: () => Deferred.succeed(entered, null).pipe(Effect.andThen(Effect.never)),
    });
    const fiber = yield* work.pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    expect(recorded).toEqual([]);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(recorded).toEqual([{ model: "fake", usage: { cacheRead: 0, cacheWrite: 3, input: 5, output: 7 } }]);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(exit.cause.reasons.filter((r) => r._tag === "Die").map((r) => r.defect)).toEqual(cleanupDefect ? ["cleanup defect"] : []);
      expect(exit.cause.reasons.some((r) => r._tag === "Fail")).toBe(false);
    }
  }).pipe(Effect.scoped));
});

for (const known of [false, true]) for (const cleanupDefect of [false, true]) test(`OpenAI client stores terminal usage before blocked onOut (${known}, ${cleanupDefect})`, async () => {
  let requestBody = "";
  const events = [{ delta: "cat", type: "response.output_text.delta" }, { response: { model: "reported", usage: known ? { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 7 } : undefined }, type: "response.completed" }];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => {
    requestBody = await req.text();
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    await Effect.runPromise(Effect.gen(function* () {
      const respond = yield* makeResponses({ api: `http://127.0.0.1:${server.port}/v1`, bearer: { current: Effect.succeed("fake"), renew: () => Effect.die("no renewal") }, label: "fake" });
      const entered = yield* Deferred.make<null>();
      const recorded: Spent[] = [];
      const fiber = yield* respond({
        input: [], instructions: "", model: "requested",
        onSettledUsage: (spent) => Effect.sync(() => { recorded.push(spent); }).pipe(Effect.andThen(cleanupDefect ? Effect.die("cleanup defect") : Effect.void)),
        onOut: () => Deferred.succeed(entered, null).pipe(Effect.andThen(Effect.never)),
      }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      expect(recorded).toEqual([]);
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      expect(recorded).toEqual(known ? [{ model: "reported", usage: { cacheRead: 20, cacheWrite: 0, input: 80, output: 7 } }] : []);
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        expect(exit.cause.reasons.filter((r) => r._tag === "Die").map((r) => r.defect)).toEqual(known && cleanupDefect ? ["cleanup defect"] : []);
        expect(exit.cause.reasons.some((r) => r._tag === "Fail")).toBe(false);
      }
      expect(requestBody).not.toContain("onSettledUsage");
    }).pipe(Effect.provide(FetchHttpClient.layer), Effect.scoped));
  } finally { await server.stop(true); }
});

test("Anthropic settled observation includes TTL split only on producer success", async () => {
  for (const succeeds of [false, true]) {
    const recorded: { readonly spent: Spent; readonly writes: { readonly h1: number; readonly m5: number } | undefined }[] = [];
    const exit = await Effect.runPromiseExit(readMessages(stream([start(first), ...(succeeds ? [stop] : [{ error: { type: "rate_limit_error" }, type: "error" }])]), {
      ...ask, onSettledUsage: (spent, writes) => Effect.sync(() => { recorded.push({ spent, writes }); }),
    }));
    expect(exit._tag).toBe(succeeds ? "Success" : "Failure");
    expect(recorded).toEqual([{ spent: { model: "fake", usage: { cacheRead: 0, cacheWrite: 3, input: 5, output: 0 } }, writes: succeeds ? { h1: 1, m5: 2 } : undefined }]);
  }
});

for (const known of [false, true]) test(`producer settled observations distinguish missing from explicit zero on success and defects (${known})`, async () => {
  for (const defect of [false, true]) {
    const anthropic: Spent[] = [], openai: Spent[] = [];
    const a = readMessages(stream([
      start(known ? { input_tokens: 0 } : undefined),
      { content_block: { text: "cat", type: "text" }, index: 0, type: "content_block_start" },
      { index: 0, type: "content_block_stop" }, stop,
    ]), {
      ...ask,
      onItem: () => defect ? Effect.die("output defect") : Effect.void,
      onSettledUsage: (spent) => Effect.sync(() => { anthropic.push(spent); }),
    });
    const o = readStream(stream([
      { delta: "cat", type: "response.output_text.delta" },
      { response: { usage: known ? { input_tokens: 0, output_tokens: 0 } : undefined }, type: "response.completed" },
    ]), "fake", {
      onOut: () => defect ? Effect.die("output defect") : Effect.void,
      onSettledUsage: (spent) => Effect.sync(() => { openai.push(spent); }),
    });
    for (const exit of [await Effect.runPromiseExit(a), await Effect.runPromiseExit(o)]) {
      expect(exit._tag).toBe(defect ? "Failure" : "Success");
      if (exit._tag === "Failure") expect(exit.cause.reasons.map((r) => r._tag)).toEqual(["Die"]);
    }
    const expected = known ? [{ model: "fake", usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 } }] : [];
    expect(anthropic).toEqual(expected);
    expect(openai).toEqual(expected);
  }
});

const unusedSettledUsage = () => Effect.die("not called");
test("internal settled callbacks never enter either protocol request body", () => {
  const onSettledUsage = unusedSettledUsage;
  expect(requestBody({ ...ask, onSettledUsage })).toBe(requestBody(ask));
  const openai = { input: [], instructions: "", model: "fake" };
  expect(body({ ...openai, onSettledUsage })).toBe(body(openai));
});

const settings = parseSettings({ allowedLogins: [], apiKey: { monthlyBudget: 10, prices: {} }, cache: { claudeCodeTtl: "1h", primeTtl: "1h" }, compactor: { byLevel: [{ chain: ["claude-code:haiku"], from: 0 }], effort: "medium" }, defaultDevice: "mini", devices: { mini: { folders: [], url: "http://fake" } }, master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" }, openai: DEFAULT_ENDPOINTS });
const call = { final: true, history: [], instructions: "", onText: () => Effect.void, tools: [] };
const budget = { check: Effect.void, note: () => Effect.void, spent: () => 0 };
const providerFor = (provider: "anthropic" | "openai", configured: Price, clients: ApiKeys["Service"]) => apiKeyProvider({
  budget, clients, ref: { engine: "api-key", model: "fake", provider, ref: `api-key:${provider}/fake` },
  settings: { ...settings, apiKey: { monthlyBudget: 10, prices: { [`${provider}/fake`]: configured } } },
});

for (const provider of ["anthropic", "openai"] as const) {
  for (const field of ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"] as const) test(`${provider} preflight rejects invalid ${field} before any client dispatch`, async () => {
    for (const value of [-1, Number.NaN, Infinity, -Infinity]) {
      let requests = 0;
      const p = providerFor(provider, { ...price, [field]: value }, {
        anthropic: () => Effect.sync(() => { requests++; return { items: [], model: "fake", stop: null, usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 }, writes: undefined }; }),
        openai: () => Effect.sync(() => { requests++; return { model: "fake", output: [], text: "", usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 } }; }),
      });
      const error = await Effect.runPromise(Effect.flip(p.call(call)));
      expect(requests).toBe(0);
      expect(error._tag).toBe("ModelError");
      expect(error.message).toBe("API-key price configuration is invalid");
      if (error._tag !== "DeviceOffline") expect(error.spent).toBeUndefined();
    }
  });

  test(`${provider} repricing preserves all cause reasons, including a foreign tagged error`, async () => {
    const usage = { cacheRead: 0, cacheWrite: 0, input: 100, output: 10 };
    const refusal = new Refusal({ message: "no", spent: { model: "fake", usage } });
    const foreign = { _tag: "CallerError" } as const;
    const defect = Cause.makeDieReason("provider defect");
    const interrupt = Cause.makeInterruptReason(123);
    const cause = Cause.fromReasons([Cause.makeFailReason(refusal), defect, interrupt]);
    const p = providerFor(provider, price, {
      anthropic: (ask) => Effect.exit(ask.onItem?.({ text: "", type: "text" }) ?? Effect.void).pipe(Effect.flatMap((exit) => Effect.failCause(exit._tag === "Failure" ? Cause.combine(cause, exit.cause) : cause))),
      openai: (ask) => Effect.exit(ask.onOut?.({ text: "", type: "text" }) ?? Effect.void).pipe(Effect.flatMap((exit) => Effect.failCause(exit._tag === "Failure" ? Cause.combine(cause, exit.cause) : cause))),
    });
    const exit = await Effect.runPromiseExit(p.call({ ...call, onItem: () => Effect.fail(foreign) }));
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(exit.cause.reasons).toContain(defect);
      expect(exit.cause.reasons).toContain(interrupt);
      expect(exit.cause.reasons.some((r) => r._tag === "Fail" && r.error === foreign)).toBe(true);
      const error = exit.cause.reasons.find((r) => r._tag === "Fail" && r.error._tag === "Refusal");
      expect(error?._tag).toBe("Fail");
      if (error?._tag === "Fail" && error.error._tag === "Refusal") {
        expect(error.error.message).toBe("no");
        expect(error.error.spent).toEqual({ dollars: dollarsOf(price, usage), model: "fake", usage });
      }
    }
  });
}
