import { Deferred, Effect, Exit } from "effect";
import type { RequestAdmissionService } from "../src/engines/request-admission.ts";
import { RequestNotAdmitted } from "../src/engines/request-admission.ts";

export type Coord = { readonly l: number; readonly i: number };
export type DiagnosticReason =
  | { readonly type: "usage-limit"; readonly contender: string; readonly engine: string; readonly coord: Coord }
  | { readonly type: "over-limit"; readonly contender: string; readonly coord: Coord; readonly bytes: number; readonly limit: number }
  | { readonly type: "unbuilt"; readonly contender: string; readonly coord: Coord }
  | { readonly type: "deadline"; readonly contender: string; readonly duration: string };

export type Progress = {
  readonly loggedMessages: number;
  readonly requestedMessages: number;
  readonly unbuiltNodes: readonly string[];
  readonly usageRecords: number;
};

export type CompleteContender<M> = { readonly type: "complete"; readonly name: string; readonly metrics: M; readonly usageRecords: number };
export type FailedContender = { readonly type: "failed"; readonly name: string; readonly reason: DiagnosticReason; readonly progress: Progress };
export type ContenderOutcome<M> = CompleteContender<M> | FailedContender;

export type GlobalAbort =
  | { readonly type: "max-authorized-requests"; readonly authorized: number; readonly max: number }
  | { readonly type: "fail-fast"; readonly contender: string; readonly reason: DiagnosticReason }
  | { readonly type: "unexpected"; readonly contender?: string | undefined };

export type ActiveProgress =
  | { readonly type: "none" }
  | { readonly type: "interrupted"; readonly name: string; readonly progress: Progress };

export type RunOutcome<M> =
  | { readonly type: "complete"; readonly contenders: readonly CompleteContender<M>[] }
  | { readonly type: "completed-with-failures"; readonly contenders: readonly ContenderOutcome<M>[] }
  | { readonly type: "aborted"; readonly abort: GlobalAbort; readonly contenders: readonly ContenderOutcome<M>[]; readonly active: ActiveProgress };

export type TerminalSignal =
  | { readonly type: "contender"; readonly reason: DiagnosticReason }
  | { readonly type: "global"; readonly abort: GlobalAbort };

export type ContenderControl = {
  readonly name: string;
  readonly fail: (reason: DiagnosticReason) => Effect.Effect<boolean>;
  readonly awaitTerminal: Effect.Effect<TerminalSignal>;
  readonly reason: () => DiagnosticReason | undefined;
};

export type RunControl = {
  readonly admission: RequestAdmissionService;
  readonly begin: (name: string) => ContenderControl;
  readonly abortUnexpected: (contender?: string) => Effect.Effect<boolean>;
  readonly awaitGlobal: Effect.Effect<GlobalAbort>;
  readonly globalAbort: () => GlobalAbort | undefined;
  readonly snapshot: () => { readonly authorizedRequests: number; readonly maxRequests: number };
};

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

  const admission: RequestAdmissionService = {
    authorize: () =>
      Effect.suspend(() => {
        if (globalAbort !== undefined) return Effect.fail(new RequestNotAdmitted({ reason: "max-authorized-requests" }));
        if (authorizedRequests >= maxRequests) {
          const capped: GlobalAbort = { authorized: authorizedRequests, max: maxRequests, type: "max-authorized-requests" };
          return abort(capped).pipe(Effect.andThen(Effect.fail(new RequestNotAdmitted({ reason: "max-authorized-requests" }))));
        }
        authorizedRequests++;
        return Effect.void;
      }),
  };

  const begin = (name: string): ContenderControl => {
    const localSignal = Deferred.makeUnsafe<DiagnosticReason>();
    let localReason: DiagnosticReason | undefined;
    const fail = (reason: DiagnosticReason): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        if (localReason !== undefined || globalAbort !== undefined) return Effect.succeed(false);
        localReason = reason;
        return Deferred.succeed(localSignal, reason).pipe(
          Effect.tap(() => (failFast ? abort({ contender: name, reason, type: "fail-fast" }) : Effect.void)),
        );
      });
    return {
      awaitTerminal: Effect.raceFirst(
        Deferred.await(localSignal).pipe(Effect.map((reason): TerminalSignal => ({ reason, type: "contender" }))),
        Deferred.await(globalSignal).pipe(Effect.map((abort): TerminalSignal => ({ abort, type: "global" }))),
      ),
      fail,
      name,
      reason: () => localReason,
    };
  };

  return {
    abortUnexpected: (contender) => abort({ contender, type: "unexpected" }),
    admission,
    awaitGlobal: Deferred.await(globalSignal),
    begin,
    globalAbort: () => globalAbort,
    snapshot: () => ({ authorizedRequests, maxRequests }),
  };
};

export const runContenders = <C extends { readonly name: string }, M, E, R>(o: {
  readonly contenders: readonly C[];
  readonly control: RunControl;
  readonly run: (contender: C, local: ContenderControl) => Effect.Effect<ContenderOutcome<M>, E, R>;
  readonly persist: (outcome: RunOutcome<M>) => Effect.Effect<void>;
  readonly interruptedProgress: (contender: C) => Progress;
}): Effect.Effect<RunOutcome<M>, E, R> => {
  const outcomes: ContenderOutcome<M>[] = [];
  let active: C | undefined;
  const aborted = (abort: GlobalAbort): RunOutcome<M> => ({
    abort,
    active: active === undefined ? { type: "none" } : { name: active.name, progress: o.interruptedProgress(active), type: "interrupted" },
    contenders: [...outcomes],
    type: "aborted",
  });
  const currentOutcome = (finished: boolean): RunOutcome<M> => {
    const abort = o.control.globalAbort();
    if (abort !== undefined) return aborted(abort);
    if (!finished) return aborted({ contender: active?.name, type: "unexpected" });
    if (outcomes.some((outcome) => outcome.type === "failed")) return { contenders: [...outcomes], type: "completed-with-failures" };
    const complete = outcomes.filter((outcome): outcome is CompleteContender<M> => outcome.type === "complete");
    return { contenders: complete, type: "complete" };
  };

  return Effect.gen(function* () {
    for (const contender of o.contenders) {
      if (o.control.globalAbort() !== undefined) break;
      active = contender;
      const outcome = yield* o.run(contender, o.control.begin(contender.name));
      outcomes.push(outcome);
      active = undefined;
      yield* o.persist(currentOutcome(false));
      if (o.control.globalAbort() !== undefined) break;
    }
    const result = currentOutcome(true);
    yield* o.persist(result);
    return result;
  }).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : o.control.abortUnexpected(active?.name).pipe(
            Effect.andThen(Effect.suspend(() => o.persist(currentOutcome(false)))),
            Effect.asVoid,
          ),
    ),
  );
};
