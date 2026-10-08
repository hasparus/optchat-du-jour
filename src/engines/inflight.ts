// docs/optchat.md §3.3: "A call whose marked prefix another call is writing waits until that call's
// response starts; otherwise both pay to write it." Compactions start up to 8 at a time on one
// prefix (their compaction view up to the first unbuilt line), so the first to go writes it and
// the rest read it. A call names its marked prefix by a key (the engine, model, system prompt,
// tools and the content up to its last mark, hashed); a call with no key (nothing marked but its
// end, which no other call shares) never waits. The writer's response has started at its first
// response event; a writer that fails before that frees the next waiter to write instead.
import { Deferred, Effect } from "effect";

export type Gate = {
  // `call` once no other call is writing `key`; it runs `started` at its first response event
  readonly through: <A, E, R>(key: string | null, call: (started: Effect.Effect<void>) => Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
};

// a key for what a request sends up to its last mark: the strings, in order, hashed
export const prefixKey = (parts: readonly string[]): string => {
  const hash = new Bun.CryptoHasher("sha256");
  for (const p of parts) hash.update(`${p.length}:${p}`);
  return hash.digest("hex");
};

export const makeGate = (): Gate => {
  // the call writing each prefix now, and whether its response started (true) or it ended first
  const writing = new Map<string, Deferred.Deferred<boolean>>();
  const through: Gate["through"] = (key, call) =>
    key === null
      ? call(Effect.void)
      : Effect.suspend(() => {
          const busy = writing.get(key);
          if (busy) return Deferred.await(busy).pipe(Effect.flatMap((started) => (started ? call(Effect.void) : through(key, call))));
          const mine = Deferred.makeUnsafe<boolean>();
          writing.set(key, mine);
          const settle = (started: boolean) =>
            Effect.suspend(() => {
              if (writing.get(key) === mine) writing.delete(key);
              return Deferred.succeed(mine, started);
            }).pipe(Effect.asVoid);
          return call(settle(true)).pipe(Effect.ensuring(settle(false))); // a call that ends without starting frees the waiters
        });
  return { through };
};
