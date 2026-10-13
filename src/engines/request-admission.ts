// Production uses the no-op default. Tools such as the bake-off may provide a bounded service
import { Context, Data, Effect } from "effect";

export type RequestTransport = "anthropic-messages" | "claude" | "openai-responses";
export type RequestMetadata = { readonly transport: RequestTransport; readonly model: string };

export class RequestNotAdmitted extends Data.TaggedError("RequestNotAdmitted")<{
  readonly reason: "max-authorized-requests";
}> {}

export type RequestAdmissionService = {
  readonly authorize: (metadata: RequestMetadata) => Effect.Effect<void, RequestNotAdmitted>;
};

export const RequestAdmission = Context.Reference<RequestAdmissionService>("optchat/RequestAdmission", {
  defaultValue: () => ({ authorize: () => Effect.void }),
});

export const admitRequest = (metadata: RequestMetadata): Effect.Effect<void> =>
  Effect.flatMap(RequestAdmission, (admission) => admission.authorize(metadata)).pipe(
    Effect.catchTag("RequestNotAdmitted", () => Effect.interrupt),
  );
