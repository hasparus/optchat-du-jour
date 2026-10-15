// Our tool loop on a scripted provider: what a request that fails midway leaves in the log, and
// what it still costs.
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ModelError } from "../src/engines/errors.ts";
import type { Item, Provider } from "../src/providers/provider.ts";
import { StoreError } from "../src/store.ts";
import type { ToolBox } from "../src/tools/box.ts";
import { toolError, toolOk } from "../src/tools/files.ts";
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

const run = (provider: Provider, o: { readonly refuseAfter?: number; readonly tools?: ToolBox["run"] } = {}) => {
  // an echo flagged as failed (E28) has "error" after its text
  const log: string[][] = [];
  const usage: UsageRecord[] = [];
  const deltas: string[] = [];
  const thoughts: number[] = [];
  let writes = 0;
  const out: TurnEvents = {
    info: () => Effect.void,
    log: (kind, text, flags) =>
      Effect.suspend(() => {
        if (o.refuseAfter !== undefined && writes >= o.refuseAfter) return Effect.fail(new StoreError({ message: "disk full" }));
        writes += 1;
        log.push(flags?.error === true ? [kind, text, "error"] : [kind, text]);
        return Effect.void;
      }),
    text: (delta) => Effect.sync(() => void deltas.push(delta)),
    thinking: (tokens) => Effect.sync(() => void thoughts.push(tokens)),
    took: () => Effect.void,
    usage: (record) => Effect.sync(() => void usage.push(record)),
  };
  const engine: TurnEngine = toolLoop({ instructions: "MASTER", provider, ref: "api-key:x", toolsFor: () => ({ defs: [], run: o.tools ?? (() => Effect.succeed(toolOk("ran"))) }), vision: false });
  return { deltas, exit: Effect.runPromise(Effect.result(engine.run(input, out, null))), log, thoughts, usage };
};

test("a request that fails after calls streamed answers each with a not-run echo, and its spend is recorded", async () => {
  const r = run(failing);
  const result = await r.exit;
  expect(result._tag === "Failure" && result.failure.message).toBe("stream cut");
  expect(r.log).toEqual([
    ["tool", 'Read {"a":1}'],
    ["tool", "Glob {}"],
    ["echo", "not run: stream cut", "error"],
    ["echo", "not run: stream cut", "error"],
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
        yield* c.onThinking?.(5) ?? Effect.void;
        yield* c.onText("one ");
        yield* c.onItem?.({ text: "one ", type: "text" }) ?? Effect.void; // the log refuses this write
        yield* c.onText("two ");
        yield* c.onText("three");
        yield* c.onThinking?.(9) ?? Effect.void;
        return { items: [{ text: "one two three", type: "text" as const }], model: "m", usage: SPENT.usage };
      }),
    engine: "api-key",
  };
  const r = run(streaming, { refuseAfter: 0 });
  const result = await r.exit;
  expect(result._tag === "Failure" && result.failure.message).toBe("disk full");
  expect(r.deltas).toEqual(["one "]);
  expect(r.thoughts).toEqual([5]); // the size of a thought after the refusal is not sent either
  expect(r.usage.map((u) => u.usage)).toEqual([SPENT.usage]);
});

test("a tool that fails is logged flagged, one that works is not; the model is sent the text alone either way", async () => {
  const sent: unknown[] = [];
  let round = 0;
  // one request calling Read and Glob, then one that answers
  const twoRounds: Provider = {
    auth: "api-key",
    call: (c) =>
      Effect.gen(function* () {
        sent.push(c.history.filter((item) => item.type === "result"));
        round += 1;
        const items: Item[] =
          round === 1
            ? [
                { id: "1", input: '{"file_path":"gone.txt"}', name: "Read", type: "call" },
                { id: "2", input: "{}", name: "Glob", type: "call" },
              ]
            : [{ text: "done", type: "text" }];
        for (const item of items) yield* c.onItem?.(item) ?? Effect.void;
        return { items, model: "m", usage: SPENT.usage };
      }),
    engine: "api-key",
  };
  const r = run(twoRounds, { tools: (name) => Effect.succeed(name === "Read" ? toolError("Error: gone.txt does not exist on this device") : toolOk("a.ts")) });
  const exit = await r.exit;
  expect(exit._tag).toBe("Success");
  expect(r.log).toEqual([
    ["tool", 'Read {"file_path":"gone.txt"}'],
    ["tool", "Glob {}"],
    ["echo", "Error: gone.txt does not exist on this device", "error"],
    ["echo", "a.ts"],
    ["talk", "done"],
  ]);
  // the second request carries the two results as they were before the flag existed: id and output
  expect(sent[1]).toEqual([
    { id: "1", output: "Error: gone.txt does not exist on this device", type: "result" },
    { id: "2", output: "a.ts", type: "result" },
  ]);
});
