// Our tool loop on a scripted provider: what a request that fails midway leaves in the log, and
// what it still costs.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ModelError } from "../src/engines/errors.ts";
import type { Provider } from "../src/providers/provider.ts";
import { StoreError } from "../src/store.ts";
import type { TurnEngine, TurnEvents, TurnInput } from "../src/turn/engine.ts";
import { toolLoop } from "../src/turn/loop.ts";
import type { UsageRecord } from "../src/usage.ts";

const SPENT = { model: "m", usage: { cacheRead: 0, cacheWrite: 0, input: 10, output: 5 } };
const input: TurnInput = { device: "mini", earlier: [], media: [], mid: { next: Effect.never, ready: Effect.succeed([]) }, texts: ["go"], view: "" };

// a provider whose one request streams two tool calls, then fails having cost something
const failing: Provider = {
  auth: "api-key",
  call: (c) =>
    Effect.gen(function* () {
      yield* c.onItem?.({ id: "1", input: '{"a":1}', name: "Read", type: "call" }) ?? Effect.void;
      yield* c.onItem?.({ id: "2", input: "{}", name: "Glob", type: "call" }) ?? Effect.void;
      return yield* new ModelError({ message: "stream cut", spent: SPENT });
    }),
  engine: "api-key",
};

const run = (provider: Provider, o: { readonly refuseAfter?: number } = {}) => {
  const log: [string, string][] = [];
  const usage: UsageRecord[] = [];
  const deltas: string[] = [];
  let writes = 0;
  const out: TurnEvents = {
    info: () => Effect.void,
    log: (kind, text) =>
      Effect.suspend(() => {
        if (o.refuseAfter !== undefined && writes >= o.refuseAfter) return Effect.fail(new StoreError({ message: "disk full" }));
        writes += 1;
        log.push([kind, text]);
        return Effect.void;
      }),
    text: (delta) => Effect.sync(() => void deltas.push(delta)),
    thinking: () => Effect.void,
    took: () => Effect.void,
    usage: (record) => Effect.sync(() => void usage.push(record)),
  };
  const engine: TurnEngine = toolLoop({ instructions: "MASTER", provider, ref: "api-key:x", toolsFor: () => ({ defs: [], run: () => Effect.succeed("ran") }), vision: false });
  return { deltas, exit: Effect.runPromise(Effect.result(engine.run(input, out, null))), log, usage };
};

test("a request that fails after calls streamed answers each with a not-run echo, and its spend is recorded", async () => {
  const r = run(failing);
  const result = await r.exit;
  expect(result._tag === "Failure" && result.failure.message).toBe("stream cut");
  expect(r.log).toEqual([
    ["tool", 'Read {"a":1}'],
    ["tool", "Glob {}"],
    ["echo", "not run: stream cut"],
    ["echo", "not run: stream cut"],
  ]);
  expect(r.usage.map((u) => u.usage)).toEqual([SPENT.usage]);
});

test("a log that refuses mid-stream still has the failed request's spend recorded, and fails the turn with the refusal", async () => {
  const r = run(failing, { refuseAfter: 1 });
  const result = await r.exit;
  expect(result._tag === "Failure" && result.failure.message).toBe("disk full");
  expect(r.log).toEqual([["tool", 'Read {"a":1}']]);
  expect(r.usage.map((u) => u.usage)).toEqual([SPENT.usage]);
});

test("a request that succeeds while the log refuses records its usage before the turn fails", async () => {
  const succeeding: Provider = {
    auth: "api-key",
    call: (c) =>
      Effect.gen(function* () {
        yield* c.onItem?.({ text: "hello", type: "text" }) ?? Effect.void;
        return { items: [{ text: "hello", type: "text" as const }], model: "m", usage: SPENT.usage };
      }),
    engine: "api-key",
  };
  const r = run(succeeding, { refuseAfter: 0 });
  const result = await r.exit;
  expect(result._tag === "Failure" && result.failure.message).toBe("disk full");
  expect(r.usage.map((u) => u.usage)).toEqual([SPENT.usage]);
});

test("live text stops once the log has refused a write, while the stream is still read for its usage", async () => {
  const streaming: Provider = {
    auth: "api-key",
    call: (c) =>
      Effect.gen(function* () {
        yield* c.onText("one ");
        yield* c.onItem?.({ text: "one ", type: "text" }) ?? Effect.void; // the log refuses this write
        yield* c.onText("two ");
        yield* c.onText("three");
        return { items: [{ text: "one two three", type: "text" as const }], model: "m", usage: SPENT.usage };
      }),
    engine: "api-key",
  };
  const r = run(streaming, { refuseAfter: 0 });
  const result = await r.exit;
  expect(result._tag === "Failure" && result.failure.message).toBe("disk full");
  expect(r.deltas).toEqual(["one "]);
  expect(r.usage.map((u) => u.usage)).toEqual([SPENT.usage]);
});
