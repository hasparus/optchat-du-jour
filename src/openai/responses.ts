// The Responses API on the ChatGPT plan (SPEC "Engines", openai-plan): one streamed request per
// call, `stream: true` and `store: false` as plan usage requires, nothing carried server-side
// between calls. The route rejects `system` messages, so the system prompt goes in `instructions`
// (OpenAI's Sign in with ChatGPT docs, Oct 2026). Error codes from the same docs: 429
// subscription_sharing_usage_limit_exceeded (the user's weekly per-app cap), 403
// subscription_sharing_user_not_eligible, 401 subscription_sharing_invalid_user.
import { Context, Data, Effect, Layer, Option, Schema, Stream } from "effect";
import { Sse } from "effect/encoding";
import { HttpClient, HttpClientRequest } from "effect/http";
import { type EngineError, ModelError, Refusal, type Spent, UsageLimit } from "../engines/errors.ts";
import type { Tokens as Usage } from "../usage.ts";
import { type Endpoints, type TokenError, makeTokenManager } from "./auth.ts";

// a user message is a list of text parts, so stable context blocks stay byte-stable on the wire
export type Turn = { readonly role: "user"; readonly parts: readonly string[] } | { readonly role: "assistant"; readonly text: string };
export type Ask = { readonly model: string; readonly instructions: string; readonly input: readonly Turn[]; readonly effort?: string };
export type Reply = { readonly text: string; readonly usage: Usage; readonly model: string };

export class OpenAiPlan extends Context.Service<OpenAiPlan, { readonly respond: (ask: Ask) => Effect.Effect<Reply, EngineError> }>()(
  "optchat/OpenAiPlan",
) {}

const Body = Schema.Struct({
  model: Schema.String,
  instructions: Schema.String,
  input: Schema.Array(
    Schema.Union([
      Schema.Struct({ role: Schema.Literal("user"), content: Schema.Array(Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String })) }),
      Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.String }),
    ]),
  ),
  reasoning: Schema.optional(Schema.Struct({ effort: Schema.String })),
  stream: Schema.Literal(true),
  store: Schema.Literal(false),
});
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Body));

export const body = (ask: Ask) =>
  encodeBody({
    input: ask.input.map((t) =>
      t.role === "user"
        ? { content: t.parts.map((text) => ({ text, type: "input_text" as const })), role: "user" as const }
        : { content: t.text, role: "assistant" as const },
    ),
    instructions: ask.instructions,
    model: ask.model,
    reasoning: ask.effort === undefined ? undefined : { effort: ask.effort },
    store: false,
    stream: true,
  });

// The stream events we act on, each decoded by its `type`; the rest (created, in_progress, item and
// part events…) only pass.
const ApiError = Schema.Struct({ code: Schema.optional(Schema.NullOr(Schema.String)), message: Schema.optional(Schema.String) });
const ApiUsage = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  input_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({ cached_tokens: Schema.optional(Schema.Number) }))),
});
const json = <S extends Schema.Top>(schema: S) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema));
const typeOf = json(Schema.Struct({ type: Schema.String }));
const delta = json(Schema.Struct({ delta: Schema.String }));
const completed = json(Schema.Struct({ response: Schema.Struct({ model: Schema.optional(Schema.String), usage: Schema.optional(Schema.NullOr(ApiUsage)) }) }));
// a response that ended badly may still say what it cost
const Ended = { model: Schema.optional(Schema.String), usage: Schema.optional(Schema.NullOr(ApiUsage)) };
const failed = json(Schema.Struct({ response: Schema.Struct({ ...Ended, error: Schema.optional(Schema.NullOr(ApiError)) }) }));
const incomplete = json(
  Schema.Struct({ response: Schema.Struct({ ...Ended, incomplete_details: Schema.optional(Schema.NullOr(Schema.Struct({ reason: Schema.optional(Schema.String) }))) }) }),
);
const errorEvent = json(Schema.Struct({ code: Schema.optional(Schema.NullOr(Schema.String)), message: Schema.optional(Schema.String), error: Schema.optional(ApiError) }));
const ErrorBody = Schema.Struct({ error: ApiError });
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

// a spent or rate-limited plan, or a plan this user may not share: the chain moves on (E4)
const LIMIT = /usage_limit|rate_limit|insufficient_quota|not_eligible|quota/;

export const classify = (status: number | null, code: string | null | undefined, message: string | undefined, spent: Spent = {}): EngineError => {
  const text = `openai-plan: ${[status, code, message].filter((x) => x !== null && x !== undefined && x !== "").join(" ")}`;
  if (status === 429 || (code !== null && code !== undefined && LIMIT.test(code))) return new UsageLimit({ ...spent, message: text });
  return new ModelError({ ...spent, message: text });
};

export const usageOf = (u: typeof ApiUsage.Type | null | undefined): Usage => {
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  // OpenAI counts cached tokens inside input_tokens; ours keeps them apart, as Anthropic does
  return { cacheRead: cached, cacheWrite: 0, input: (u?.input_tokens ?? 0) - cached, output: u?.output_tokens ?? 0 };
};

const spentOf = (r: { readonly model?: string | undefined; readonly usage?: typeof ApiUsage.Type | null | undefined }, model: string): Spent =>
  r.usage ? { model: r.model ?? model, usage: usageOf(r.usage) } : {};

class Unauthorized extends Data.TaggedError("Unauthorized")<{ readonly message: string }> {}

type Read = { readonly text: string; readonly refusal: string; readonly done: Reply | null };

const onEvent = (model: string) => (r: Read, data: string): Effect.Effect<Read, EngineError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { type } = yield* typeOf(data);
    switch (type) {
      case "response.output_text.delta":
        return { ...r, text: r.text + (yield* delta(data)).delta };
      case "response.refusal.delta":
        return { ...r, refusal: r.refusal + (yield* delta(data)).delta };
      case "response.completed": {
        const { response } = yield* completed(data);
        return { ...r, done: { model: response.model ?? model, text: r.text, usage: usageOf(response.usage) } };
      }
      case "response.failed": {
        const { response } = yield* failed(data);
        return yield* classify(null, response.error?.code, response.error?.message ?? "response.failed", spentOf(response, model));
      }
      case "response.incomplete": {
        const { response } = yield* incomplete(data);
        const reason = response.incomplete_details?.reason ?? "no reason given";
        return yield* new ModelError({ ...spentOf(response, model), message: `openai-plan: incomplete response (${reason})` });
      }
      case "error": {
        const e = yield* errorEvent(data);
        return yield* classify(null, e.code ?? e.error?.code, e.message ?? e.error?.message);
      }
      default:
        return r;
    }
  });

// A stream counts only when it ends in response.completed, and ends there: whatever follows (a
// `data: [DONE]` line, say) is never read. One that starts well can still fail.
export const readStream = (stream: Stream.Stream<Uint8Array, EngineError>, model: string) =>
  Effect.gen(function* () {
    const last = yield* stream.pipe(
      Stream.decodeText(),
      Stream.pipeThroughChannel(Sse.decode()),
      Stream.scanEffect((): Read => ({ done: null, refusal: "", text: "" }), (acc, event) => (event.data === "[DONE]" ? Effect.succeed(acc) : onEvent(model)(acc, event.data))),
      Stream.takeUntil((r) => r.done !== null),
      Stream.runLast,
      Effect.catchTags({
        Retry: () => Effect.fail(new ModelError({ message: "openai-plan: the stream asked to reconnect" })),
        SchemaError: (e) => Effect.fail(new ModelError({ message: `openai-plan: unexpected stream event: ${e.message}` })),
        SseError: (e) => Effect.fail(new ModelError({ message: `openai-plan: ${e.message}` })),
      }),
    );
    const r = Option.getOrUndefined(last);
    if (r?.refusal) return yield* new Refusal({ message: `openai-plan refused: ${r.refusal.slice(0, 300)}`, model: r.done?.model, usage: r.done?.usage });
    if (!r?.done) return yield* new ModelError({ message: "openai-plan: the stream ended without response.completed" });
    return r.done;
  });

// Signed out (nothing saved, or the refresh token refused): like a spent plan, the next engine
// takes the call. Anything else on the way to a token is reported and retried, not a failover:
// the endpoint down, a store or secret we can't read, an ID token that isn't ours.
const tokenFailure = (err: TokenError): EngineError =>
  err._tag === "NotSignedIn" || err._tag === "GrantRejected"
    ? new UsageLimit({ message: `openai-plan: ${err.message}` })
    : new ModelError({ message: `openai-plan: ${err.message}` });

export const openAiPlanLayer = (e: Endpoints, o: { readonly report?: (message: string) => Effect.Effect<void> } = {}) =>
  Layer.effect(
    OpenAiPlan,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const tokens = yield* makeTokenManager(e, o);

      const once = (ask: Ask, token: string) =>
        Effect.gen(function* () {
          const req = HttpClientRequest.post(`${e.api}/responses`).pipe(
            HttpClientRequest.bearerToken(token),
            HttpClientRequest.accept("text/event-stream"),
            HttpClientRequest.bodyText(body(ask), "application/json"),
          );
          const res = yield* http.execute(req);
          if (res.status === 401) return yield* new Unauthorized({ message: (yield* res.text).slice(0, 300) });
          if (res.status !== 200) {
            const raw = yield* res.text;
            const parsed = decodeErrorBody(raw);
            return yield* parsed._tag === "Some" ? classify(res.status, parsed.value.error.code, parsed.value.error.message) : classify(res.status, null, raw.slice(0, 300));
          }
          return yield* readStream(res.stream.pipe(Stream.mapError((err) => new ModelError({ message: `openai-plan: ${err.message}` }))), ask.model);
        }).pipe(Effect.catchTag("HttpClientError", (err) => Effect.fail(new ModelError({ message: `openai-plan: ${err.message}` }))));

      // a 401 refreshes the token once, then counts as signed out
      const respond = (ask: Ask) =>
        Effect.gen(function* () {
          const token = yield* tokens.current.pipe(Effect.mapError(tokenFailure));
          return yield* once(ask, token).pipe(
            Effect.catchTag("Unauthorized", () =>
              tokens.renew(token).pipe(
                Effect.mapError(tokenFailure),
                Effect.flatMap((fresh) => once(ask, fresh)),
                Effect.catchTag("Unauthorized", (u) => Effect.fail(new UsageLimit({ message: `openai-plan: still unauthorized after a refresh: ${u.message}` }))),
              ),
            ),
          );
        });
      return { respond };
    }),
  );
