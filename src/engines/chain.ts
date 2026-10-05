// A failover chain (E4): the first engine that answers wins. Only a spent plan or an offline
// device moves the call on to the next engine; a refusal or a model error is the answer.
import { Effect, type PubSub } from "effect";
import type { Down } from "../wire.ts";

export type { Down } from "../wire.ts";

type Failure = { readonly _tag: string; readonly message: string };
export type Link<A, E extends Failure> = { readonly ref: string; readonly run: (failoverFrom: string | null) => Effect.Effect<A, E> };

const movesOn = (e: Failure) => e._tag === "UsageLimit" || e._tag === "DeviceOffline";

// Every engine call any chain starts gets the next number, so a watcher can tell a call that
// began before an engine changed state from one that began after.
let begun = 0;

export const failover = <A, E extends Failure>(
  links: readonly Link<A, E>[],
  moved: (from: string, to: string, why: string, started: number) => Effect.Effect<void>,
  answered: (ref: string, started: number) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<A, E> => {
  const go = (k: number, from: string | null): Effect.Effect<A, E> => {
    const link = links[k];
    if (!link) return Effect.die(new Error("an empty engine chain"));
    const next = links[k + 1];
    return Effect.suspend(() => {
      const started = ++begun;
      const attempt = link.run(from).pipe(Effect.tap(() => answered(link.ref, started)));
      if (!next) return attempt;
      return attempt.pipe(
        Effect.catchIf(movesOn, (e) => moved(link.ref, next.ref, e.message, started).pipe(Effect.andThen(go(k + 1, link.ref)))),
      );
    });
  };
  return go(0, null);
};



// The engines of a chain down right now, with why, and a signal each time that list changes, for
// a session that shows it to clients connecting later (SPEC "Policy": never unseen).
export type DownList = { readonly now: () => readonly Down[]; readonly changes: PubSub.PubSub<readonly Down[]> };

// Which engines are down, for a chain that runs many calls at once (the compactor's nodes): one
// notice when an engine goes down and one when it answers again, not one per call, so a
// signed-out plan doesn't flood the UI and its return doesn't go unseen. Only a call started
// after the engine last went down or came back can change that: with JOBS calls in flight when
// a plan hits its cap, one that was already under way may still succeed, and is no sign the plan
// is back. `down` is the list right now, for a client that connects later; `changed` runs after
// each notice.
export const watchChain = (report: (message: string) => Effect.Effect<void>, doing: string, changed: Effect.Effect<void> = Effect.void) => {
  const down = new Map<string, string>(); // ref → why
  const flipped = new Map<string, number>(); // ref → the last call number when it went down or came back
  const stale = (ref: string, started: number) => started <= (flipped.get(ref) ?? 0);
  return {
    answered: (ref: string, started: number) => {
      if (!down.has(ref) || stale(ref, started)) return Effect.void;
      down.delete(ref);
      flipped.set(ref, begun);
      return report(`${ref} back: ${doing} on it again`).pipe(Effect.andThen(changed));
    },
    down: (): readonly Down[] => [...down].map(([ref, reason]) => ({ reason, ref })),
    moved: (from: string, to: string, why: string, started: number) => {
      if (down.has(from) || stale(from, started)) return Effect.void;
      down.set(from, why);
      flipped.set(from, begun);
      return report(`${from} unavailable: ${why}; ${doing} on ${to}`).pipe(Effect.andThen(changed));
    },
  };
};
