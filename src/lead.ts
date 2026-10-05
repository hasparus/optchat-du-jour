// The engine of the master's chain that turns run on (SPEC "Engines", E4): the user's pick, the
// chain's first until one is made. The master never fails over by itself: a usage limit or an
// offline device stops the turn, which waits here for a pick. An engine that hit a usage limit is
// marked down, with why, for the picker, until it answers again or MASTER_DOWN_FOR passes.
import { Deferred, Effect, PubSub } from "effect";
import { MASTER_DOWN_FOR } from "./config.ts";
import { engineLabel, type MasterEngine } from "./wire.ts";

// a turn a usage limit or an offline device stopped: the engine and why, and what the pick settles
type AwaitingPick = { readonly ref: string; readonly why: string; readonly pick: Deferred.Deferred<true> };

// `refs`: the master's chain, by the refs its engines carry; `initial`: a saved pick
export const makeLead = (o: { readonly refs: readonly string[]; readonly initial?: string }) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    // the turn waiting for a pick, if one is
    let awaitingPick: AwaitingPick | null = null;
    const first = o.refs[0] ?? "";
    let picked: string | null = o.refs.slice(1).find((r) => r === o.initial) ?? null;
    // engine ref → why it is down, and the mark that set it (a newer mark outlives an older timer)
    const down = new Map<string, { readonly why: string; readonly mark: number }>();
    let marks = 0;
    // a mark lapsed: what the picker shows changed by itself
    const changes = yield* PubSub.unbounded<true>();

    return {
      changes,
      // the engine turns run on ("" in a session that is not tested on turns)
      ref: () => picked ?? first,
      // what a client keeps of the pick: the ref, unless it is the chain's own first
      choice: () => picked ?? undefined,
      engines: (): MasterEngine[] => o.refs.map((ref) => ({ down: down.get(ref)?.why ?? null, label: engineLabel(ref), ref })),
      stopped: () => awaitingPick && { label: engineLabel(awaitingPick.ref), ref: awaitingPick.ref, why: awaitingPick.why },
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
      // it answered: true when it was down
      cameBack: (ref: string) => down.delete(ref),
      // a turn stops: it waits on the returned Deferred, which a pick settles
      stop: (ref: string, why: string) => {
        const pick = Deferred.makeUnsafe<true>();
        awaitingPick = { pick, ref, why };
        return pick;
      },
      // the turn went on after its pick, or stopped waiting (a cancel)
      resumed: () => {
        awaitingPick = null;
      },
      // A pick: the engine turns run on from the next call, and the one a stopped turn goes on
      // with (the same one again is a retry). Null, or why it is refused.
      pick: (ref: string) =>
        Effect.suspend(() => {
          if (!o.refs.includes(ref)) return Effect.succeed(`${ref} is not an engine of the master's chain (${o.refs.join(", ")})`);
          picked = ref === first ? null : ref;
          return awaitingPick ? Deferred.succeed(awaitingPick.pick, true).pipe(Effect.as(null)) : Effect.succeed(null);
        }),
    };
  });
export type Lead = Effect.Success<ReturnType<typeof makeLead>>;
