// One request of our own HTTP engines (api-key, openai-plan) asked again when it failed on the
// vendor's side (E33), after UniiChat's Agent.step (docs/uniichat.md): a 408, 409, 429 or 5xx (529
// too) unless the server says `x-should-retry: false`, any status it says `x-should-retry: true`
// for, a connection that broke, and a stream that went quiet or broke before it was done. It is
// sent again up to `tries` in all, after the server's `retry-after` or a doubling pause with
// jitter. A limit that is no hiccup (a spent plan, a key out of credit, a `retry-after` longer
// than `longest`) goes to the failover chain at once, as do refusals and the API's own errors.
//
// Only a request nothing of which reached the caller is asked again: once a text delta, a thought
// or an item went out (to the log, to clients), a second answer would show twice. What a failed
// attempt cost is not lost: it is added to the spend of the attempt after it, so usage.jsonl and
// the budget count every request. Claude Code (the claude-code engine) has its own retries.
import { Context, Data, Duration, Effect, Random, Result, Stream } from "effect";
import { HTTP_RETRY_BASE, HTTP_RETRY_LONGEST, HTTP_TRIES } from "../config.ts";
import { addSpent, type EngineError, type ModelError, type Spent, withSpent } from "./errors.ts";

export type RetryPolicy = {
  readonly tries: number; // in all, the first included
  readonly base: Duration.Input; // the first pause; it doubles, ±20%
  readonly longest: Duration.Input; // a `retry-after` past this is a limit, not a hiccup
};
// HTTP_TRIES, HTTP_RETRY_BASE, HTTP_RETRY_LONGEST; tests make the pauses short
export const EngineRetry = Context.Reference<RetryPolicy>("optchat/EngineRetry", {
  defaultValue: () => ({ base: HTTP_RETRY_BASE, longest: HTTP_RETRY_LONGEST, tries: HTTP_TRIES }),
});

// An attempt that failed on the vendor's side: the failure it is if no attempt after it gets
// through, and how long the server asked us to wait (null: it didn't say).
export class Busy extends Data.TaggedError("Busy")<{ readonly error: EngineError; readonly wait: number | null }> {}

// a response's headers, by lowercase name, as the HTTP client keeps them
type Headers = Readonly<Record<string, string | undefined>>;

// whether an HTTP error says to ask again: `x-should-retry` when the server sends it (Anthropic and
// OpenAI do), else a timeout, a conflict, a rate limit or the server's own failure
export const busyStatus = (status: number, headers: Headers): boolean => {
  const should = headers["x-should-retry"];
  if (should === "true") return true;
  if (should === "false") return false;
  return status === 408 || status === 409 || status === 429 || status >= 500;
};

// how long the server asked us to wait, in ms: `retry-after-ms`, else `retry-after` in seconds or
// as an HTTP date; null when it says nothing we can read
export const waitOf = (headers: Headers, now: number): number | null => {
  const ms = Number(headers["retry-after-ms"] ?? Number.NaN);
  if (Number.isFinite(ms) && ms >= 0) return ms;
  const after = headers["retry-after"];
  if (after === undefined) return null;
  const seconds = Number(after);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(after);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
};

// One attempt as it goes: whether any of it went out to the caller (`shown`), after which it is
// never asked again, and whether it broke on the vendor's side (`busy`: the connection, the
// stream, an overload or server error event in it).
export type Attempt = { shown: boolean; busy: boolean };
export const attempt = (): Attempt => ({ busy: false, shown: false });

// `f`, marking the attempt shown whenever it is called (a hook that sends text, thinking or an item on)
export const showing = <A extends readonly unknown[], R>(at: Attempt, f: ((...args: A) => R) | undefined): ((...args: A) => R) | undefined =>
  f &&
  ((...args: A) => {
    at.shown = true;
    return f(...args);
  });

// A response's bytes, failed with `quiet()` once none came for `idle` (IDLE_ANTHROPIC,
// IDLE_OPENAI): a stream that is still open but says nothing is dead, and would otherwise hold a
// turn (our tool loop has no timeout of its own) until the user stops it.
export const idleCut = <E>(stream: Stream.Stream<Uint8Array, E>, idle: Duration.Input, quiet: () => ModelError): Stream.Stream<Uint8Array, E | ModelError> =>
  stream.pipe(Stream.timeoutOrElse({ duration: idle, orElse: () => Stream.fail(quiet()) }));

// The request (`once`, one attempt) until it succeeds, fails otherwise than Busy, or has had its
// tries: then the last Busy is the failure it carries. `merge` adds what failed attempts cost to
// the reply that got through.
export const askAgain = <A, E>(once: Effect.Effect<A, E | Busy>, merge: (reply: A, before: Spent) => A): Effect.Effect<A, E | EngineError> =>
  Effect.gen(function* () {
    const policy = yield* EngineRetry;
    const longest = Duration.toMillis(Duration.fromInputUnsafe(policy.longest));
    const base = Duration.toMillis(Duration.fromInputUnsafe(policy.base));
    let before: Spent | undefined;
    for (let k = 1; ; k++) {
      const out = yield* Effect.result(once);
      if (Result.isSuccess(out)) return before === undefined ? out.success : merge(out.success, before);
      const e = out.failure;
      if (!(e instanceof Busy)) return yield* Effect.fail(e);
      const spent = e.error._tag === "DeviceOffline" ? undefined : e.error.spent;
      const pause = e.wait ?? base * 2 ** (k - 1) * (0.8 + 0.4 * (yield* Random.next));
      if (k >= policy.tries || pause > longest) return yield* Effect.fail(withSpent(e.error, before));
      if (spent !== undefined) before = before === undefined ? spent : addSpent(before, spent);
      yield* Effect.sleep(Duration.millis(pause));
    }
  });
