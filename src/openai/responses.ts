// The Responses API on the ChatGPT plan (SPEC "Engines", openai-plan): one streamed request per
// call, `stream: true` and `store: false` as plan usage requires, nothing carried server-side
// between calls. The route rejects `system` messages, so the system prompt goes in `instructions`
// (OpenAI's Sign in with ChatGPT docs, Oct 2026). Error codes from the same docs: 429
// subscription_sharing_usage_limit_exceeded (the user's weekly per-app cap), 403
// subscription_sharing_user_not_eligible, 401 subscription_sharing_invalid_user. The same client
// carries an OpenAI API key (api-key engine), and function tools for our own tool loop (M5):
// function_call items out, function_call_output items back in the next request.
import { Context, Data, Effect, Layer, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { type EngineError, ModelError, Refusal, type Spent, UsageLimit } from "../engines/errors.ts";
import { json, sseFold, typeOf } from "../engines/sse.ts";
import type { Tokens as Usage } from "../usage.ts";
import { type TokenError, makeTokenManager } from "./auth.ts";
import type { Endpoints } from "./endpoints.ts";

// The conversation as sent. A user message is a list of text parts, so stable context blocks stay
// byte-stable on the wire; a function call and its output are items of their own (our tool loop).
export type Turn =
  | { readonly role: "user"; readonly parts: readonly string[] }
  | { readonly role: "assistant"; readonly text: string }
  | { readonly role: "call"; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly role: "output"; readonly id: string; readonly output: string };
export type FunctionTool = { readonly name: string; readonly description: string; readonly parameters: Schema.Json };
export type Ask = {
  readonly model: string;
  readonly instructions: string;
  readonly input: readonly Turn[];
  readonly effort?: string;
  readonly tools?: readonly FunctionTool[];
  readonly toolChoice?: "auto" | "none";
  readonly onText?: (delta: string) => Effect.Effect<void>; // live text as it streams
};
// what the reply holds, in order: its text and the calls it asks for
export type Out = { readonly type: "text"; readonly text: string } | { readonly type: "call"; readonly id: string; readonly name: string; readonly arguments: string };
export type Reply = { readonly text: string; readonly usage: Usage; readonly model: string; readonly output: readonly Out[] };
export type Respond = (ask: Ask) => Effect.Effect<Reply, EngineError>;

export class OpenAiPlan extends Context.Service<OpenAiPlan, { readonly respond: Respond }>()("optchat/OpenAiPlan") {}

const InputText = Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String });
const Body = Schema.Struct({
  model: Schema.String,
  instructions: Schema.String,
  input: Schema.Array(
    Schema.Union([
      Schema.Struct({ role: Schema.Literal("user"), content: Schema.Array(InputText) }),
      Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.String }),
      Schema.Struct({ type: Schema.Literal("function_call"), call_id: Schema.String, name: Schema.String, arguments: Schema.String }),
      Schema.Struct({ type: Schema.Literal("function_call_output"), call_id: Schema.String, output: Schema.String }),
    ]),
  ),
  // strict: false, since our schemas have optional fields, which strict mode forbids
  tools: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.Literal("function"), name: Schema.String, description: Schema.String, parameters: Schema.Json, strict: Schema.Literal(false) })),
  ),
  tool_choice: Schema.optional(Schema.Literals(["auto", "none"])),
  reasoning: Schema.optional(Schema.Struct({ effort: Schema.String })),
  stream: Schema.Literal(true),
  store: Schema.Literal(false),
});
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Body));

const item = (t: Turn): (typeof Body.Type)["input"][number] => {
  switch (t.role) {
    case "user":
      return { content: t.parts.map((text) => ({ text, type: "input_text" as const })), role: "user" };
    case "assistant":
      return { content: t.text, role: "assistant" };
    case "call":
      return { arguments: t.arguments, call_id: t.id, name: t.name, type: "function_call" };
    case "output":
      return { call_id: t.id, output: t.output, type: "function_call_output" };
  }
};

export const body = (ask: Ask) =>
  encodeBody({
    input: ask.input.map(item),
    instructions: ask.instructions,
    model: ask.model,
    reasoning: ask.effort === undefined ? undefined : { effort: ask.effort },
    store: false,
    stream: true,
    tool_choice: ask.tools === undefined ? undefined : (ask.toolChoice ?? "auto"),
    tools: ask.tools?.map((t) => ({ description: t.description, name: t.name, parameters: t.parameters, strict: false as const, type: "function" as const })),
  });

// The stream events we act on, each decoded by its `type`; the rest (created, in_progress, item and
// part events…) only pass.
const ApiError = Schema.Struct({ code: Schema.optional(Schema.NullOr(Schema.String)), message: Schema.optional(Schema.String) });
const ApiUsage = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  input_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({ cached_tokens: Schema.optional(Schema.Number) }))),
});
const delta = json(Schema.Struct({ delta: Schema.String }));
const doneItem = json(
  Schema.Struct({
    item: Schema.Struct({
      type: Schema.String,
      call_id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.String),
      content: Schema.optional(Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))),
    }),
  }),
);
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

// `label` names the engine in the message: openai-plan, or api-key for a key's calls
export const classify = (status: number | null, code: string | null | undefined, message: string | undefined, label = "openai-plan", spent?: Spent): EngineError => {
  const text = `${label}: ${[status, code, message].filter((x) => x !== null && x !== undefined && x !== "").join(" ")}`;
  if (status === 429 || (code !== null && code !== undefined && LIMIT.test(code))) return new UsageLimit({ message: text, spent });
  return new ModelError({ message: text, spent });
};

export const usageOf = (u: typeof ApiUsage.Type | null | undefined): Usage => {
  const cached = u?.input_tokens_details?.cached_tokens ?? 0;
  // OpenAI counts cached tokens inside input_tokens; ours keeps them apart, as Anthropic does
  return { cacheRead: cached, cacheWrite: 0, input: (u?.input_tokens ?? 0) - cached, output: u?.output_tokens ?? 0 };
};

const spentOf = (r: { readonly model?: string | undefined; readonly usage?: typeof ApiUsage.Type | null | undefined }, model: string): Spent | undefined =>
  r.usage ? { model: r.model ?? model, usage: usageOf(r.usage) } : undefined;

class Unauthorized extends Data.TaggedError("Unauthorized")<{ readonly message: string }> {}

type Read = { readonly text: string; readonly refusal: string; readonly output: readonly Out[]; readonly done: Reply | null };

const onEvent = (o: { readonly model: string; readonly label: string; readonly onText?: Ask["onText"] }) => (r: Read, data: string): Effect.Effect<Read, EngineError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { type } = yield* typeOf(data);
    switch (type) {
      case "response.output_text.delta": {
        const d = (yield* delta(data)).delta;
        if (o.onText) yield* o.onText(d);
        return { ...r, text: r.text + d };
      }
      case "response.refusal.delta":
        return { ...r, refusal: r.refusal + (yield* delta(data)).delta };
      case "response.output_item.done": {
        const { item } = yield* doneItem(data);
        if (item.type === "function_call")
          return { ...r, output: [...r.output, { arguments: item.arguments ?? "{}", id: item.call_id ?? "", name: item.name ?? "", type: "call" }] };
        if (item.type !== "message") return r; // reasoning and the rest: not sent back (store: false)
        const text = (item.content ?? []).flatMap((c) => (c.type === "output_text" && c.text !== undefined ? [c.text] : [])).join("");
        return text ? { ...r, output: [...r.output, { text, type: "text" }] } : r;
      }
      case "response.completed": {
        const { response } = yield* completed(data);
        // a stream that never said which items it held: its text is the one item
        const output = r.output.length === 0 && r.text ? [{ text: r.text, type: "text" as const }] : r.output;
        return { ...r, done: { model: response.model ?? o.model, output, text: r.text, usage: usageOf(response.usage) } };
      }
      case "response.failed": {
        const { response } = yield* failed(data);
        return yield* classify(null, response.error?.code, response.error?.message ?? "response.failed", o.label, spentOf(response, o.model));
      }
      case "response.incomplete": {
        const { response } = yield* incomplete(data);
        const reason = response.incomplete_details?.reason ?? "no reason given";
        return yield* new ModelError({ message: `${o.label}: incomplete response (${reason})`, spent: spentOf(response, o.model) });
      }
      case "error": {
        const e = yield* errorEvent(data);
        return yield* classify(null, e.code ?? e.error?.code, e.message ?? e.error?.message, o.label);
      }
      default:
        return r;
    }
  });

// A stream counts only when it ends in response.completed, and ends there: whatever follows (a
// `data: [DONE]` line, say) is never read. One that starts well can still fail.
export const readStream = (stream: Stream.Stream<Uint8Array, EngineError>, model: string, o: { readonly label?: string; readonly onText?: Ask["onText"] } = {}) =>
  Effect.gen(function* () {
    const label = o.label ?? "openai-plan";
    const init: Read = { done: null, output: [], refusal: "", text: "" };
    const r = yield* sseFold(label, stream, init, onEvent({ label, model, onText: o.onText }), (state) => state.done !== null);
    if (r.refusal) return yield* new Refusal({ message: `${label} refused: ${r.refusal.slice(0, 300)}`, spent: r.done ? { model: r.done.model, usage: r.done.usage } : undefined });
    if (r.done === null) return yield* new ModelError({ message: `${label}: the stream ended without response.completed` });
    return r.done;
  });

// How a client authenticates: a bearer token now, and a fresh one after a 401 with `stale`.
// UsageLimit when there is none (signed out, no key): the chain moves on.
export type Bearer = {
  readonly current: Effect.Effect<string, EngineError>;
  readonly renew: (stale: string) => Effect.Effect<string, EngineError>;
};

// The Responses API at `api` (…/v1) with `bearer`: the plan's tokens or an API key (SPEC "Engines").
export const makeResponses = (o: { readonly api: string; readonly label: string; readonly bearer: Bearer }) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const once = (ask: Ask, token: string) =>
      Effect.gen(function* () {
        const req = HttpClientRequest.post(`${o.api}/responses`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.accept("text/event-stream"),
          HttpClientRequest.bodyText(body(ask), "application/json"),
        );
        const res = yield* http.execute(req);
        if (res.status === 401) return yield* new Unauthorized({ message: (yield* res.text).slice(0, 300) });
        if (res.status !== 200) {
          const raw = yield* res.text;
          const parsed = decodeErrorBody(raw);
          return yield* parsed._tag === "Some"
            ? classify(res.status, parsed.value.error.code, parsed.value.error.message, o.label)
            : classify(res.status, null, raw.slice(0, 300), o.label);
        }
        const stream = res.stream.pipe(Stream.mapError((err) => new ModelError({ message: `${o.label}: ${err.message}` })));
        return yield* readStream(stream, ask.model, { label: o.label, onText: ask.onText });
      }).pipe(Effect.catchTag("HttpClientError", (err) => Effect.fail(new ModelError({ message: `${o.label}: ${err.message}` }))));

    // a 401 renews the token once, then counts as signed out
    const respond: Respond = (ask) =>
      Effect.gen(function* () {
        const token = yield* o.bearer.current;
        return yield* once(ask, token).pipe(
          Effect.catchTag("Unauthorized", () =>
            o.bearer.renew(token).pipe(
              Effect.flatMap((fresh) => once(ask, fresh)),
              Effect.catchTag("Unauthorized", (u) => Effect.fail(new UsageLimit({ message: `${o.label}: still unauthorized after a refresh: ${u.message}` }))),
            ),
          ),
        );
      });
    return respond;
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
      const tokens = yield* makeTokenManager(e, o);
      const respond = yield* makeResponses({
        api: e.api,
        bearer: {
          current: tokens.current.pipe(Effect.mapError(tokenFailure)),
          renew: (stale) => tokens.renew(stale).pipe(Effect.mapError(tokenFailure)),
        },
        label: "openai-plan",
      });
      return { respond };
    }),
  );
