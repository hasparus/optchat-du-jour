// A streamed model reply, read event by event (SPEC "Engines"): both the Responses API and
// Anthropic's Messages API stream server-sent events whose data is one JSON object with a `type`.
// The engine folds them into its reply and the stream ends where it says it is done: whatever
// follows (a `data: [DONE]` line, say) is never read. A stream that breaks is a ModelError named
// after it.
import { Effect, Option, Predicate, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { type EngineError, ModelError } from "./errors.ts";

export const sseFold = <S, E>(
  label: string,
  stream: Stream.Stream<Uint8Array, EngineError>,
  init: S,
  step: (state: S, data: string) => Effect.Effect<S, E | EngineError | Schema.SchemaError>,
  done: (state: S) => boolean,
  started: Effect.Effect<void> = Effect.void, // run once, at the first event: the response has started
): Effect.Effect<S, E | EngineError> => {
  let first = true;
  return stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decode()),
    Stream.tap(() => (first ? ((first = false), started) : Effect.void)),
    Stream.scanEffect(
      () => init,
      (acc, event) => (event.data === "[DONE]" ? Effect.succeed(acc) : step(acc, event.data)),
    ),
    Stream.takeUntil(done),
    Stream.runLast,
    Effect.map(Option.getOrElse(() => init)),
    Effect.mapError((e) => {
      if (Predicate.isTagged(e, "Retry")) return new ModelError({ message: `${label}: the stream asked to reconnect` });
      if (e instanceof Schema.SchemaError) return new ModelError({ message: `${label}: unexpected stream event: ${e.message}` });
      if (e instanceof Sse.SseError) return new ModelError({ message: `${label}: ${e.message}` });
      return e;
    }),
  );
};

// the JSON of one event's data, decoded with `schema`
export const json = <S extends Schema.Top>(schema: S) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
export const typeOf = json(Schema.Struct({ type: Schema.String }));
