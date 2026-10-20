// A test clock for runs that are long in time and short in work: the cache replay's days of chat.
// Effect's TestClock moves on as soon as the fibers it wakes yield once; a woken compaction that
// needs a dozen steps before its next sleep would find the clock already past it. This one moves
// time only when every fiber is waiting: on a sleep it knows, or on another fiber. Everything the
// replay runs is in this process and synchronous between waits (the store writes with sync fs
// calls, the fake vendors answer in memory), so "every fiber is waiting" is "Effect's scheduler
// has had nothing to run for two turns of the event loop".
//
// `advanceTo(t)` wakes the sleepers in time order, letting each wake's work settle before the
// next, then stops at t. `run` awaits an effect and moves time for as long as it waits on a sleep.
//
// Its limits: work takes no simulated time, and a response begins exactly when its sleep ends, so
// each race plays out in one interleaving (the order sleeps were made in) and a timeout racing a
// slow response is never tried. And anything that waits outside Effect's scheduler (an async fs
// call, a socket, a subprocess) would let `settle` call the run quiet too early: that shows as
// numbers that differ between runs, not as a failure, which is why `dev/cache-replay.ts --test`
// runs the replay twice and compares.
import { Clock, Duration, Effect, Scheduler } from "effect";

type Sleeper = { readonly at: number; readonly seq: number; readonly wake: () => void };

// one turn of the event loop
const turn = async () =>
  new Promise<void>((done) => {
    setImmediate(done);
  });
const earlier = (a: Sleeper, b: Sleeper) => a.at - b.at || a.seq - b.seq;

export const makeSimClock = (start: number) => {
  let now = start, seq = 0;
  let sleepers: Sleeper[] = [];
  // the scheduler's work: tasks waiting for their turn, and how many turns ran
  let pending = 0, ran = 0;
  const setImmediateFn = (f: () => void) => {
    pending++;
    let cancelled = false;
    const handle = setImmediate(() => {
      pending--;
      if (cancelled) return;
      ran++;
      f();
    });
    return () => {
      if (cancelled) return;
      cancelled = true;
      clearImmediate(handle);
      pending--;
    };
  };
  const scheduler = new Scheduler.MixedScheduler("async", setImmediateFn);

  const nanos = () => BigInt(now) * 1_000_000n;
  const clock: Clock.Clock = {
    currentTimeMillis: Effect.sync(() => now),
    currentTimeMillisUnsafe: () => now,
    currentTimeNanos: Effect.sync(nanos),
    currentTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    sleep: (d: Duration.Duration) =>
      Effect.suspend(() => {
        const ms = Duration.toMillis(d);
        if (ms <= 0) return Effect.void;
        return Effect.callback<undefined>((resume) => {
          const sleeper: Sleeper = {
            at: now + ms,
            seq: seq++,
            wake: () => {
              resume(Effect.undefined);
            },
          };
          sleepers.push(sleeper);
          return Effect.sync(() => {
            sleepers = sleepers.filter((s) => s !== sleeper);
          });
        }).pipe(Effect.asVoid);
      }),
  };

  // until Effect's scheduler stays empty for two turns of the event loop
  const settle = async () => {
    let quiet = 0;
    while (quiet < 2) {
      const before = ran;
      await turn();
      quiet = pending === 0 && ran === before ? quiet + 1 : 0;
    }
  };

  const advanceTo = async (t: number) => {
    for (;;) {
      await settle();
      const next = sleepers.toSorted(earlier)[0];
      if (next === undefined || next.at > t) break;
      now = Math.max(now, next.at);
      const due = sleepers.filter((s) => s.at <= now).toSorted(earlier);
      sleepers = sleepers.filter((s) => s.at > now);
      for (const s of due) s.wake();
    }
    now = Math.max(now, t);
    await settle();
  };

  // An effect run on this clock and scheduler, which every fiber it forks inherits, awaited: while
  // it waits on a sleep, time moves to that sleep, so an effect that sleeps never hangs the run
  const run = async <A, E>(effect: Effect.Effect<A, E>) => {
    const state = { done: false };
    const result = Effect.runPromise(Effect.provideService(effect, Clock.Clock, clock), { scheduler }).finally(() => {
      state.done = true;
    });
    const ended = result.then(
      () => null,
      () => null,
    );
    for (;;) {
      await settle();
      if (state.done) return result;
      const next = sleepers.toSorted(earlier)[0];
      await (next === undefined ? Promise.race([ended, turn()]) : advanceTo(next.at));
    }
  };
  const fork = <A, E>(effect: Effect.Effect<A, E>) => Effect.runFork(Effect.provideService(effect, Clock.Clock, clock), { scheduler });
  return { advanceTo, fork, now: () => now, run, settle };
};
export type SimClock = ReturnType<typeof makeSimClock>;
