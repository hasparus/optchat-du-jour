// Our own tool loop, for the turn engines that don't bring one (SPEC "Engines": openai-plan as
// the master's fallback, api-key as overflow; M5). The request is what a claude-code turn sends:
// the same system prompt, the view cut into the same blocks, then the new texts. Each reply's
// text is logged as `talk` and each tool call as `tool` "name json" as it completes; the tools run
// (read-only file tools on the turn's device, zoom and date from memory) and their output is
// logged as `echo`, capped as Claude Code's is. A thought goes out only as its size. A message sent mid-run is taken after the current tool
// results, before the next request, and logged as `user` then (SPEC "Mid-run messages on
// openai-plan"). The turn ends at the first reply that calls no tool; the last allowed request
// may not call any.
import { Cause, Clock, Effect, Exit, Schema } from "effect";
import { cap } from "../cap.ts";
import { TOOL_ROUNDS } from "../config.ts";
import { type EngineError, isEngineError } from "../engines/errors.ts";
import type { Item, Provider } from "../providers/provider.ts";
import type { StoreError } from "../store.ts";
import type { ToolBox } from "../tools/box.ts";
import { isCold, type Tokens } from "../usage.ts";
import { cutBlocks } from "../view.ts";
import { openingText, type TurnEngine, type TurnEvents, type TurnInput } from "./engine.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));
// a call's input as the log shows Claude Code's: compact JSON; whatever the model wrote when it isn't JSON
const shown = (input: string) => {
  const parsed = decodeJson(input);
  return parsed._tag === "Some" ? JSON.stringify(parsed.value) : input;
};

// The mid-run messages offered so far (first any an engine before this one never took), taken
// now: each logged as it is taken, each a user message of its own.
const steered = (input: TurnInput, out: TurnEvents): Effect.Effect<Item[], StoreError> =>
  Effect.gen(function* () {
    const items: Item[] = [];
    for (const m of yield* input.mid.ready) {
      yield* out.took(m);
      items.push({ parts: [...m.media, m.text], type: "user" });
    }
    return items;
  });

// what one request has left behind so far (see `run`)
type Track = { refused: StoreError | null; open: number };

// a failure's cause in a few words, for an echo that says why a call did not run
const whyOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

export const toolLoop = (o: {
  readonly ref: string;
  readonly provider: Provider;
  readonly instructions: string; // MASTER + VIEW_DOC + instructions.md, as claude-code gets it
  readonly toolsFor: (device: string) => ToolBox;
  readonly rounds?: number; // TOOL_ROUNDS
  readonly vision: boolean; // whether its provider is sent images (SPEC "Media")
}): TurnEngine => {
  const rounds = o.rounds ?? TOOL_ROUNDS;
  const run: TurnEngine["run"] = (input, out, failoverFrom) => {
    // Each item is logged as it completes, so live text after it streams under the next log index.
    // A log that refuses is remembered, not failed on at once: the reply goes on streaming (it is
    // being paid for), its usage is recorded, and then the turn fails with the refusal.
    // `open`: tool entries logged and not answered with an echo yet
    const track: Track = { open: 0, refused: null };
    const logged = (item: Item): Effect.Effect<void> => {
      if (track.refused !== null) return Effect.void;
      const write =
        item.type === "text"
          ? item.text.trim()
            ? out.log("talk", item.text)
            : Effect.void
          : item.type === "call"
            ? out.log("tool", `${item.name} ${shown(item.input)}`).pipe(Effect.tap(() => Effect.sync(() => void track.open++)))
            : Effect.void;
      return write.pipe(Effect.catch((error: StoreError) => Effect.sync(() => void (track.refused = error))));
    };
    const answer = (text: string) => out.log("echo", text).pipe(Effect.tap(() => Effect.sync(() => void track.open--)));
    // A turn that ends early (the provider failed, a cancel) leaves no tool entry without its echo,
    // as the last round does not either.
    const unanswered = (exit: Exit.Exit<void, StoreError | EngineError>) =>
      Exit.isFailure(exit) && track.refused === null && track.open > 0
        ? Effect.forEach(Array.from({ length: track.open }), () => answer(`not run: ${Cause.hasInterruptsOnly(exit.cause) ? "cancelled" : whyOf(exit.cause)}`), { discard: true }).pipe(Effect.ignoreCause)
        : Effect.void;
    return Effect.gen(function* () {
      const box = o.toolsFor(input.device);
      const view = cutBlocks(input.view);
      // the view (stable, cached), the new messages' pictures, then their texts
      const history: Item[] = [{ parts: [...view, ...input.media, openingText(input)], stable: view.length, type: "user" }];
      for (let round = 1; ; round++) {
        history.push(...(yield* steered(input, out)));
        const started = yield* Clock.currentTimeMillis;
        // one usage record per request; one that failed gets its record too when it cost something
        const record = (r: { readonly usage: Tokens; readonly model: string | null; readonly dollars?: number | undefined }) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            yield* out.usage({
              attempt: 1,
              auth: o.provider.auth,
              cold: isCold(r.usage),
              date: new Date(now).toISOString(),
              device: input.device,
              engine: o.provider.engine,
              failoverFrom,
              level: null,
              model: r.model,
              ms: now - started,
              role: "turn",
              usage: r.usage,
              dollars: r.dollars, // api-key only; JSON leaves it out when undefined
            });
          });
        const final = round >= rounds;
        const reply = yield* o.provider
          .call({ final, history, instructions: o.instructions, onItem: logged, onText: out.text, onThinking: out.thinking, tools: box.defs })
          .pipe(Effect.result);
        // what the call cost is recorded first, whether it failed or the log refused its items
        if (reply._tag === "Success") yield* record(reply.success);
        else if (isEngineError(reply.failure) && reply.failure._tag !== "DeviceOffline" && reply.failure.spent) yield* record(reply.failure.spent);
        if (track.refused !== null) return yield* track.refused;
        if (reply._tag === "Failure") return yield* reply.failure;
        const step = reply.success;
        if (step.cut !== undefined) yield* out.info(`${o.ref}: ${step.cut}, so it may stop mid-sentence or mid-call`);
        history.push(...step.items);
        const calls = step.items.flatMap((item) => (item.type === "call" ? [item] : []));
        if (calls.length === 0) return;
        if (final) {
          // the last request may call no tool; a model that still does gets each call answered in
          // the log, so no tool entry stands without its echo
          for (const _ of calls) yield* answer(`not run: this turn used its ${rounds} requests`);
          return yield* out.info(`${o.ref} stopped after ${rounds} requests with tool calls left`);
        }
        for (const call of calls) {
          const output = cap(yield* box.run(call.name, call.input));
          yield* answer(output);
          history.push({ id: call.id, output, type: "result" });
        }
      }
    }).pipe(Effect.onExit(unanswered));
  };
  return { ref: o.ref, run, vision: o.vision, warm: () => Effect.void }; // nothing to start ahead
};
