// A scope-local policy at the actual engine boundary. Production explicitly allows requests and
// continues ordinary failover; bounded tools can close one scope without changing production DTOs.
import { Context, Data, Effect } from "effect";
import type { EngineError } from "./errors.ts";

export class RequestNotAdmitted extends Data.TaggedError("RequestNotAdmitted")<{
  readonly reason: "closed" | "global-abort" | "max-authorized-requests";
}> {}

export type EngineFailureMetadata = {
  readonly coord: { readonly l: number; readonly i: number };
  readonly ref: string;
  readonly error: EngineError;
};

export type EngineFailureDirective = "continue" | "stop";

export type EngineExecutionPolicyService = {
  readonly authorize: () => Effect.Effect<void, RequestNotAdmitted>;
  readonly onFailure: (failure: EngineFailureMetadata) => Effect.Effect<EngineFailureDirective>;
};

const allowAndContinue: EngineExecutionPolicyService = {
  authorize: () => Effect.void,
  onFailure: () => Effect.succeed("continue"),
};

export const EngineExecutionPolicy = Context.Reference<EngineExecutionPolicyService>("optchat/EngineExecutionPolicy", {
  defaultValue: () => allowAndContinue,
});

// Compatibility name for callers that provide the policy. There is still only one service.
export const RequestAdmission = EngineExecutionPolicy;
export type RequestAdmissionService = EngineExecutionPolicyService;

export const admitRequest = (): Effect.Effect<void> =>
  Effect.flatMap(EngineExecutionPolicy, (policy) => policy.authorize()).pipe(
    Effect.catchTag("RequestNotAdmitted", () => Effect.interrupt),
  );

export const directEngineFailure = (failure: EngineFailureMetadata): Effect.Effect<EngineFailureDirective> =>
  Effect.flatMap(EngineExecutionPolicy, (policy) => policy.onFailure(failure));
