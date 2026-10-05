// Our own tool loop, for the turn engines that don't bring one (SPEC "Engines": openai-plan as
// the master's fallback, api-key as overflow; M5). The request is what a claude-code turn sends:
// the same system prompt, the view cut into the same blocks, then the new texts. Each reply's
// text is logged as `talk` and each tool call as `tool` "name json"; the tools run (read-only
// file tools on the turn's device, zoom and date from memory) and their output is logged as
// `echo`, capped as Claude Code's is. A message sent mid-run is taken after the current tool
// results, before the next request, and logged as `user` then (SPEC "Mid-run messages on
// openai-plan"). The turn ends at the first reply that calls no tool; the last allowed request
// may not call any.
import { Clock, Effect, Queue, Schema } from "effect";
import { TOOL_ROUNDS } from "../config.ts";
import type { EngineError } from "../engines/errors.ts";
import type { StoreError } from "../store.ts";
import type { ToolDef } from "../tools/files.ts";
import { isCold, type Tokens, type UsageRecord } from "../usage.ts";
import { cutBlocks } from "../view.ts";
import { cap } from "./claude-code.ts";
import { openingText, type TurnEngine, type TurnEvents, type TurnInput } from "./engine.ts";

// The conversation, provider-neutral. `stable` counts a user message's leading parts that stay
// byte-identical from call to call (the view blocks): where a provider puts its cache marks.
export type Item =
  | { readonly type: "user"; readonly parts: readonly string[]; readonly stable?: number }
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "call"; readonly id: string; readonly name: string; readonly input: string }
  | { readonly type: "result"; readonly id: string; readonly output: string }
  // a provider's own block, sent back exactly as it came (Anthropic's thinking, with its signature)
  | { readonly type: "kept"; readonly block: Schema.Json };

export type Step = { readonly items: readonly Item[]; readonly usage: Tokens; readonly model: string; readonly dollars?: number };

export type Provider = {
  readonly engine: UsageRecord["engine"];
  readonly auth: UsageRecord["auth"];
  readonly call: (o: {
    readonly instructions: string;
    readonly history: readonly Item[];
    readonly tools: readonly ToolDef[];
    readonly final: boolean; // no tool calls in this one
    readonly onText: (delta: string) => Effect.Effect<void>;
  }) => Effect.Effect<Step, EngineError>;
};

// a device's tools for one turn; `run` answers every call with text, errors included
export type ToolBox = { readonly defs: readonly ToolDef[]; readonly run: (name: string, input: string) => Effect.Effect<string> };

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
// a call's input as the log shows Claude Code's: compact JSON; whatever the model wrote when it isn't JSON
const shown = (input: string) => {
  const parsed = decodeJson(input);
  return parsed._tag === "Some" ? JSON.stringify(parsed.value) : input;
};

// The mid-run messages passed on so far and not yet taken, now taken: logged and marked one by
// one, each a user message of its own. Also the ones an engine before this one never took.
const steered = (input: TurnInput, out: TurnEvents): Effect.Effect<Item[], StoreError> =>
  Effect.gen(function* () {
    const items: Item[] = [];
    for (const s of input.sent) {
      if (s.taken) continue;
      yield* out.log("user", s.text);
      s.taken = true;
      items.push({ parts: [s.text], type: "user" });
    }
    return items;
  });

export const toolLoop = (o: {
  readonly ref: string;
  readonly provider: Provider;
  readonly instructions: string; // MASTER + VIEW_DOC + instructions.md, as claude-code gets it
  readonly toolsFor: (device: string) => ToolBox;
  readonly rounds?: number; // TOOL_ROUNDS
}): TurnEngine => {
  const rounds = o.rounds ?? TOOL_ROUNDS;
  const run: TurnEngine["run"] = (input, out, failoverFrom) =>
    Effect.gen(function* () {
      const box = o.toolsFor(input.device);
      // Mid-run messages move from the queue to `sent` as they come, as claude-code passes them to
      // stdin: taken off the queue and into `sent` before anything can interrupt, so the session
      // finds each one in one place or the other. They join at the next round.
      yield* Effect.uninterruptibleMask((restore) =>
        restore(Queue.take(input.steer)).pipe(
          Effect.tap((text) =>
            Effect.sync(() => {
              input.sent.push({ taken: false, text });
            }),
          ),
        ),
      ).pipe(Effect.forever, Effect.forkScoped);
      const view = cutBlocks(input.view);
      const history: Item[] = [{ parts: [...view, openingText(input)], stable: view.length, type: "user" }];
      for (let round = 1; ; round++) {
        history.push(...(yield* steered(input, out)));
        const started = yield* Clock.currentTimeMillis;
        const final = round >= rounds;
        const step = yield* o.provider.call({ final, history, instructions: o.instructions, onText: out.text, tools: box.defs });
        const now = yield* Clock.currentTimeMillis;
        yield* out.usage({
          attempt: 1,
          auth: o.provider.auth,
          cold: isCold(step.usage),
          date: new Date(now).toISOString(),
          device: input.device,
          engine: o.provider.engine,
          failoverFrom,
          level: null,
          model: step.model,
          ms: now - started,
          role: "turn",
          usage: step.usage,
          dollars: step.dollars, // api-key only; JSON leaves it out when undefined
        });
        const calls: Extract<Item, { readonly type: "call" }>[] = [];
        for (const item of step.items) {
          if (item.type === "text" && item.text.trim()) yield* out.log("talk", item.text);
          if (item.type === "call") {
            yield* out.log("tool", `${item.name} ${shown(item.input)}`);
            calls.push(item);
          }
        }
        history.push(...step.items);
        if (calls.length === 0) return;
        if (final) return yield* out.info(`${o.ref} stopped after ${rounds} requests with tool calls left`);
        for (const call of calls) {
          const output = cap(yield* box.run(call.name, call.input));
          yield* out.log("echo", output);
          history.push({ id: call.id, output, type: "result" });
        }
      }
    }).pipe(Effect.scoped); // the forwarder ends with the turn
  return { ref: o.ref, run, warm: () => Effect.void }; // nothing to start ahead
};
