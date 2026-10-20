// The live run (src/live-run.ts) on its own: what a client joining mid-run is shown of the reply,
// and what a reply dropped unlogged says. Plain functions in, no session.
import { expect, test } from "bun:test";
import { Effect, Scope } from "effect";
import { makeLiveRun } from "../src/live-run.ts";
import type { SessionEvent } from "../src/session-events.ts";

const harness = () => {
  const sent: SessionEvent[] = [];
  let length = 3;
  const run = makeLiveRun({
    engine: () => "claude-code:opus",
    length: () => length,
    now: () => 0,
    publish: (e) =>
      Effect.sync(() => {
        sent.push(e);
      }),
    scope: Effect.runSync(Scope.make()),
  });
  // an entry went into the log
  const logged = (kind: "talk" | "tool") => {
    length += 1;
    run.logged(kind);
  };
  return { logged, run, sent, types: () => sent.map((e) => e.type) };
};

test("a reply's buffered text is live until it is logged, then the next streams anew at the new index", () => {
  const { logged, run, sent } = harness();
  Effect.runSync(run.begin("r1").pipe(Effect.andThen(run.stream("Hi ", "r1")), Effect.andThen(run.stream("there", "r1"))));
  expect(run.live()?.reply).toEqual({ at: 3, text: "Hi there" });
  logged("talk");
  expect(run.live()?.reply).toBeNull();
  Effect.runSync(run.stream("Next", "r1"));
  expect(sent.at(-1)).toEqual({ at: 4, delta: "Next", offset: 0, runId: "r1", type: "text" });
});

test("a reply dropped unlogged is said once and cleared; with nothing streaming, nothing is said", () => {
  const { run, types } = harness();
  Effect.runSync(run.begin("r1").pipe(Effect.andThen(run.dropReply("r1"))));
  expect(types()).toEqual(["run-started"]);
  Effect.runSync(run.stream("Hel", "r1").pipe(Effect.andThen(run.dropReply("r1")), Effect.andThen(run.dropReply("r1"))));
  expect(types()).toEqual(["run-started", "text", "reply-dropped"]);
  expect(run.live()?.reply).toBeNull();
});
