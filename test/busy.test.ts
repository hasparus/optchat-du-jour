// "Busy, asking again in N s" (E43): while our tool loop's engine waits before it sends a request
// again (E35, src/engines/retry.ts), the session's state says how long it will wait and which try
// comes next; the state drops it when the next try starts, and when the turn ends, however it ends.
// A scripted provider stands in for the HTTP engine: no model, no network.
import { expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import type { Provider } from "../src/providers/provider.ts";
import { rig, until, USAGE } from "./loop-rig.ts";

// A provider whose call pauses as askAgain does (a 30 s pause before try 2 of 4, its end told
// however it ends), then waits for `go`; once that resolves, the pause ends and the reply comes.
// `seen.paused` once the pause was told to the session.
const pausing = (go: Deferred.Deferred<true>) => {
  const seen = { paused: false };
  const provider: Provider = {
    auth: "api-key",
    call: (c) =>
      Effect.gen(function* () {
        const told = c.onRetry ?? (() => Effect.void);
        yield* told({ ms: 30_000, next: 2, tries: 4 }).pipe(
          Effect.andThen(Effect.sync(() => (seen.paused = true))),
          Effect.andThen(Deferred.await(go)),
          Effect.ensuring(told(null)),
        );
        yield* c.onText("done");
        yield* c.onItem?.({ text: "done", type: "text" }) ?? Effect.void;
        return { items: [{ text: "done", type: "text" as const }], model: "m", usage: USAGE };
      }),
    engine: "api-key",
  };
  return { provider, seen };
};

test("the state says the turn's engine waits to ask again, for how long and before which try, until the try starts (E43)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const go = Deferred.makeUnsafe<true>();
      const { provider, seen } = pausing(go);
      const r = yield* rig(provider);
      yield* r.session.input("hello");
      yield* until("the pause told", () => seen.paused && r.states().some((s) => s.retry));
      const told = r.states().findLast((s) => s.retry);
      expect(told?.phase).toBe("running");
      expect(told?.retry?.next).toBe(2);
      expect(told?.retry?.tries).toBe(4);
      expect(told?.retry?.ms).toBeWithin(29_000, 30_001);
      // read again later, it counts down on the server's clock
      yield* Effect.sleep("30 millis");
      expect(r.session.state().retry?.ms).toBeLessThan(told?.retry?.ms ?? 0);
      // the try starts: the state drops it, and it is not there when the turn is over
      const before = r.states().length;
      yield* Deferred.succeed(go, true);
      yield* until("idle", () => r.idleAfter(before));
      const after = r.states().slice(before);
      expect(after[0]?.retry).toBeNull();
      expect(after.every((s) => s.retry === null)).toBe(true);
    }).pipe(Effect.scoped),
  );
});

// A provider that tells a pause and then never ends it itself: what clears the wait is the turn's end
const stuck: Provider = {
  auth: "api-key",
  call: (c) => (c.onRetry ?? (() => Effect.void))({ ms: 30_000, next: 2, tries: 4 }).pipe(Effect.andThen(Effect.never)),
  engine: "api-key",
};

test("a turn cancelled while its engine waits to ask again: the state drops the wait with the turn, whoever else forgets to (E43)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const r = yield* rig(stuck);
      yield* r.session.input("hello");
      yield* until("the pause told", () => r.states().some((s) => s.retry));
      const before = r.states().length;
      yield* r.session.cancel;
      yield* until("idle", () => r.idleAfter(before));
      expect(r.session.state().retry).toBeNull();
      expect(r.states().at(-1)?.retry).toBeNull();
      expect(r.events.some((e) => e.type === "run-finished" && e.error === "cancelled")).toBe(true);
    }).pipe(Effect.scoped),
  );
});
