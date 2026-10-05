// Warm `claude` processes (SPEC "Turn and priming", E18): a Runner that keeps one process started
// ahead, idle on stdin, for each spawn it was told to expect, so a turn skips claude's boot
// (~1.3 s). Only a byte-identical spawn (args, env, cwd) gets it; any other starts fresh. Every
// process lives in a scope under the pool's own, so closing the pool (server shutdown) kills it.
import { type Duration, Effect, Exit, Fiber, Layer, Scope } from "effect";
import { WARM_MAX_AGE, WARM_RETRY, WARM_TRIES } from "../config.ts";
import { type Claude, LocalRunner, Runner, type Spawn } from "./process.ts";

// the most spawns a pool keeps warm: the master's turn and its priming, on one device
const KEYS = 2;

export const spawnKey = (o: Spawn) => JSON.stringify([o.args, Object.entries(o.env).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)), o.cwd ?? null]);

type Warm = { readonly claude: Claude; readonly scope: Scope.Closeable; watcher: Fiber.Fiber<void> | null };

export type WarmOptions = { readonly maxAge?: Duration.Input; readonly retry?: Duration.Input; readonly tries?: number };

export const warmRunner = (base: Runner["Service"], o: WarmOptions = {}): Effect.Effect<Runner["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const pool = yield* Effect.scope;
    const maxAge = o.maxAge ?? WARM_MAX_AGE, retry = o.retry ?? WARM_RETRY, tries = o.tries ?? WARM_TRIES;
    const wanted = new Map<string, Spawn>(); // what the last `warm` named
    const ready = new Map<string, Warm>(); // at most one per key
    const starting = new Set<string>();
    const deaths = new Map<string, number>(); // idle deaths in a row, per key

    // kills it in the background: a process slow to go must not hold up the caller
    const retire = (w: Warm) => Effect.forkIn(Scope.close(w.scope, Exit.void), pool).pipe(Effect.asVoid);

    // out of the pool: it was handed out, replaced, or is not wanted any more
    const take = (key: string) =>
      Effect.suspend(() => {
        const w = ready.get(key);
        if (!w) return Effect.succeed(null);
        ready.delete(key);
        return (w.watcher ? Fiber.interrupt(w.watcher) : Effect.void).pipe(Effect.as(w));
      });

    // a process dying while idle is replaced after `retry`, `tries` times in a row at most (a
    // broken claude would otherwise restart forever); one older than `maxAge` is replaced at once
    const watch = (key: string, w: Warm) =>
      Effect.raceFirst(Effect.as(w.claude.ended, "died" as const), Effect.as(Effect.sleep(maxAge), "old" as const)).pipe(
        Effect.flatMap((why) =>
          Effect.gen(function* () {
            if (ready.get(key) !== w) return;
            ready.delete(key);
            yield* retire(w);
            if (why === "old") return yield* fill(key);
            const n = (deaths.get(key) ?? 0) + 1;
            deaths.set(key, n);
            if (n > tries) return;
            yield* Effect.sleep(retry);
            yield* fill(key);
          }),
        ),
      );

    // start the process for `key` in the background, unless one is ready or on its way
    const fill = (key: string): Effect.Effect<void> =>
      Effect.suspend(() => {
        const spec = wanted.get(key);
        if (!spec || ready.has(key) || starting.has(key)) return Effect.void;
        starting.add(key);
        return Effect.gen(function* () {
          const scope = yield* Scope.fork(pool);
          const spawned = yield* Effect.result(base.spawn(spec).pipe(Scope.provide(scope)));
          starting.delete(key);
          if (spawned._tag === "Failure" || !wanted.has(key) || ready.has(key)) {
            yield* Scope.close(scope, Exit.void);
            if (spawned._tag === "Failure") deaths.set(key, (deaths.get(key) ?? 0) + 1);
            return;
          }
          const w: Warm = { claude: spawned.success, scope, watcher: null };
          ready.set(key, w);
          w.watcher = yield* Effect.forkIn(watch(key, w), pool);
        }).pipe(
          Effect.ensuring(Effect.sync(() => starting.delete(key))),
          Effect.forkIn(pool),
          Effect.asVoid,
        );
      });

    // the warm process for this exact spawn, now the caller's (its scope's end kills it), and its
    // replacement started; else a fresh one
    const spawn: Runner["Service"]["spawn"] = (spec) =>
      Effect.gen(function* () {
        const key = spawnKey(spec);
        const w = yield* take(key);
        if (w) {
          deaths.delete(key);
          yield* Effect.addFinalizer(() => Scope.close(w.scope, Exit.void));
          yield* fill(key);
          return w.claude;
        }
        const claude = yield* base.spawn(spec);
        deaths.delete(key); // it starts again: worth keeping one warm again
        yield* fill(key);
        return claude;
      });

    // keep these warm from now on, and only these
    const warm = (expected: readonly Spawn[]) =>
      Effect.gen(function* () {
        wanted.clear();
        for (const s of expected.slice(0, KEYS)) wanted.set(spawnKey(s), s);
        for (const key of ready.keys()) {
          if (wanted.has(key)) continue;
          const stale = yield* take(key);
          if (stale) yield* retire(stale);
        }
        for (const key of wanted.keys()) yield* fill(key);
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
