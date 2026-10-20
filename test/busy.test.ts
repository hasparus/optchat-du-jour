// "Busy, asking again in N s" (E43): while our tool loop's engine waits before it sends a request
// again (E35, src/engines/retry.ts), the session's state says how long it will wait and which try
// comes next; the state drops it when the next try starts, and when the turn ends, however it ends.
// A scripted provider stands in for the HTTP engine: no model, no network.
import { afterAll, expect, test } from "bun:test";
import { Deferred, Effect, PubSub } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import type { Provider } from "../src/providers/provider.ts";
import { makeSession, noMedia, type SessionEvent } from "../src/session.ts";
import { toolLoop } from "../src/turn/loop.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

const until = (what: string, ok: () => boolean, ms = 4000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("5 millis");
    }
  });

const USAGE = { cacheRead: 0, cacheWrite: 0, input: 1, output: 1 };

// A provider whose call pauses as askAgain does (a 30 s pause before try 2 of 4), then waits for
// `go`: resolved true, the pause ends and the reply comes; never resolved, the turn is cancelled
// mid-pause. `seen.paused` once the pause was told to the session.
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

const rig = (provider: Provider) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(`${tmpdir()}/oc-`);
    dirs.push(dir);
    const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
    const engine = toolLoop({ instructions: "MASTER", provider, ref: "api-key:x", toolsFor: () => ({ defs: [], run: () => Effect.die(new Error("no tools here")) }), vision: false });
    const session = yield* makeSession({
      chat,
      commit: Effect.succeed(null),
      defaultDevice: "mini",
      devices: ["mini"],
      engines: [engine],
      choices: {},
      idle: "1 hour",
      logUsage: () => Effect.void,
      media: noMedia,
      waitRetry: "1 hour",
      wake: null,
    });
    const events: SessionEvent[] = [];
    const sub = yield* PubSub.subscribe(session.events);
    yield* PubSub.take(sub).pipe(
      Effect.tap((e) => Effect.sync(() => events.push(e))),
      Effect.forever,
      Effect.forkScoped,
    );
    const states = () => events.flatMap((e) => (e.type === "state" ? [e.state] : []));
    const idleAfter = (n: number) => states().slice(n).some((s) => s.phase === "idle");
    return { events, idleAfter, session, states };
  });

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

test("a turn cancelled while its engine waits to ask again: the state drops the wait with the turn (E43)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const go = Deferred.makeUnsafe<true>(); // never resolved: the pause lasts until the cancel
      const { provider, seen } = pausing(go);
      const r = yield* rig(provider);
      yield* r.session.input("hello");
      yield* until("the pause told", () => seen.paused && r.states().some((s) => s.retry));
      const before = r.states().length;
      yield* r.session.cancel;
      yield* until("idle", () => r.idleAfter(before));
      expect(r.session.state().retry).toBeNull();
      expect(r.states().at(-1)?.retry).toBeNull();
      expect(r.events.some((e) => e.type === "run-finished" && e.error === "cancelled")).toBe(true);
    }).pipe(Effect.scoped),
  );
});
