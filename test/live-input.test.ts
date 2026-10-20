// A file tool's input streams to clients as the model writes it (E45): the session tells each piece
// with the log index its entry is expected at and its place in the input, keeps the input so far for
// a client that joins, and when an entry is logged meanwhile tells the input so far again, whole,
// under the next index. Any other tool's input streams to no one. A scripted provider, no model.
import { expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import type { Provider } from "../src/providers/provider.ts";
import type { SessionEvent } from "../src/session.ts";
import { rig, until, USAGE } from "./loop-rig.ts";

const EDIT = JSON.stringify({ file_path: "src/a.ts", old_string: "a\nb\n", new_string: "a\nc\n" });
const [A, B, C] = [EDIT.slice(0, 20), EDIT.slice(20, 45), EDIT.slice(45)];
const call = { id: "toolu_1", name: "Edit" };

// streams the Edit's first piece, logs a reply (as an engine that sends a text block late would),
// streams the rest, and a Read's input; then waits for `go` and ends the turn with no call
const streaming = (go: Deferred.Deferred<true>) => {
  const provider: Provider = {
    auth: "api-key",
    call: (c) =>
      Effect.gen(function* () {
        const hooks = c.onToolInput;
        if (!hooks) return yield* Effect.die(new Error("no tool input hooks"));
        yield* hooks.delta(call, A);
        yield* c.onItem?.({ text: "first a word", type: "text" }) ?? Effect.void;
        yield* hooks.delta(call, B);
        yield* hooks.delta(call, C);
        yield* hooks.delta({ id: "toolu_2", name: "Read" }, '{"file_path":"src/a.ts"}');
        yield* Deferred.await(go);
        return { items: [{ text: "first a word", type: "text" as const }], model: "m", usage: USAGE };
      }),
    engine: "api-key",
  };
  return provider;
};

const inputs = (events: readonly SessionEvent[]) => events.flatMap((e) => (e.type === "tool-input" ? [e] : []));

test("an Edit's input is told piece by piece at the index its entry is expected at, again whole when that index moves; a Read's is not (E45)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const go = Deferred.makeUnsafe<true>();
      const r = yield* rig(streaming(go));
      yield* r.session.input("fix it");
      yield* until("the input", () => inputs(r.events).length === 3);
      expect(inputs(r.events).map((e) => [e.at, e.offset, e.delta, e.call, e.name])).toEqual([
        [1, 0, A, "toolu_1", "Edit"],
        [2, 0, A + B, "toolu_1", "Edit"], // the reply took 1: the input so far, under 2
        [2, A.length + B.length, C, "toolu_1", "Edit"],
      ]);
      // a client that joins now gets the input so far
      expect(r.session.live()?.tool).toEqual({ args: EDIT, at: 2, call: "toolu_1", name: "Edit" });
      yield* Deferred.succeed(go, true);
      yield* until("the run's end", () => r.events.some((e) => e.type === "run-finished"));
      expect(r.session.live()).toBeNull();
      expect(inputs(r.events)).toHaveLength(3); // the Read's input went to no one
    }).pipe(Effect.scoped),
  );
});
