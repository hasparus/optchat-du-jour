# Typed failures and bounded retry (Effect 4.0.4)

Read [LLMS.md](../repos/effect/LLMS.md). Follow
[catchTags](../repos/effect/ai-docs/src/01_effect/04_errors/10_catch-tags.ts),
[retry example and idempotency cautions](../repos/effect/ai-docs/src/52_graphql/50_errors-and-retries.ts),
[Effect.retry / Retry.Options](../repos/effect/packages/effect/src/Effect.ts),
[retry implementation](../repos/effect/packages/effect/src/internal/schedule.ts), and
[tests: “retry”](../repos/effect/packages/effect/test/Effect.test.ts).

- Model expected failures with `Schema.TaggedError` and concrete fields. Use `return yield*`
  when failing inside generators. At foreign APIs, map failures with `Effect.try` / `tryPromise`;
  keep causes without leaking secrets. `Effect.sync` is not a typed-error wrapper for throws.
- Recover selectively with `Effect.catchTag` / `catchTags`; do not erase errors into a successful
  empty result unless that fallback is the domain contract. Defects and interruptions are not
  ordinary retryable failures. Avoid unknown/any in error and requirements channels.
- Retry reruns the whole effect. Restrict it to replay-safe operations, classify the typed error,
  bound attempts and delay with a Schedule. `times: 2` permits two retries after the initial
  attempt. Honor server retry hints when applicable. Defects and interruptions are not retried;
  the tests also reject typed failures combined with finalizer defects.

Adapted bounded read-only retry shape:

```ts
import { Effect, Schedule, Schema } from "effect";

class ReadError extends Schema.TaggedError<ReadError>()("ReadError", {
  transient: Schema.Boolean,
}) {}
declare const read: Effect.Effect<string, ReadError>;
const result = read.pipe(Effect.retry({
  times: 2,
  schedule: Schedule.exponential("100 millis"),
  while: (error) => error.transient,
}));
```

Optchat turns, captions, tool execution and appends are side-effectful, potentially billable
operations. Do not retry the whole turn or duplicate it on provider failover. Keep the existing
compactor retry-at-next-message contract ([chat.ts](../src/chat.ts), [compactor.ts](../src/compactor.ts)).
Preserve known spend even if later parsing, persistence or cancellation fails. A failed usage
write must not trigger another model call ([usage.ts](../src/usage.ts)). Test replay boundaries
and error mapping with fake providers; diagnostics alone cannot establish idempotency.
