// A failover chain (E4): the first engine that answers wins. Only a spent plan or an offline
// device moves the call on to the next engine; a refusal or a model error is the answer.
import { Effect } from "effect";

type Failure = { readonly _tag: string; readonly message: string };
export type Link<A, E extends Failure> = { readonly ref: string; readonly run: (failoverFrom: string | null) => Effect.Effect<A, E> };

const movesOn = (e: Failure) => e._tag === "UsageLimit" || e._tag === "DeviceOffline";

export const failover = <A, E extends Failure>(
  links: readonly Link<A, E>[],
  moved: (from: string, to: string, why: string) => Effect.Effect<void>,
): Effect.Effect<A, E> => {
  const go = (k: number, from: string | null): Effect.Effect<A, E> => {
    const link = links[k];
    if (!link) return Effect.die(new Error("an empty engine chain"));
    const next = links[k + 1];
    const attempt = link.run(from);
    if (!next) return attempt;
    return attempt.pipe(
      Effect.catchIf(movesOn, (e) => moved(link.ref, next.ref, e.message).pipe(Effect.andThen(go(k + 1, link.ref)))),
    );
  };
  return go(0, null);
};
