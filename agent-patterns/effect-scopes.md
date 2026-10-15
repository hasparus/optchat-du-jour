# Scopes and cancellation (Effect 4.0.4)

Read [LLMS.md](../repos/effect/LLMS.md) first. Source anchors:
[acquire-release example](../repos/effect/ai-docs/src/01_effect/05_resources/10_acquire-release.ts),
[implementation: scoped / acquireRelease](../repos/effect/packages/effect/src/internal/effect.ts),
[public contracts: acquireRelease / forkScoped / tryPromise](../repos/effect/packages/effect/src/Effect.ts),
and [tests: “acquireRelease”, “forkScoped”, “finalization”](../repos/effect/packages/effect/test/Effect.test.ts).

- Acquire a resource with `Effect.acquireRelease(acquire, release)` and use it within the owning
  scope. `Effect.scoped` closes that scope on every exit. Do not scope acquisition alone and
  return a handle whose finalizer has already run.
- Acquisition is uninterruptible by default so registration cannot be interrupted after success.
  Check the `interruptible` option and acquisition behavior before changing cancellation policy.
  Release receives the resource and exit; its typed error channel is `never`. A thrown cleanup
  defect can combine with the original failure, as the finalization tests demonstrate.
- Use `Effect.forkScoped` for work owned by a scope; it is interrupted when the scope closes.
  Use an explicit existing scope with `Effect.forkIn(scope)` when work must outlive a caller.
  Detached fibers need an explicit lifecycle design, not just a quieter linter.
- `Effect.tryPromise` can pass an AbortSignal to a Promise API. Forward it to APIs that support
  abort; interruption is not proof that an external operation stopped or rolled back.

Adapted resource shape (declarations stand for the application's typed adapters):

```ts
import { Effect } from "effect";

declare const acquire: Effect.Effect<{ read(): string; close(): void }>;
const use = Effect.gen(function* () {
  const resource = yield* Effect.acquireRelease(acquire, (r) => Effect.sync(() => r.close()));
  return yield* Effect.sync(() => resource.read());
}).pipe(Effect.scoped);
```

In optchat, [openChat](../src/chat.ts) owns the writer lock and pump; [lock](../src/store.ts)
uses acquireRelease. Keep their lifetimes aligned. [makePersist](../src/persist.ts) forks pushes
in its captured scope. Cancellation must preserve persisted messages and already known usage;
never assume stopping a fiber reverses a model call, filesystem append or remote operation.
Test finalizers, interruption and concurrent writers with fakes, not private history.
