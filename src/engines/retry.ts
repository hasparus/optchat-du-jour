// One request of our own HTTP engines (api-key, openai-plan) sent again when it failed on the
// vendor's side (E33), after UniiChat's Agent.step (docs/uniichat.md). Whether a failure will pass
// is decided where it is classified, and carried on the error (`transient`, `retryAfter`,
// ./errors.ts): a 408, 409, 429 or 5xx (529 too) unless the server says `x-should-retry: false`,
// any status it says `x-should-retry: true` for, a connection that broke, an overload or server
// error event in the stream, a stream that ended early or went quiet. Such a request is sent
// again up to `tries` in all, after the server's `retry-after` or a doubling pause with jitter. A
// limit that is no hiccup (a spent plan, a key out of credit, a `retry-after` longer than
// `longest`), a refusal and the API's own errors go to the failover chain at once.
//
// Only a request nothing of which reached the caller is sent again: once a text delta, a thought
// or an item went out (to the log, to clients), a second answer would show twice. askAgain sees
// that through the hooks it hands each try. What a failed try cost is never lost: it is added to
// the reply that gets through, or to the failure that ends the call, whatever ends it, so
// usage.jsonl and the budget count every request. Claude Code (the claude-code engine) has its own.
import { Context, Duration, Effect, Random, Result, Stream } from "effect";
import { type HttpClient, HttpClientError, type HttpClientRequest } from "effect/http";
import { HTTP_RETRY_BASE, HTTP_RETRY_LONGEST, HTTP_TRIES } from "../config.ts";
import { addSpent, type EngineError, isEngineError, ModelError, passing, type Spent, type Tagged, withSpent } from "./errors.ts";

export type RetryPolicy = {
  readonly tries: number; // in all, the first included
  readonly base: Duration.Input; // the first pause; it doubles, ±20%
  readonly longest: Duration.Input; // a `retry-after` past this is a limit, not a hiccup
};
// HTTP_TRIES, HTTP_RETRY_BASE, HTTP_RETRY_LONGEST; tests make the pauses short
export const EngineRetry = Context.Reference<RetryPolicy>("optchat/EngineRetry", {
  defaultValue: () => ({ base: HTTP_RETRY_BASE, longest: HTTP_RETRY_LONGEST, tries: HTTP_TRIES }),
});

// a response's headers, by lowercase name, as the HTTP client keeps them
type Headers = Readonly<Record<string, string | undefined>>;
// what of an HTTP response the engines read: its status and headers, and its body as text or bytes
type Answer<E> = {
  readonly status: number;
  readonly headers: Headers;
  readonly text: Effect.Effect<string, E>;
  readonly stream: Stream.Stream<Uint8Array, E>;
};

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

// What one engine's requests are: `label` names it in errors; `idle` (IDLE_ANTHROPIC,
// IDLE_OPENAI) is how long a response may say nothing, its headers included, before it is dead:
// a stream still open but silent would otherwise hold a turn (our tool loop has no timeout of its
// own) until the user stops it.
export type Wire = { readonly label: string; readonly idle: Duration.Input };

const broken = (w: Wire, why: string) => new ModelError({ message: `${w.label}: ${why}`, transient: true });
const quiet = (w: Wire) => broken(w, `no word from the API in ${Duration.format(Duration.fromInputUnsafe(w.idle))}`);

// the request sent: its response once the headers came; a connection that broke, or no headers in
// `idle`, is a failure that may pass
export const post = (http: HttpClient.HttpClient, request: HttpClientRequest.HttpClientRequest, w: Wire) =>
  http.execute(request).pipe(
    Effect.timeoutOrElse({ duration: w.idle, orElse: () => Effect.fail(quiet(w)) }),
    Effect.catchIf(HttpClientError.isHttpClientError, (err) => Effect.fail(broken(w, err.message))),
  );

// the body of an answer that isn't a 200, for the engine to classify; one that breaks on the way may pass
export const errorBody = <E extends { readonly message: string }>(res: Answer<E>, w: Wire): Effect.Effect<string, ModelError> =>
  res.text.pipe(Effect.mapError((err) => broken(w, err.message)));

// The engine's failure for an HTTP error, marked as one that may pass when the status or
// `x-should-retry` says so, unless the engine knows it for a limit that won't (`lasting`: a spent
// plan, a key out of credit)
export const httpFailure = <E>(res: Answer<E>, error: EngineError, lasting: boolean): EngineError =>
  busyStatus(res.status, res.headers) && !lasting ? passing(error, waitOf(res.headers, Date.now())) : error;

// a 200's bytes: a read that breaks, or no bytes for `idle`, is a failure that may pass
export const bytes = <E extends { readonly message: string }>(res: Answer<E>, w: Wire): Stream.Stream<Uint8Array, ModelError> =>
  res.stream.pipe(
    Stream.mapError((err) => broken(w, err.message)),
    Stream.timeoutOrElse({ duration: w.idle, orElse: () => Stream.fail(quiet(w)) }),
  );

// what a try is handed: `f`, telling askAgain that this try showed something whenever it is called
// (a hook that sends text, thinking or an item on)
export type Shown = <A extends readonly unknown[], R>(f: ((...args: A) => R) | undefined) => ((...args: A) => R) | undefined;

// What earlier tries cost, kept across two askAgain of one call (openai-plan's, around a token
// renewed after a 401): the second one starts from it.
export type Carry = { before: Spent | undefined };

// The request (`once`, one try, its hooks wrapped by `shown`) until it succeeds, fails with what
// won't pass, has shown something, or has had its tries; then that failure is the call's. Earlier
// tries' cost is merged into the reply (`merge`) or added to the failure, on every way out but a
// failure that isn't an engine's (a 401 to renew, a log that refused): that one leaves it in `carry`.
export const askAgain = <A, E extends Tagged>(o: {
  readonly once: (shown: Shown) => Effect.Effect<A, E>;
  readonly merge: (reply: A, before: Spent) => A;
  readonly carry?: Carry;
}): Effect.Effect<A, E | EngineError> =>
  Effect.gen(function* () {
    const policy = yield* EngineRetry;
    const longest = Duration.toMillis(Duration.fromInputUnsafe(policy.longest));
    const base = Duration.toMillis(Duration.fromInputUnsafe(policy.base));
    const carry: Carry = o.carry ?? { before: undefined };
    const taken = () => {
      const { before } = carry;
      carry.before = undefined;
      return before;
    };
    for (let k = 1; ; k++) {
      const tried = { shown: false };
      const shown: Shown = (f) =>
        f &&
        ((...args) => {
          tried.shown = true;
          return f(...args);
        });
      const out = yield* Effect.result(o.once(shown));
      if (Result.isSuccess(out)) {
        const before = taken();
        return before === undefined ? out.success : o.merge(out.success, before);
      }
      const e = out.failure;
      if (!isEngineError(e)) return yield* Effect.fail(e);
      if (e._tag === "DeviceOffline" || e.transient !== true || tried.shown || k >= policy.tries) return yield* Effect.fail(withSpent(e, taken()));
      const pause = e.retryAfter ?? base * 2 ** (k - 1) * (0.8 + 0.4 * (yield* Random.next));
      if (pause > longest) return yield* Effect.fail(withSpent(e, taken()));
      if (e.spent !== undefined) carry.before = carry.before === undefined ? e.spent : addSpent(carry.before, e.spent);
      yield* Effect.sleep(Duration.millis(pause));
    }
  });
