// Warm `claude` processes (SPEC "Turn and priming", E18): a Runner that keeps one process started
// ahead, idle on stdin, for each spawn it was told to expect, so a turn skips claude's boot
// (~1.3 s). Only a byte-identical spawn (args, env, cwd) gets it; any other starts fresh.
//
// Each expected spawn has a keeper fiber: it starts a process, puts it in that spawn's slot, and
// waits until a caller takes it, it dies, or it grows too old; then it starts the next one, after
// a pause if it died. Closing the pool (server shutdown) stops the keepers and kills every process
// started through it.
import { Deferred, type Duration, Effect, Exit, FiberMap, Layer, Scope } from "effect";
import { WARM_MAX_AGE, WARM_RETRY, WARM_TRIES } from "../config.ts";
import { type Claude, LocalRunner, Runner, type Spawn } from "./process.ts";

// the most spawns a pool keeps warm: the master's turn and its priming, on one device
const KEYS = 2;

export const spawnKey = (o: Spawn) => JSON.stringify([o.args, Object.entries(o.env).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), o.cwd ?? null]);

// a process in its slot; `taken` resolves when a caller takes it, and from then on it is the caller's
type Warm = { readonly claude: Claude; readonly scope: Scope.Closeable; readonly taken: Deferred.Deferred<true> };

export type WarmOptions = { readonly maxAge?: Duration.Input; readonly retry?: Duration.Input; readonly tries?: number };

export const warmRunner = (base: Runner["Service"], o: WarmOptions = {}): Effect.Effect<Runner["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const maxAge = o.maxAge ?? WARM_MAX_AGE, retry = o.retry ?? WARM_RETRY, tries = o.tries ?? WARM_TRIES;
    // every process's scope is a child of this one; the keepers, made after it, stop before it closes
    const processes = yield* Scope.fork(yield* Effect.scope, "parallel");
    const keepers = yield* FiberMap.make<string>();
    const slots = new Map<string, Warm>();
    let wanted = new Map<string, Spawn>(); // what the last `warm` named

    // One process for `key`, from its start until it is taken, dies or is too old. Its scope is not
    // the keeper's: a taken process lives on with its caller, and one never taken is killed in the
    // background however the wait ended (a process slow to go holds up nobody).
    const once = (key: string, spec: Spawn) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const scope = yield* Scope.fork(processes);
          const taken = yield* Deferred.make<true>();
          const wait = Effect.gen(function* () {
            const claude = yield* base.spawn(spec).pipe(Scope.provide(scope));
            slots.set(key, { claude, scope, taken });
            const why = yield* Effect.raceAll([
              Effect.as(Deferred.await(taken), "taken" as const),
              Effect.as(claude.ended, "died" as const),
              Effect.as(Effect.sleep(maxAge), "old" as const),
            ]);
            return Deferred.isDoneUnsafe(taken) ? ("taken" as const) : why; // taken, then ended with its caller
          });
          const leave = Effect.suspend(() => {
            if (slots.get(key)?.taken === taken) slots.delete(key);
            return Deferred.isDoneUnsafe(taken) ? Effect.void : Effect.forkIn(Scope.close(scope, Exit.void), processes);
          });
          return yield* restore(wait).pipe(
            Effect.orElseSucceed(() => "died" as const), // a process that won't start dies too
            Effect.ensuring(leave),
          );
        }),
      );

    // A taken or old process is replaced at once; one that died, after `retry`, and only `tries`
    // times in a row: a broken claude would otherwise restart forever.
    const keep = (key: string, spec: Spawn) =>
      Effect.gen(function* () {
        let deaths = 0;
        for (;;) {
          const why = yield* once(key, spec);
          if (why === "died") {
            deaths += 1;
            if (deaths > tries) return;
            yield* Effect.sleep(retry);
          } else deaths = 0;
        }
      });
    const keepWarm = (key: string) =>
      Effect.suspend(() => {
        const spec = wanted.get(key);
        return spec ? Effect.asVoid(FiberMap.run(keepers, key, keep(key, spec), { onlyIfMissing: true })) : Effect.void;
      });

    // the warm process for `key`, out of its slot in one step; none if it ended (its keeper replaces it)
    const take = (key: string) =>
      Effect.sync(() => {
        const w = slots.get(key);
        if (!w || w.claude.hasEnded()) return null;
        slots.delete(key);
        Deferred.doneUnsafe(w.taken, Effect.succeed(true));
        return w;
      });

    // The warm process for this exact spawn, now the caller's: taking it and tying it to the
    // caller's scope are one uninterruptible step, so an interrupted caller can't orphan it. Else
    // a fresh one, and if its keeper had given up, a new keeper: claude starts again.
    const spawn: Runner["Service"]["spawn"] = (spec) =>
      Effect.gen(function* () {
        const key = spawnKey(spec);
        const w = yield* Effect.acquireRelease(take(key), (taken) => (taken ? Scope.close(taken.scope, Exit.void) : Effect.void));
        if (w) return w.claude;
        const claude = yield* base.spawn(spec);
        yield* keepWarm(key);
        return claude;
      });

    // keep these warm from now on, and only these
    const warm = (expected: readonly Spawn[]) =>
      Effect.gen(function* () {
        wanted = new Map(expected.slice(0, KEYS).map((s) => [spawnKey(s), s]));
        const stale = [...keepers].flatMap(([key]) => (wanted.has(key) ? [] : [key]));
        for (const key of stale) yield* FiberMap.remove(keepers, key);
        for (const key of wanted.keys()) yield* keepWarm(key);
      });

    return { spawn, warm };
  });

// `claude` on this machine, with the pool in front; the layer's scope is the pool's
export const WarmLocalRunner = Layer.effect(
  Runner,
  Effect.gen(function* () {
    return yield* warmRunner(yield* Runner);
  }),
).pipe(Layer.provide(LocalRunner));
