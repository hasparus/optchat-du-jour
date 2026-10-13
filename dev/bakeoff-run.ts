import { Deferred, Effect, Exit } from "effect";
import type { EngineExecutionPolicyService } from "../src/engines/request-admission.ts";
import { RequestNotAdmitted } from "../src/engines/request-admission.ts";
import type {
  ContenderOutcome,
  DiagnosticReason,
  GlobalAbort,
  Metrics,
  Progress,
  RunOutcome,
} from "./bakeoff-artifact.ts";

export type { CompleteContender, ContenderOutcome, DiagnosticReason, FailedContender, GlobalAbort, Metrics, Progress, RunOutcome } from "./bakeoff-artifact.ts";

export type TerminalSignal =
  | { readonly type: "contender"; readonly reason: DiagnosticReason }
  | { readonly type: "global"; readonly abort: GlobalAbort };

export type ContenderControl = {
  readonly policy: EngineExecutionPolicyService;
  readonly fail: (reason: DiagnosticReason) => Effect.Effect<boolean>;
  readonly awaitTerminal: Effect.Effect<TerminalSignal>;
  readonly reason: () => DiagnosticReason | undefined;
};

export type RunControl = {
  readonly begin: (name: string) => ContenderControl;
  readonly abortUnexpected: (contender?: string) => Effect.Effect<boolean>;
  readonly globalAbort: () => GlobalAbort | undefined;
  readonly snapshot: () => { readonly authorizedRequests: number; readonly maxRequests: number };
};

export type GlobalRunResult = {
  readonly type: "global-abort";
  readonly abort: GlobalAbort;
  readonly progress: Progress;
};
export type ContenderRunResult = ContenderOutcome | GlobalRunResult;

export const makeRunControl = (maxRequests: number, failFast = true): RunControl => {
  if (!Number.isSafeInteger(maxRequests) || maxRequests < 1) throw new Error("maxRequests must be a positive safe integer");
  const globalSignal = Deferred.makeUnsafe<GlobalAbort>();
  let authorizedRequests = 0;
  let globalAbort: GlobalAbort | undefined;

  const abort = (next: GlobalAbort): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      if (globalAbort !== undefined) return Effect.succeed(false);
      globalAbort = next;
      return Deferred.succeed(globalSignal, next);
    });

  const begin = (name: string): ContenderControl => {
    const localSignal = Deferred.makeUnsafe<DiagnosticReason>();
    let localReason: DiagnosticReason | undefined;
    const fail = (reason: DiagnosticReason): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        if (globalAbort !== undefined || localReason !== undefined) return Effect.succeed(false);
        localReason = reason;
        return Deferred.succeed(localSignal, reason).pipe(
          Effect.tap(() => failFast ? abort({ contender: name, reason, type: "fail-fast" }) : Effect.void),
        );
      });
    const policy: EngineExecutionPolicyService = {
      authorize: () =>
        Effect.suspend(() => {
          // Ordering is intentional: a global abort dominates a local closure, while a local
          // closure never consumes another request or creates a new global abort.
          if (globalAbort !== undefined) return Effect.fail(new RequestNotAdmitted({ reason: "global-abort" }));
          if (localReason !== undefined) return Effect.fail(new RequestNotAdmitted({ reason: "closed" }));
          if (authorizedRequests >= maxRequests) {
            const capped: GlobalAbort = { type: "max-authorized-requests" };
            return abort(capped).pipe(
              Effect.andThen(Effect.fail(new RequestNotAdmitted({ reason: "max-authorized-requests" }))),
            );
          }
          authorizedRequests++;
          return Effect.void;
        }),
      onFailure: (failure) =>
        failure.error._tag === "UsageLimit"
          ? fail({ coord: failure.coord, engine: failure.ref.slice(0, 100), type: "usage-limit" }).pipe(Effect.as("stop" as const))
          : Effect.succeed("continue" as const),
    };
    return {
      awaitTerminal: Effect.raceFirst(
        Deferred.await(localSignal).pipe(Effect.map((reason): TerminalSignal => ({ reason, type: "contender" }))),
        Deferred.await(globalSignal).pipe(Effect.map((next): TerminalSignal => ({ abort: next, type: "global" }))),
      ),
      fail,
      policy,
      reason: () => localReason,
    };
  };

  return {
    abortUnexpected: (contender) => abort({ contender, type: "unexpected" }),
    begin,
    globalAbort: () => globalAbort,
    snapshot: () => ({ authorizedRequests, maxRequests }),
  };
};

export const runContenders = <C extends { readonly name: string }, E, R>(o: {
  readonly contenders: readonly C[];
  readonly control: RunControl;
  readonly run: (contender: C, local: ContenderControl) => Effect.Effect<ContenderRunResult, E, R>;
  readonly persist: (outcome: RunOutcome) => Effect.Effect<void>;
}): Effect.Effect<RunOutcome, E, R> => {
  const outcomes: ContenderOutcome[] = [];
  let active: C | undefined;
  let knownProgress: Progress | undefined;
  const running = (): RunOutcome => ({
    active: active === undefined ? { type: "none" } : { name: active.name, type: "active" },
    contenders: [...outcomes],
    type: "running",
  });
  const aborted = (abort: GlobalAbort): RunOutcome => ({
    abort,
    active: active === undefined
      ? { type: "none" }
      : knownProgress === undefined
        ? { name: active.name, type: "unavailable" }
        : { name: active.name, progress: knownProgress, type: "interrupted" },
    contenders: [...outcomes],
    type: "aborted",
  });

  return Effect.gen(function* () {
    yield* o.persist(running());
    for (const contender of o.contenders) {
      if (o.control.globalAbort() !== undefined) break;
      active = contender;
      knownProgress = undefined;
      yield* o.persist(running());
      const result = yield* o.run(contender, o.control.begin(contender.name));
      if (result.type === "global-abort") {
        knownProgress = result.progress;
        const outcome = aborted(result.abort);
        yield* o.persist(outcome);
        return outcome;
      }
      outcomes.push(result);
      active = undefined;
      yield* o.persist(running());
      if (o.control.globalAbort() !== undefined) break;
    }
    const abort = o.control.globalAbort();
    const outcome: RunOutcome = abort !== undefined
      ? aborted(abort)
      : outcomes.some((item) => item.type === "failed")
        ? { contenders: [...outcomes], type: "completed-with-failures" }
        : { contenders: outcomes.filter((item): item is Extract<ContenderOutcome, { readonly type: "complete" }> => item.type === "complete"), type: "complete" };
    yield* o.persist(outcome);
    return outcome;
  }).pipe(
    Effect.onExit((exit) => {
      if (Exit.isSuccess(exit)) return Effect.void;
      return o.control.abortUnexpected(active?.name).pipe(
        Effect.andThen(Effect.suspend(() => o.persist(aborted(o.control.globalAbort() ?? { contender: active?.name, type: "unexpected" })))),
        Effect.ignore,
      );
    }),
  );
};
