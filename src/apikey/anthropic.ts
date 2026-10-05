// Anthropic's Messages API with an API key (SPEC "Engines", api-key: overflow only, our own cache
// marks with `cache.apiKeyTtls`). One streamed request per call. The marks go on the stable
// leading blocks of the first user message (the view, or a compactor's context pieces), one TTL
// each, in the configured order; config.ts makes sure every 1-hour mark comes before any
// 5-minute one, which Anthropic requires. Thinking blocks come back in the next request exactly as
// they arrived, signature and all, as tool use with thinking requires.
import { Effect, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { type EngineError, ModelError, Refusal, UsageLimit } from "../engines/errors.ts";
import { json, sseFold, typeOf } from "../engines/sse.ts";
import type { ToolDef } from "../tools/files.ts";
import type { Item } from "../turn/loop.ts";
import type { Tokens } from "../usage.ts";
import type { Writes } from "./budget.ts";

export const ANTHROPIC_API = "https://api.anthropic.com";
const VERSION = "2023-06-01";
export const MAX_TOKENS = 64_000; // streamed, so a long answer doesn't time out

type Ttl = "1h" | "5m";
type Json = Schema.Json;

export type MessagesAsk = {
  readonly model: string;
  readonly system: string;
  readonly history: readonly Item[];
  readonly ttls: readonly Ttl[];
  readonly tools?: readonly ToolDef[];
  readonly toolChoice?: "auto" | "none";
  readonly maxTokens?: number;
  readonly effort?: string;
  readonly onText?: (delta: string) => Effect.Effect<void>;
};
// `writes` splits the cache writes by TTL when the API says how
export type MessagesReply = { readonly items: readonly Item[]; readonly usage: Tokens; readonly writes: Writes | undefined; readonly model: string };
export type Messages = (ask: MessagesAsk) => Effect.Effect<MessagesReply, EngineError>;

const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)));
// a tool call's input as the API wants it back: an object, {} for one cut short
const inputOf = (text: string): Json => Option.getOrElse(decodeObject(text), () => ({}));

// The conversation as Messages: user parts and tool results on the user side, text, calls and
// kept blocks on the assistant side, neighbours of one side merged into one message. The first
// user message's stable parts get the marks, as many as there are TTLs.
export const messagesOf = (history: readonly Item[], ttls: readonly Ttl[]) => {
  const out: { role: "user" | "assistant"; content: Json[] }[] = [];
  let marked = false;
  const push = (role: "user" | "assistant", blocks: readonly Json[]) => {
    if (blocks.length === 0) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ content: [...blocks], role });
  };
  for (const item of history) {
    switch (item.type) {
      case "user": {
        const marks: number = marked ? 0 : Math.min(item.stable ?? 0, ttls.length);
        marked ||= marks > 0;
        const blocks: Json[] = [];
        for (const [k, text] of item.parts.entries()) {
          if (!text) continue; // the API refuses empty text blocks
          const ttl = k < marks ? ttls[k] : undefined;
          blocks.push(ttl === undefined ? { text, type: "text" } : { cache_control: { ttl, type: "ephemeral" }, text, type: "text" });
        }
        push("user", blocks);
        break;
      }
      case "result":
        push("user", [{ content: item.output, tool_use_id: item.id, type: "tool_result" }]);
        break;
      case "text":
        push("assistant", item.text ? [{ text: item.text, type: "text" }] : []);
        break;
      case "call":
        push("assistant", [{ id: item.id, input: inputOf(item.input), name: item.name, type: "tool_use" }]);
        break;
      case "kept":
        push("assistant", [item.block]);
        break;
    }
  }
  return out;
};

const Body = Schema.Struct({
  model: Schema.String,
  max_tokens: Schema.Int,
  system: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
  messages: Schema.Array(Schema.Struct({ role: Schema.Literals(["user", "assistant"]), content: Schema.Array(Schema.Json) })),
  tools: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String, input_schema: Schema.Json }))),
  tool_choice: Schema.optional(Schema.Struct({ type: Schema.Literals(["auto", "none"]) })),
  output_config: Schema.optional(Schema.Struct({ effort: Schema.String })),
  stream: Schema.Literal(true),
});
const encodeBody = Schema.encodeSync(Schema.fromJsonString(Body));

export const requestBody = (ask: MessagesAsk) => {
  const tools = ask.tools === undefined || ask.tools.length === 0 ? undefined : ask.tools;
  return encodeBody({
    max_tokens: ask.maxTokens ?? MAX_TOKENS,
    messages: messagesOf(ask.history, ask.ttls),
    model: ask.model,
    output_config: ask.effort === undefined ? undefined : { effort: ask.effort },
    stream: true,
    system: [{ text: ask.system, type: "text" }],
    tool_choice: tools === undefined ? undefined : { type: ask.toolChoice ?? "auto" },
    tools: tools?.map((t) => ({ description: t.description, input_schema: t.parameters, name: t.name })),
  });
};

// ---------------------------------------------------------------------------------------------
// the stream

const ApiUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  output_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  cache_creation: Schema.optional(
    Schema.NullOr(Schema.Struct({ ephemeral_5m_input_tokens: Schema.optional(Schema.Number), ephemeral_1h_input_tokens: Schema.optional(Schema.Number) })),
  ),
});
type ApiUsage = typeof ApiUsage.Type;
const ApiError = Schema.Struct({ type: Schema.optional(Schema.String), message: Schema.optional(Schema.String) });
const messageStart = json(Schema.Struct({ message: Schema.Struct({ model: Schema.optional(Schema.String), usage: Schema.optional(ApiUsage) }) }));
const ContentBlock = Schema.Struct({
  type: Schema.String,
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  data: Schema.optional(Schema.String),
});
const blockStart = json(Schema.Struct({ index: Schema.Number, content_block: ContentBlock }));
const blockDelta = json(
  Schema.Struct({
    index: Schema.Number,
    delta: Schema.Struct({
      type: Schema.String,
      text: Schema.optional(Schema.String),
      partial_json: Schema.optional(Schema.String),
      thinking: Schema.optional(Schema.String),
      signature: Schema.optional(Schema.String),
    }),
  }),
);
const messageDelta = json(
  Schema.Struct({
    delta: Schema.Struct({ stop_reason: Schema.optional(Schema.NullOr(Schema.String)) }),
    usage: Schema.optional(Schema.NullOr(ApiUsage)),
  }),
);
const errorEvent = json(Schema.Struct({ error: ApiError }));
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ error: ApiError })));

// a spent key, a rate limit, an overloaded API or a key it won't take: the chain moves on (E4)
const LIMITS = new Set(["rate_limit_error", "overloaded_error", "authentication_error", "permission_error", "billing_error"]);
export const classifyAnthropic = (status: number | null, type: string | undefined, message: string | undefined): EngineError => {
  const text = `api-key: anthropic ${[status, type, message].filter((x) => x !== null && x !== undefined && x !== "").join(" ")}`;
  const limited = status === 429 || status === 529 || status === 401 || status === 403 || (type !== undefined && LIMITS.has(type)) || /credit balance/i.test(message ?? "");
  return limited ? new UsageLimit({ message: text }) : new ModelError({ message: text });
};

type Block =
  | { readonly type: "text"; text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; json: string }
  | { readonly type: "thinking"; thinking: string; signature: string }
  | { readonly type: "redacted_thinking"; readonly data: string }
  | { readonly type: "other" };

type Read = { readonly blocks: Block[]; model: string; start: ApiUsage | null; end: ApiUsage | null; stop: string | null; done: boolean };

const blockOf = (b: typeof ContentBlock.Type): Block => {
  switch (b.type) {
    case "text":
      return { text: b.text ?? "", type: "text" };
    case "tool_use":
      return { id: b.id ?? "", json: "", name: b.name ?? "", type: "tool_use" };
    case "thinking":
      return { signature: b.signature ?? "", thinking: b.thinking ?? "", type: "thinking" };
    case "redacted_thinking":
      return { data: b.data ?? "", type: "redacted_thinking" };
    default:
      return { type: "other" };
  }
};

const onEvent = (onText: MessagesAsk["onText"]) => (r: Read, data: string): Effect.Effect<Read, EngineError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const { type } = yield* typeOf(data);
    switch (type) {
      case "message_start": {
        const { message } = yield* messageStart(data);
        r.model = message.model ?? r.model;
        r.start = message.usage ?? null;
        return r;
      }
      case "content_block_start": {
        const e = yield* blockStart(data);
        r.blocks[e.index] = blockOf(e.content_block);
        return r;
      }
      case "content_block_delta": {
        const { delta, index } = yield* blockDelta(data);
        const b = r.blocks[index];
        if (b?.type === "text" && delta.text !== undefined) {
          b.text += delta.text;
          if (onText) yield* onText(delta.text);
        }
        if (b?.type === "tool_use" && delta.partial_json !== undefined) b.json += delta.partial_json;
        if (b?.type === "thinking") {
          b.thinking += delta.thinking ?? "";
          b.signature += delta.signature ?? "";
        }
        return r;
      }
      case "message_delta": {
        const e = yield* messageDelta(data);
        r.stop = e.delta.stop_reason ?? r.stop;
        r.end = e.usage ?? r.end;
        return r;
      }
      case "message_stop":
        r.done = true;
        return r;
      case "error": {
        const { error } = yield* errorEvent(data);
        return yield* classifyAnthropic(null, error.type, error.message);
      }
      default:
        return r; // ping, content_block_stop
    }
  });

const itemOf = (b: Block): Item[] => {
  switch (b.type) {
    case "text":
      return [{ text: b.text, type: "text" }];
    case "tool_use":
      return [{ id: b.id, input: b.json || "{}", name: b.name, type: "call" }];
    case "thinking":
      return [{ block: { signature: b.signature, thinking: b.thinking, type: "thinking" }, type: "kept" }];
    case "redacted_thinking":
      return [{ block: { data: b.data, type: "redacted_thinking" }, type: "kept" }];
    case "other":
      return [];
  }
};

// message_start has the input side, message_delta the final output count (and, on newer API
// versions, the input side again); the later figure wins
const usageOf = (start: ApiUsage | null, end: ApiUsage | null) => {
  const pick = (k: "input_tokens" | "output_tokens" | "cache_creation_input_tokens" | "cache_read_input_tokens") => end?.[k] ?? start?.[k] ?? 0;
  const split = end?.cache_creation ?? start?.cache_creation;
  const cacheWrite = pick("cache_creation_input_tokens");
  return {
    usage: { cacheRead: pick("cache_read_input_tokens"), cacheWrite, input: pick("input_tokens"), output: pick("output_tokens") } satisfies Tokens,
    writes: (split ? { h1: split.ephemeral_1h_input_tokens ?? 0, m5: split.ephemeral_5m_input_tokens ?? 0 } : undefined) satisfies Writes | undefined,
  };
};

export const readMessages = (stream: Stream.Stream<Uint8Array, EngineError>, ask: MessagesAsk) =>
  Effect.gen(function* () {
    const init: Read = { blocks: [], done: false, end: null, model: ask.model, start: null, stop: null };
    const r = yield* sseFold("api-key: anthropic", stream, init, onEvent(ask.onText), (state) => state.done);
    if (r.stop === "refusal") return yield* new Refusal({ message: "api-key: anthropic refused this request (stop_reason: refusal)" });
    if (!r.done) return yield* new ModelError({ message: "api-key: anthropic: the stream ended without message_stop" });
    return { items: r.blocks.flatMap(itemOf), model: r.model, ...usageOf(r.start, r.end) } satisfies MessagesReply;
  });

// The client: `key` is the API key now, UsageLimit when there is none (the chain moves on).
export const makeMessages = (o: { readonly base: string; readonly key: Effect.Effect<string, UsageLimit> }) =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const messages: Messages = (ask) =>
      Effect.gen(function* () {
        const key = yield* o.key;
        const req = HttpClientRequest.post(`${o.base.replace(/\/$/, "")}/v1/messages`).pipe(
          HttpClientRequest.setHeaders({ "anthropic-version": VERSION, "x-api-key": key }),
          HttpClientRequest.accept("text/event-stream"),
          HttpClientRequest.bodyText(requestBody(ask), "application/json"),
        );
        const res = yield* http.execute(req);
        if (res.status !== 200) {
          const raw = yield* res.text;
          const parsed = decodeErrorBody(raw);
          return yield* parsed._tag === "Some" ? classifyAnthropic(res.status, parsed.value.error.type, parsed.value.error.message) : classifyAnthropic(res.status, undefined, raw.slice(0, 300));
        }
        return yield* readMessages(res.stream.pipe(Stream.mapError((err) => new ModelError({ message: `api-key: anthropic: ${err.message}` }))), ask);
      }).pipe(Effect.catchTag("HttpClientError", (err) => Effect.fail(new ModelError({ message: `api-key: anthropic: ${err.message}` }))));
    return messages;
  });
