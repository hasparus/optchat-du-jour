import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber } from "effect";
import { RequestAdmission, admitRequest } from "../src/engines/request-admission.ts";
import { UsageLimit } from "../src/engines/errors.ts";
import { sizeRetries } from "../src/summarize/step.ts";
import { newMsg } from "../src/store.ts";
import { makeRunControl, runContenders, type ContenderOutcome, type DiagnosticReason, type Progress } from "../dev/bakeoff-run.ts";

const progress: Progress = { loggedMessages: 0, requestedMessages: 1, unbuiltNodes: ["0.0"], usageRecords: 0 };
const unbuilt = (name: string): DiagnosticReason => ({ contender: name, coord: { i: 0, l: 0 }, type: "unbuilt" });

test("request admission defaults to a production no-op", async () => {
  const admitted = await Effect.runPromise(admitRequest({ model: "production", transport: "openai-responses" }).pipe(Effect.as(true)));
  expect(admitted).toBe(true);
});

test("concurrent transport authorization permits exactly N and N+1 never reaches the boundary", async () => {
  const control = makeRunControl(7, false);
  let boundary = 0;
  const exits = await Effect.runPromise(
    Effect.all(
      Array.from({ length: 32 }, () =>
        Effect.flatMap(RequestAdmission, (admission) => admission.authorize({ model: "m", transport: "openai-responses" })).pipe(
          Effect.andThen(Effect.sync(() => void boundary++)),
          Effect.exit,
        ),
      ),
      { concurrency: "unbounded" },
    ).pipe(Effect.provideService(RequestAdmission, control.admission)),
  );
  expect(boundary).toBe(7);
  expect(exits.filter((exit) => exit._tag === "Success")).toHaveLength(7);
  expect(control.snapshot()).toEqual({ authorizedRequests: 7, maxRequests: 7 });
  expect(control.globalAbort()).toEqual({ authorized: 7, max: 7, type: "max-authorized-requests" });
});

test("no-fail-fast ends a failed contender promptly and starts the next", async () => {
  const control = makeRunControl(10, false);
  const started: string[] = [];
  const outcome = await Effect.runPromise(
    runContenders({
      contenders: [{ name: "first" }, { name: "second" }],
      control,
      interruptedProgress: () => progress,
      persist: () => Effect.void,
      run: (contender, local): Effect.Effect<ContenderOutcome<string>> =>
        Effect.gen(function* () {
          started.push(contender.name);
          if (contender.name === "first") {
            const reason = unbuilt(contender.name);
            yield* local.fail(reason);
            return { name: contender.name, progress, reason, type: "failed" };
          }
          return { metrics: "ok", name: contender.name, type: "complete", usageRecords: 0 };
        }),
    }),
  );
  expect(started).toEqual(["first", "second"]);
  expect(outcome.type).toBe("completed-with-failures");
});

test("fail-fast gates later contenders", async () => {
  const control = makeRunControl(10, true);
  const started: string[] = [];
  const outcome = await Effect.runPromise(
    runContenders({
      contenders: [{ name: "first" }, { name: "second" }],
      control,
      interruptedProgress: () => progress,
      persist: () => Effect.void,
      run: (contender, local): Effect.Effect<ContenderOutcome<string>> =>
        Effect.gen(function* () {
          started.push(contender.name);
          const reason = unbuilt(contender.name);
          yield* local.fail(reason);
          return { name: contender.name, progress, reason, type: "failed" };
        }),
    }),
  );
  expect(started).toEqual(["first"]);
  expect(outcome.type).toBe("aborted");
  if (outcome.type === "aborted") expect(outcome.abort.type).toBe("fail-fast");
});

test("the global request cap remains authoritative after a local diagnostic", async () => {
  const control = makeRunControl(1, false);
  const local = control.begin("first");
  await Effect.runPromise(local.fail(unbuilt("first")));
  await Effect.runPromise(control.admission.authorize({ model: "m", transport: "claude" }));
  await Effect.runPromise(Effect.exit(control.admission.authorize({ model: "m", transport: "claude" })));
  expect(control.globalAbort()?.type).toBe("max-authorized-requests");
});

test("spent UsageLimit accounting finishes before terminal observation", async () => {
  const order: string[] = [];
  const result = await Effect.runPromise(
    Effect.result(
      sizeRetries({
        ask: () => Effect.fail(new UsageLimit({ message: "PRIVATE", spent: { model: "m", usage: { cacheRead: 0, cacheWrite: 0, input: 2, output: 1 } } })),
        auth: "chatgpt-pro",
        effort: undefined,
        engine: "openai-plan",
        failoverFrom: null,
        job: { ctx: [], i: 0, l: 0, msg: newMsg(0, "user", "x".repeat(600)) },
        log: () => Effect.sleep("20 millis").pipe(Effect.andThen(Effect.sync(() => void order.push("recorded", "budgeted")))),
      }).pipe(Effect.tapError(() => Effect.sync(() => void order.push("observed")))),
    ),
  );
  expect(result._tag).toBe("Failure");
  expect(order).toEqual(["recorded", "budgeted", "observed"]);
});

test("terminal cancellation waits for finalizers", async () => {
  const control = makeRunControl(10, false);
  const local = control.begin("first");
  const started = Deferred.makeUnsafe<null>();
  let finalized = false;
  const work = Effect.acquireUseRelease(
    Deferred.succeed(started, null),
    () => Effect.never,
    () => Effect.sync(() => void (finalized = true)),
  );
  const fiber = Effect.runFork(Effect.race(work, local.awaitTerminal));
  await Effect.runPromise(Deferred.await(started));
  await Effect.runPromise(local.fail(unbuilt("first")));
  await Effect.runPromise(Fiber.await(fiber));
  expect(finalized).toBe(true);
});
