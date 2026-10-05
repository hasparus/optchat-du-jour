// A failover chain (E4): the first engine that answers wins. Only a spent plan or an offline
// device moves the call on to the next engine; a refusal or a model error is the answer.
import { Effect } from "effect";

type Failure = { readonly _tag: string; readonly message: string };
export type Link<A, E extends Failure> = { readonly ref: string; readonly run: (failoverFrom: string | null) => Effect.Effect<A, E> };

const movesOn = (e: Failure) => e._tag === "UsageLimit" || e._tag === "DeviceOffline";

export const failover = <A, E extends Failure>(
  links: readonly Link<A, E>[],
  moved: (from: string, to: string, why: string) => Effect.Effect<void>,
  answered: (ref: string) => Effect.Effect<void> = () => Effect.void,
): Effect.Effect<A, E> => {
  const go = (k: number, from: string | null): Effect.Effect<A, E> => {
    const link = links[k];
    if (!link) return Effect.die(new Error("an empty engine chain"));
    const next = links[k + 1];
    const attempt = link.run(from).pipe(Effect.tap(() => answered(link.ref)));
    if (!next) return attempt;
    return attempt.pipe(
      Effect.catchIf(movesOn, (e) => moved(link.ref, next.ref, e.message).pipe(Effect.andThen(go(k + 1, link.ref)))),
    );
  };
  return go(0, null);
};

// Which engines are down, for a chain that runs many calls at once (the compactor's nodes): one
// notice when an engine goes down and one when it answers again, not one per call, so a
// signed-out plan doesn't flood the UI and its return doesn't go unseen.
export const watchChain = (report: (message: string) => Effect.Effect<void>, doing: string) => {
  const down = new Set<string>();
  return {
    answered: (ref: string) => {
      if (!down.delete(ref)) return Effect.void;
      return report(`${ref} back: ${doing} on it again`);
    },
    moved: (from: string, to: string, why: string) => {
      if (down.has(from)) return Effect.void;
      down.add(from);
      return report(`${from} unavailable: ${why}; ${doing} on ${to}`);
    },
  };
};
