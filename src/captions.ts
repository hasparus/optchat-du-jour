// The captions of a message's attachments, as the session (src/session.ts) waits for them, and the
// message's text as the log keeps it with them (SPEC "Media").
import { Deferred, Effect, type Scope } from "effect";
import type { Incoming } from "./inbox.ts";
import { type Asset, markerOf, NOT_DESCRIBED, withMarkers } from "./wire.ts";

export const makeCaptions = (o: {
  // the media service's caption, waited for at most a few seconds; one a call already gave,
  // without asking for one (null: none) (src/session.ts SessionMedia)
  readonly media: { readonly caption: (a: Asset) => Effect.Effect<string>; readonly known: (a: Asset) => string | null };
  readonly scope: Scope.Scope; // the session's
}) => {
  // A message's attachments' captions, each waited for at most media.captionWait, asked for once:
  // what the log keeps of the message and what an engine is sent of it come from this one answer,
  // so they agree, and a marker is never written without having waited for its caption. Asked
  // first while the session's scope closes (the server stops, and logs what it holds), they are
  // what the media service already has (the call starts at upload, so usually all of them), and
  // NOT_DESCRIBED for the rest: a caption call started then would be paid for and cut off.
  const captionsOf = (m: Incoming): Effect.Effect<readonly string[]> =>
    Effect.suspend(() => {
      if (m.described) return Deferred.await(m.described);
      const done = Deferred.makeUnsafe<readonly string[]>();
      m.described = done;
      if (o.scope.state._tag === "Closed") return Deferred.succeed(done, m.media.map((a) => o.media.known(a) ?? NOT_DESCRIBED)).pipe(Effect.andThen(Deferred.await(done)));
      // Uninterruptible, so `done` is settled whoever stops: a fiber interrupted before it starts
      // (the scope closing, as the server stops) would never run, and every await of it hang. A
      // caption waits at most media.captionWait.
      return Effect.forEach(m.media, (a) => o.media.caption(a), { concurrency: "unbounded" }).pipe(
        Effect.flatMap((said) => Deferred.succeed(done, said)),
        Effect.forkIn(o.scope, { uninterruptible: true }),
        Effect.andThen(Deferred.await(done)),
      );
    });
  // these messages' captions, asked for together: a turn waits once for the lot
  const captioned = (ms: readonly Incoming[]) => Effect.forEach(ms, captionsOf, { concurrency: "unbounded", discard: true });
  return { captioned, captionsOf };
};

// A message's text as the log keeps it: what was typed, then a marker line per attachment with
// its caption (SPEC "Media")
export const logText = (m: Incoming, said: readonly string[]) =>
  withMarkers(
    m.text,
    m.media.map((a, k) => markerOf(a, said[k] ?? NOT_DESCRIBED)),
  );
