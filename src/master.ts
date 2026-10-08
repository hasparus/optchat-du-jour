// The master's chain as the session keeps it (SPEC "Engines", E4, E18): which engine of it is
// down, and which one the warm processes follow. Each message names its own engine, so there is no
// engine of the session to pick; the master never fails over by itself. An engine that hit a usage
// limit is marked down, with why, for the pickers, until it answers again or MASTER_DOWN_FOR passes.
// The warm processes follow the engine of the most recent turn, the chain's first before any.
import { Effect, PubSub } from "effect";
import { MASTER_DOWN_FOR } from "./config.ts";
import { engineLabel, type MasterEngine } from "./wire.ts";

// `refs`: the master's chain, by the refs its engines carry; `effort`: the master's own, which a
// label leaves out for an engine that runs at it
export const makeMaster = (refs: readonly string[], effort?: string) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    let latest = refs[0] ?? "";
    // engine ref → why it is down, and the mark that set it (a newer mark outlives an older timer)
    const down = new Map<string, { readonly why: string; readonly mark: number }>();
    let marks = 0;
    // a mark lapsed: what the pickers show changed by itself
    const changes = yield* PubSub.unbounded<true>();

    return {
      changes,
      refs,
      label: (ref: string) => engineLabel(ref, effort),
      engines: (): MasterEngine[] => refs.map((ref) => ({ down: down.get(ref)?.why ?? null, label: engineLabel(ref, effort), ref })),
      // the engine the warm processes follow: the most recent turn's ("" for an empty chain)
      latest: () => latest,
      ran: (ref: string) => {
        latest = ref;
      },
      // an engine hit a usage limit: down until it answers or MASTER_DOWN_FOR passes
      wentDown: (ref: string, why: string) =>
        Effect.suspend(() => {
          const mark = ++marks;
          down.set(ref, { mark, why });
          const lapse = Effect.sleep(MASTER_DOWN_FOR).pipe(
            Effect.andThen(Effect.suspend(() => (down.get(ref)?.mark === mark && down.delete(ref) ? PubSub.publish(changes, true) : Effect.void))),
          );
          return Effect.asVoid(Effect.forkIn(lapse, scope));
        }),
      isDown: (ref: string) => down.has(ref),
      // it answered: true when it was down
      cameBack: (ref: string) => down.delete(ref),
    };
  });
export type Master = Effect.Success<ReturnType<typeof makeMaster>>;
