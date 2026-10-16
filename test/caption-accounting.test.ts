import { afterAll, expect, test } from "bun:test";
import { Cause, Deferred, Effect, Fiber, Stream } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { type Messages, readMessages } from "../src/apikey/anthropic.ts";
import { makeBudget } from "../src/apikey/budget.ts";
import { parseSettings } from "../src/config.ts";
import { ModelError, Refusal, UsageLimit } from "../src/engines/errors.ts";
import { makeCaptioner, type CaptionNeeds } from "../src/media/caption.ts";
import { DEFAULT_ENDPOINTS } from "../src/openai/endpoints.ts";
import { readStream, type Respond } from "../src/openai/responses.ts";
import type { UsageRecord } from "../src/usage.ts";

const dir = mkdtempSync(`${tmpdir()}/caption-accounting-`);
afterAll(() => { rmSync(dir, { force: true, recursive: true }); });
const usage = { cacheRead: 0, cacheWrite: 0, input: 100, output: 10 };
const input = { heard: null, picture: { data: "", mime: "image/png", type: "image" } } as const;
const settings = parseSettings({ allowedLogins: [], apiKey: { monthlyBudget: 10, prices: { "openai/fake": { cacheRead: 1, input: 1, output: 1 } } }, cache: { claudeCodeTtl: "1h", primeTtl: "1h" }, compactor: { byLevel: [{ chain: ["claude-code:haiku"], from: 0 }], effort: "medium" }, defaultDevice: "mini", devices: { mini: { folders: [], url: "http://fake" } }, master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" }, media: { caption: ["api-key:openai/fake", "openai-plan:fallback"] }, openai: DEFAULT_ENDPOINTS });
let id = 0;
const rig = (respond: Respond, log?: CaptionNeeds["log"], config = settings) => {
  const records: UsageRecord[] = [];
  const order: string[] = [];
  const budget = makeBudget({ monthly: 10, report: () => Effect.void, usagePath: `${dir}/${id++}` });
  const caption = makeCaptioner(settings.media!.caption!, {
    apiKeys: Effect.succeed({ anthropic: () => Effect.die("unused"), openai: respond }), budget, device: "mini", log: (r) => budget.note(r).pipe(Effect.andThen(log?.(r) ?? Effect.void), Effect.andThen(Effect.sync(() => { records.push(r); order.push("logged"); }))),
    plan: Effect.succeed({ respond: () => Effect.sync(() => { order.push("fallback"); return { model: "fallback", output: [{ text: "a cat", type: "text" as const }], text: "a cat", usage }; }) }), planImages: true, report: () => Effect.void, runner: { spawn: () => Effect.die("unused"), warm: () => Effect.void }, settings: config,
  });
  return { budget, caption, order, records };
};

test("priced failed caption is logged exactly once before successful failover", async () => {
  const r = rig(() => Effect.fail(new UsageLimit({ message: "limit", spent: { model: "fake", usage } })));
  expect(await Effect.runPromise(r.caption(input))).toBe("a cat");
  expect(r.order).toEqual(["logged", "fallback", "logged"]);
  expect(r.records.map((v) => [v.auth, v.failoverFrom, v.role, v.model])).toEqual([["api-key", null, "caption", "fake"], ["chatgpt-pro", "api-key:openai/fake", "caption", "fallback"]]);
  expect(r.records[0]!.dollars).toBe(0.00011);
  expect(r.budget.spent()).toBe(0.00011);
});

test("refusal is accounted before terminal failure, never routed to fallback; absent spent creates no record", async () => {
  const r = rig(() => Effect.fail(new Refusal({ message: "no", spent: { model: "fake", usage } })));
  const error = await Effect.runPromise(Effect.flip(r.caption(input)));
  expect(error._tag).toBe("Refusal");
  expect(r.order).toEqual(["logged"]);
  expect(r.budget.spent()).toBe(0.00011);
  const empty = rig(() => Effect.fail(new ModelError({ message: "no usage" })));
  await Effect.runPromise(Effect.flip(empty.caption(input)));
  expect(empty.records).toEqual([]);
});

for (const fails of [false, true]) test(`cancel during accounting cannot split known charge (${fails})`, async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<null>();
    const release = yield* Deferred.make<null>();
    const r = rig(() => fails ? Effect.fail(new Refusal({ message: "no", spent: { model: "fake", usage } })) : Effect.succeed({ model: "fake", output: [{ text: "cat", type: "text" }], text: "cat", usage }), () => Deferred.succeed(entered, null).pipe(Effect.andThen(Deferred.await(release))));
    const fiber = yield* r.caption(input).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const cancelling = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(r.records).toHaveLength(0);
    expect(r.budget.spent()).toBe(0.00011);
    yield* Deferred.succeed(release, null);
    yield* Fiber.join(cancelling);
    const exit = yield* Fiber.await(fiber);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(r.records).toHaveLength(1);
    expect(r.order).not.toContain("fallback");
  }).pipe(Effect.scoped));
});

test("composite provider failure keeps its typed charge and original defect", async () => {
  const refusal = new Refusal({ message: "no", spent: { model: "fake", usage } });
  const r = rig(() => Effect.failCause(Cause.combine(Cause.fail(refusal), Cause.die("provider defect"))));
  const exit = await Effect.runPromiseExit(r.caption(input));
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(exit.cause.reasons.some((reason) => reason._tag === "Fail" && reason.error._tag === "Refusal")).toBe(true);
  }
  expect(r.records).toHaveLength(1);
  expect(r.budget.spent()).toBe(0.00011);
});

test("refused OpenAI caption without a usage report never fabricates a zero charge", async () => {
  for (const usage of [undefined, { input_tokens: 0, output_tokens: 0 }]) {
    const r = rig(() => readStream(Stream.make(new TextEncoder().encode([{ delta: "no", type: "response.refusal.delta" }, { response: { usage }, type: "response.completed" }].map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""))), "fake"));
    const error = await Effect.runPromise(Effect.flip(r.caption(input)));
    expect(error._tag).toBe("Refusal");
    expect(r.records).toHaveLength(usage ? 1 : 0);
  }
});

const anthropicRig = (anthropic: Messages) => {
  const records: UsageRecord[] = [], order: string[] = [];
  const budget = makeBudget({ monthly: 10, report: () => Effect.void, usagePath: `${dir}/anthropic-${id++}` });
  const caption = makeCaptioner([{ engine: "api-key", model: "fake", provider: "anthropic", ref: "api-key:anthropic/fake" }, settings.media!.caption![1]!], {
    apiKeys: Effect.succeed({ anthropic, openai: () => Effect.die("unused") }),
    budget, device: "mini", log: (r) => budget.note(r).pipe(Effect.andThen(Effect.sync(() => { records.push(r); order.push("logged"); }))),
    plan: Effect.succeed({ respond: () => Effect.sync(() => { order.push("fallback"); expect(records).toHaveLength(1); expect(budget.spent()).toBeGreaterThan(0); return { model: "fallback", output: [{ text: "a cat", type: "text" as const }], text: "a cat", usage }; }) }),
    planImages: true, report: () => Effect.void, runner: { spawn: () => Effect.die("unused"), warm: () => Effect.void },
    settings: { ...settings, apiKey: { monthlyBudget: 10, prices: { "anthropic/fake": { cacheRead: 1, cacheWrite1h: 4, cacheWrite5m: 2, input: 1, output: 1 } } } },
  });
  return { budget, caption, order, records };
};

for (const complete of [false, true]) for (const output of [undefined, 0]) test(`TTL-only failed caption is charged before fallback (${complete}, ${output})`, async () => {
  const events = [{ message: { model: "fake", usage: { cache_creation: complete ? { ephemeral_1h_input_tokens: 1, ephemeral_5m_input_tokens: 2 } : { ephemeral_5m_input_tokens: 2 }, output_tokens: output } }, type: "message_start" }, { error: { type: "rate_limit_error" }, type: "error" }];
  const r = anthropicRig((ask) => readMessages(Stream.make(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""))), ask));
  expect(await Effect.runPromise(r.caption(input))).toBe("a cat");
  expect(r.records).toHaveLength(2);
  expect(r.order).toEqual(["logged", "fallback", "logged"]);
  expect(r.records[0]!.usage.cacheWrite).toBe(complete ? 3 : 2);
  expect(r.records[0]!.dollars).toBe((complete ? 12 : 8) / 1_000_000);
  expect(r.records[1]!.failoverFrom).toBe("api-key:anthropic/fake");
  expect(r.budget.spent()).toBe(r.records[0]!.dollars!);
});

for (const known of [false, true]) test(`interrupt Anthropic network after usage barrier retains charge exactly once (${known})`, async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<null>();
    const events = [{ message: { model: "fake", usage: known ? { input_tokens: 100, output_tokens: 0 } : undefined }, type: "message_start" }, { content_block: { text: "", type: "text" }, index: 0, type: "content_block_start" }, { delta: { text: "cat", type: "text_delta" }, index: 0, type: "content_block_delta" }];
    const stream = Stream.make(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""))).pipe(Stream.concat(Stream.fromEffect(Effect.never)));
    const r = anthropicRig((ask) => readMessages(stream, { ...ask, onText: () => Deferred.succeed(entered, null).pipe(Effect.asVoid) }));
    const fiber = yield* r.caption(input).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    expect(r.records).toHaveLength(0);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(r.records).toHaveLength(known ? 1 : 0);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(r.order).toEqual(known ? ["logged"] : []);
    expect(r.budget.spent()).toBe(known ? 0.0001 : 0);
    if (known) expect(r.records[0]!.usage.input).toBe(100);
  }).pipe(Effect.scoped));
});

for (const known of [false, true]) test(`OpenAI caption interruption during terminal onOut accounts only reported usage (${known})`, async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<null>();
    const events = [{ delta: "cat", type: "response.output_text.delta" }, { response: { model: "reported", usage: known ? { input_tokens: 100, output_tokens: 10 } : undefined }, type: "response.completed" }];
    const r = rig((ask) => readStream(Stream.make(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""))), ask.model, {
      ...ask, onOut: () => Deferred.succeed(entered, null).pipe(Effect.andThen(Effect.never)),
    }));
    const fiber = yield* r.caption(input).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(exit.cause.reasons.map((r) => r._tag)).toEqual(["Interrupt"]);
    expect(r.records).toHaveLength(known ? 1 : 0);
    expect(r.order).toEqual(known ? ["logged"] : []);
    expect(r.budget.spent()).toBe(known ? 0.00011 : 0);
    if (known) expect(r.records[0]!.model).toBe("reported");
  }).pipe(Effect.scoped));
});

for (const defect of [false, true]) test(`caption finalizer prefers typed spend over snapshot and preserves full cause if logger defects (${defect})`, async () => {
  const refusal = new Refusal({ message: "no", spent: { model: "fake", usage } });
  const original = Cause.fromReasons([Cause.makeFailReason(refusal), Cause.makeDieReason("provider defect"), Cause.makeInterruptReason(123)]);
  let logs = 0;
  const r = rig((ask) => Effect.failCause(original).pipe(Effect.ensuring(ask.onSettledUsage?.({ model: "snapshot", usage: { ...usage, input: 200 } }) ?? Effect.void)), () => Effect.sync(() => {
    logs++;
    if (defect) throw new Error("logger defect");
  }));
  const exit = await Effect.runPromiseExit(r.caption(input));
  expect(exit._tag).toBe("Failure");
  if (exit._tag === "Failure") {
    expect(exit.cause.reasons).toContain(original.reasons[1]!);
    expect(exit.cause.reasons).toContain(original.reasons[2]!);
    expect(exit.cause.reasons.some((r) => r._tag === "Fail" && r.error._tag === "Refusal")).toBe(true);
    expect(exit.cause.reasons.filter((r) => r._tag === "Die")).toHaveLength(defect ? 2 : 1);
  }
  expect(logs).toBe(1);
  expect(r.records).toHaveLength(defect ? 0 : 1);
  expect(r.order).not.toContain("fallback");
  expect(r.budget.spent()).toBe(0.00011);
});

test("unpriceable interrupted caption forwards raw known usage and quarantines budget", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<null>();
    const events = [{ delta: "cat", type: "response.output_text.delta" }, { response: { usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 } }, type: "response.completed" }];
    const r = rig((ask) => readStream(Stream.make(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""))), ask.model, {
      ...ask, onOut: () => Deferred.succeed(entered, null).pipe(Effect.andThen(Effect.never)),
    }), undefined, { ...settings, apiKey: { monthlyBudget: 10, prices: { "openai/fake": { cacheRead: 1, input: Number.MAX_VALUE, output: 1 } } } });
    const fiber = yield* r.caption(input).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(exit.cause.reasons.map((r) => r._tag)).toEqual(["Interrupt"]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.usage.input).toBe(Number.MAX_SAFE_INTEGER);
    expect(r.records[0]!.dollars).toBeUndefined();
    expect((yield* Effect.flip(r.budget.check))._tag).toBe("ModelError");
    expect(r.order).toEqual(["logged"]);
  }).pipe(Effect.scoped));
});

for (const known of [false, true]) test(`successful Anthropic producer handoff interruption accounts exact TTL price (${known})`, async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<null>();
    const events = [
      { message: { model: "reported", usage: known ? { input_tokens: 5, output_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 } } : undefined }, type: "message_start" },
      { type: "message_stop" },
    ];
    const r = anthropicRig((ask) => readMessages(Stream.make(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""))), ask).pipe(
      Effect.tap(() => Deferred.succeed(entered, null).pipe(Effect.andThen(Effect.never))),
    ));
    const fiber = yield* r.caption(input).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    expect(r.records).toHaveLength(0);
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual(["Interrupt"]);
    expect(r.order).toEqual(known ? ["logged"] : []);
    expect(r.budget.spent()).toBe(known ? 20 / 1_000_000 : 0);
    expect(r.records).toHaveLength(known ? 1 : 0);
    if (known) {
      expect(r.records[0]!.model).toBe("reported");
      expect(r.records[0]!.dollars).toBe(20 / 1_000_000);
      expect(r.records[0]!.usage).toEqual({ cacheRead: 0, cacheWrite: 3, input: 5, output: 7 });
    }
  }).pipe(Effect.scoped));
});

test("successful Anthropic caption records once at exact split price", async () => {
  const events = [
    { message: { model: "reported", usage: { input_tokens: 5, output_tokens: 7, cache_creation: { ephemeral_5m_input_tokens: 2, ephemeral_1h_input_tokens: 1 } } }, type: "message_start" },
    { content_block: { text: "a cat", type: "text" }, index: 0, type: "content_block_start" },
    { type: "message_stop" },
  ];
  const r = anthropicRig((ask) => readMessages(Stream.make(new TextEncoder().encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""))), ask));
  expect(await Effect.runPromise(r.caption(input))).toBe("a cat");
  expect(r.order).toEqual(["logged"]);
  expect(r.records).toHaveLength(1);
  expect(r.records[0]!.dollars).toBe(20 / 1_000_000);
  expect(r.budget.spent()).toBe(20 / 1_000_000);
});

test("the billable provider request itself stays interruptible", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const entered = yield* Deferred.make<null>();
    const r = rig(() => Deferred.succeed(entered, null).pipe(Effect.andThen(Effect.never)));
    const fiber = yield* r.caption(input).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* Fiber.interrupt(fiber);
    expect(r.records).toHaveLength(0);
  }).pipe(Effect.scoped));
});
