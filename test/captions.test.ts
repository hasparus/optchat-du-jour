// A message's captions (src/captions.ts) on their own: asked for once, and settled whoever stops.
import { expect, test } from "bun:test";
import { Effect, Exit, Option, Scope } from "effect";
import { makeCaptions } from "../src/captions.ts";
import type { Incoming } from "../src/inbox.ts";
import type { Asset } from "../src/wire.ts";

const photo: Asset = { bytes: 1000, height: 10, kind: "image", mime: "image/jpeg", sha: "a".repeat(64), width: 10 };
const message = (): Incoming => ({ clientId: null, described: null, device: null, engine: "claude-code:opus", media: [photo], seq: 1, state: "held", steer: false, text: "look" });

test("a caption asked for before the session's scope closes is still settled: the stop waits for it, and every await of it gets it", async () => {
  const scope = Effect.runSync(Scope.make());
  let calls = 0;
  const caption = () =>
    Effect.sync(() => {
      calls += 1;
    }).pipe(Effect.andThen(Effect.sleep("30 millis")), Effect.as("a cat on a mat"));
  const { captionsOf } = makeCaptions({ media: { caption, known: () => null }, scope });
  const m = message();
  const first = Effect.runPromise(captionsOf(m)); // the caption call starts, in the scope
  await Effect.runPromise(Effect.yieldNow);
  // the server stops: the scope closes while the call runs, and a later await doesn't hang
  await Effect.runPromise(Scope.close(scope, Exit.void));
  const later = await Effect.runPromise(captionsOf(m).pipe(Effect.timeoutOption("1 second")));
  expect(Option.getOrNull(later)).toEqual(["a cat on a mat"]);
  expect(await first).toEqual(["a cat on a mat"]);
  expect(calls).toBe(1); // asked for once
});
