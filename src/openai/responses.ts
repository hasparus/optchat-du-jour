// The Responses API on the ChatGPT plan (SPEC "Engines", openai-plan): one streamed request per
// call, `stream: true` and `store: false` as plan usage requires, nothing carried server-side
// between calls. The route rejects `system` messages, so the system prompt goes in `instructions`
// (OpenAI's Sign in with ChatGPT docs, Oct 2026). Error codes from the same docs: 429
// subscription_sharing_usage_limit_exceeded (the user's weekly per-app cap), 403
// subscription_sharing_user_not_eligible, 401 subscription_sharing_invalid_user. The same client
// carries an OpenAI API key (api-key engine), and function tools for our own tool loop (M5):
// function_call items out, function_call_output items back in the next request.
//
// Caching, as gist §8 has it for the Responses API: `store: false`, every reasoning item asked for
// with its encrypted content and sent back verbatim in the next request (a tool round, a size
// retry), `reasoning.context: "all_turns"` so a message sent mid-run doesn't drop the earlier
// reasoning from the prompt, and the same `prompt_cache_breakpoint` on the view's pieces in every
// request; the request end is cached implicitly (`prompt_cache_options` left at its default). A
// model that refuses the breakpoint field (the reference measured that on the Codex route) gets
// the request again without it, and is sent none from then on, said once.
import { Context, Data, Effect, Layer, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { type EngineError, ModelError, Refusal, type Spent, type Tagged, UsageLimit } from "../engines/errors.ts";
import { json, sseFold, typeOf } from "../engines/sse.ts";
import { isPicture, type Part } from "../media/part.ts";
import { wireJson } from "../text.ts";
import type { Tokens as Usage } from "../usage.ts";
import { type TokenError, makeTokenManager } from "./auth.ts";
import type { Endpoints } from "./endpoints.ts";

// The conversation as sent. A user message is a list of parts, so stable context blocks stay
// byte-stable on the wire; an image part goes as `input_image` with a data URL (SPEC "Media"); a
// function call and its output are items of their own (our tool loop).
// `marks`: how many leading parts end at one of the view's cuts and carry a cache breakpoint.
// A reasoning item is the API's own, sent back exactly as it came.
export type Reasoning = Readonly<Record<string, Schema.Json>>;
export type Turn =
  | { readonly role: "user"; readonly parts: readonly Part[]; readonly marks?: number }
  | { readonly role: "reasoning"; readonly item: Reasoning }
  | { readonly role: "assistant"; readonly text: string }
  | { readonly role: "call"; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly role: "output"; readonly id: string; readonly output: string };
export type FunctionTool = { readonly name: string; readonly description: string; readonly parameters: Schema.Json };
// what the reply holds, in order: its text, the calls it asks for, and its reasoning items (never
// shown or logged; only sent back)
export type Out =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "call"; readonly id: string; readonly name: string; readonly arguments: string }
  | { readonly type: "reasoning"; readonly item: Reasoning };
export type Ask<E extends Tagged = never> = {
  readonly model: string;
  readonly instructions: string;
  readonly input: readonly Turn[];
  readonly effort?: string;
  readonly tools?: readonly FunctionTool[];
  readonly toolChoice?: "auto" | "none";
  readonly onText?: (delta: string) => Effect.Effect<void>; // live text as it streams
  readonly onThinking?: (tokens: number) => Effect.Effect<void>; // the size of the reasoning streamed so far
  readonly onOut?: (out: Out) => Effect.Effect<void, E>; // each item of `output` as it completes
};
export type Reply = { readonly text: string; readonly usage: Usage; readonly model: string; readonly output: readonly Out[] };
export type Respond = <E extends Tagged = never>(ask: Ask<E>) => Effect.Effect<Reply, EngineError | E>;

export class OpenAiPlan extends Context.Service<OpenAiPlan, { readonly respond: Respond }>()("optchat/OpenAiPlan") {}

const InputText = Schema.Struct({
  type: Schema.Literal("input_text"),
  text: Schema.String,
  prompt_cache_breakpoint: Schema.optional(Schema.Struct({ mode: Schema.Literal("explicit") })),
});
// a reasoning item as the API sent it: its id, summary and encrypted content, whatever else it holds
const ReasoningItem = Schema.Record(Schema.String, Schema.Json);
const InputImage = Schema.Struct({ type: Schema.Literal("input_image"), image_url: Schema.String, detail: Schema.Literal("auto") });
const Body = Schema.Struct({
  model: Schema.String,
  instructions: Schema.String,
  input: Schema.Array(
    Schema.Union([
      Schema.Struct({ role: Schema.Literal("user"), content: Schema.Array(Schema.Union([InputText, InputImage])) }),
      Schema.Struct({ role: Schema.Literal("assistant"), content: Schema.String }),
      Schema.Struct({ type: Schema.Literal("function_call"), call_id: Schema.String, name: Schema.String, arguments: Schema.String }),
      Schema.Struct({ type: Schema.Literal("function_call_output"), call_id: Schema.String, output: Schema.String }),
      ReasoningItem,
    ]),
  ),
  // strict: false, since our schemas have optional fields, which strict mode forbids
  tools: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.Literal("function"), name: Schema.String, description: Schema.String, parameters: Schema.Json, strict: Schema.Literal(false) })),
  ),
  tool_choice: Schema.optional(Schema.Literals(["auto", "none"])),
  reasoning: Schema.Struct({ effort: Schema.optional(Schema.String), context: Schema.Literal("all_turns") }),
  include: Schema.Tuple([Schema.Literal("reasoning.encrypted_content")]),
  stream: Schema.Literal(true),
  store: Schema.Literal(false),
});
// every string made well-formed on the way out (wireJson)
const encodeBody = (b: typeof Body.Type) => wireJson(Schema.encodeSync(Body)(b));

const BREAKPOINT = { mode: "explicit" } as const;

const item = (t: Turn, breakpoints: boolean): (typeof Body.Type)["input"][number] => {
  switch (t.role) {
    case "user": {
      const marks = breakpoints ? (t.marks ?? 0) : 0;
      return {
        content: t.parts.map((p, k) =>
          isPicture(p)
            ? { detail: "auto" as const, image_url: `data:${p.mime};base64,${p.data}`, type: "input_image" as const }
            : k < marks
              ? { prompt_cache_breakpoint: BREAKPOINT, text: p, type: "input_text" as const }
              : { text: p, type: "input_text" as const },
        ),
        role: "user",
      };
    }
    case "reasoning":
      return t.item;
    case "assistant":
      return { content: t.text, role: "assistant" };
    case "call":
      return { arguments: t.arguments, call_id: t.id, name: t.name, type: "function_call" };
    case "output":
      return { call_id: t.id, output: t.output, type: "function_call_output" };
  }
};

// `breakpoints: false` for a model that refused the field (see makeResponses)
export const body = (ask: Ask<Tagged>, breakpoints = true) =>
  encodeBody({
    include: ["reasoning.encrypted_content"],
    input: ask.input.map((t) => item(t, breakpoints)),
    instructions: ask.instructions,
    model: ask.model,
    reasoning: { context: "all_turns", effort: ask.effort },
    store: false,
    stream: true,
    tool_choice: ask.tools === undefined ? undefined : (ask.toolChoice ?? "auto"),
    tools: ask.tools?.map((t) => ({ description: t.description, name: t.name, parameters: t.parameters, strict: false as const, type: "function" as const })),
  });

// The stream events we act on, each decoded by its `type`; the rest (created, in_progress, item and
// part events…) only pass.
const ApiError = Schema.Struct({
  code: Schema.optional(Schema.NullOr(Schema.String)),
  message: Schema.optional(Schema.String),
  param: Schema.optional(Schema.NullOr(Schema.String)),
});
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
const doneReasoning = json(Schema.Struct({ item: ReasoningItem }));
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
const isUnauthorized = (e: Tagged): e is Unauthorized => e._tag === "Unauthorized";

type Read = { readonly text: string; readonly reasoning: number; readonly refusal: string; readonly output: readonly Out[]; readonly done: Reply | null };

type Hooks<E extends Tagged> = Pick<Ask<E>, "onOut" | "onText" | "onThinking">;

const onEvent =
  <E extends Tagged>(o: { readonly model: string; readonly label: string } & Hooks<E>) =>
  (r: Read, data: string): Effect.Effect<Read, E | EngineError | Schema.SchemaError> => {
    // an item of `output` is whole: it goes out now, so what follows it streams after it
    const out = (item: Out) => Effect.as(o.onOut ? o.onOut(item) : Effect.void, { ...r, output: [...r.output, item] });
    return Effect.gen(function* () {
      const { type } = yield* typeOf(data);
      switch (type) {
        case "response.output_text.delta": {
          const d = (yield* delta(data)).delta;
          if (o.onText) yield* o.onText(d);
          return { ...r, text: r.text + d };
        }
        // reasoning is streamed only when the API is asked for it; its size is all that goes out
        case "response.reasoning_text.delta":
        case "response.reasoning_summary_text.delta": {
          const reasoning = r.reasoning + (yield* delta(data)).delta.length;
          if (o.onThinking) yield* o.onThinking(Math.ceil(reasoning / 4));
          return { ...r, reasoning };
        }
        case "response.refusal.delta":
          return { ...r, refusal: r.refusal + (yield* delta(data)).delta };
        case "response.output_item.done": {
          const { item } = yield* doneItem(data);
          if (item.type === "function_call") return yield* out({ arguments: item.arguments ?? "{}", id: item.call_id ?? "", name: item.name ?? "", type: "call" });
          // with store: false the API keeps nothing, so a reasoning item goes back whole, as it came
          if (item.type === "reasoning") return yield* out({ item: (yield* doneReasoning(data)).item, type: "reasoning" });
          if (item.type !== "message") return r;
          const text = (item.content ?? []).flatMap((c) => (c.type === "output_text" && c.text !== undefined ? [c.text] : [])).join("");
          return text ? yield* out({ text, type: "text" }) : r;
        }
        case "response.completed": {
          const { response } = yield* completed(data);
          // a stream that never said which items it held: its text is the one item
          const said = r.output.some((x) => x.type !== "reasoning");
          const whole = !said && r.text ? yield* out({ text: r.text, type: "text" }) : r;
          return { ...whole, done: { model: response.model ?? o.model, output: whole.output, text: r.text, usage: usageOf(response.usage) } };
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
  };

// A stream counts only when it ends in response.completed, and ends there: whatever follows (a
// `data: [DONE]` line, say) is never read. One that starts well can still fail.
export const readStream = <E extends Tagged = never>(stream: Stream.Stream<Uint8Array, EngineError>, model: string, o: { readonly label?: string } & Hooks<E> = {}) =>
  Effect.gen(function* () {
    const label = o.label ?? "openai-plan";
    const init: Read = { done: null, output: [], reasoning: 0, refusal: "", text: "" };
    const r = yield* sseFold(label, stream, init, onEvent({ ...o, label, model }), (state) => state.done !== null);
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
// `report` hears, once per model, that a model refused the breakpoints and is sent none.
export const makeResponses = (o: { readonly api: string; readonly label: string; readonly bearer: Bearer; readonly report?: (message: string) => Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    // the models that refused `prompt_cache_breakpoint`: their requests go without it from then on
    const unmarked = new Set<string>();
    const post = <E extends Tagged>(ask: Ask<E>, token: string, marked: boolean) =>
      http.execute(
        HttpClientRequest.post(`${o.api}/responses`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.accept("text/event-stream"),
          HttpClientRequest.bodyText(body(ask, marked), "application/json"),
        ),
      );
    // A model that refuses the breakpoints (a 400 naming the field) gets the same request again
    // without them, and none from then on, which the user hears once, rather than failing every
    // call; gist §8's marks are then off for it.
    const once = <E extends Tagged>(ask: Ask<E>, token: string) =>
      Effect.gen(function* () {
        const marked = !unmarked.has(ask.model);
        let res = yield* post(ask, token, marked);
        let raw: string | null = null;
        if (marked && res.status === 400) {
          raw = yield* res.text;
          const refused = Option.getOrUndefined(decodeErrorBody(raw))?.error;
          if (refused?.param === "prompt_cache_breakpoint" || (refused?.message ?? "").includes("prompt_cache_breakpoint")) {
            const first = !unmarked.has(ask.model); // a call sent alongside may have been refused already
            unmarked.add(ask.model);
            if (first && o.report) yield* o.report(`${o.label}: ${ask.model} refuses prompt_cache_breakpoint (${refused?.message ?? "400"}); its requests go without the view's cache marks`);
            res = yield* post(ask, token, false);
            raw = null;
          }
        }
        if (res.status === 401) return yield* new Unauthorized({ message: (raw ?? (yield* res.text)).slice(0, 300) });
        if (res.status !== 200) {
          const text = raw ?? (yield* res.text);
          const parsed = decodeErrorBody(text);
          return yield* parsed._tag === "Some"
            ? classify(res.status, parsed.value.error.code, parsed.value.error.message, o.label)
            : classify(res.status, null, text.slice(0, 300), o.label);
        }
        const stream = res.stream.pipe(Stream.mapError((err) => new ModelError({ message: `${o.label}: ${err.message}` })));
        return yield* readStream(stream, ask.model, { label: o.label, onOut: ask.onOut, onText: ask.onText, onThinking: ask.onThinking });
      }).pipe(Effect.catchIf(HttpClientError.isHttpClientError, (err) => Effect.fail(new ModelError({ message: `${o.label}: ${err.message}` }))));

    // a 401 renews the token once, then counts as signed out
    const respond: Respond = (ask) =>
      Effect.gen(function* () {
        const token = yield* o.bearer.current;
        return yield* once(ask, token).pipe(
          Effect.catchIf(isUnauthorized, () =>
            o.bearer.renew(token).pipe(
              Effect.flatMap((fresh) => once(ask, fresh)),
              Effect.catchIf(isUnauthorized, (u) => Effect.fail(new UsageLimit({ message: `${o.label}: still unauthorized after a refresh: ${u.message}` }))),
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
        report: o.report,
        bearer: {
          current: tokens.current.pipe(Effect.mapError(tokenFailure)),
          renew: (stale) => tokens.renew(stale).pipe(Effect.mapError(tokenFailure)),
        },
        label: "openai-plan",
      });
      return { respond };
    }),
  );
