// A streamed model reply, read event by event (SPEC "Engines"): both the Responses API and
// Anthropic's Messages API stream server-sent events whose data is one JSON object with a `type`.
// The engine folds them into its reply and the stream ends where it says it is done: whatever
// follows (a `data: [DONE]` line, say) is never read. A stream that breaks is a ModelError named
// after it.
import { Effect, Option, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { type EngineError, ModelError } from "./errors.ts";

export const sseFold = <S>(
  label: string,
  stream: Stream.Stream<Uint8Array, EngineError>,
  init: S,
  step: (state: S, data: string) => Effect.Effect<S, EngineError | Schema.SchemaError>,
  done: (state: S) => boolean,
) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.scanEffect(
      () => init,
      (acc, event) => (event.data === "[DONE]" ? Effect.succeed(acc) : step(acc, event.data)),
    ),
    Stream.takeUntil(done),
    Stream.runLast,
    Effect.map(Option.getOrElse(() => init)),
    Effect.catchTags({
      Retry: () => Effect.fail(new ModelError({ message: `${label}: the stream asked to reconnect` })),
      SchemaError: (e) => Effect.fail(new ModelError({ message: `${label}: unexpected stream event: ${e.message}` })),
      SseError: (e) => Effect.fail(new ModelError({ message: `${label}: ${e.message}` })),
    }),
  );

// the JSON of one event's data, decoded with `schema`
export const json = <S extends Schema.Top>(schema: S) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
export const typeOf = json(Schema.Struct({ type: Schema.String }));
