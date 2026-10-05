// Anthropic's Messages API with an API key (SPEC "Engines", api-key: overflow only). One streamed
// request per call, cached as gist §8 lays it out: a breakpoint at each of the view's cuts (the
// pieces a user Item's `marks` counts; cutBlocks makes at most 3) and the top-level automatic
// `cache_control` on every request, which Anthropic puts on its last block, so each step of a
// turn (or each size retry of a compactor call) reads everything the step before it sent. That
// makes 4, Anthropic's limit. Every entry is a 5-minute one, the API's default (gist §8, checklist
// item 10; E6's 1-hour entries are the Claude subscription's). Thinking blocks come back in the
// next request exactly as they arrived, signature and all, as tool use with thinking requires.
import { Effect, Option, Schema, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { type EngineError, ModelError, Refusal, type Spent, type Tagged, UsageLimit } from "../engines/errors.ts";
import { json, sseFold, typeOf } from "../engines/sse.ts";
import { isPicture } from "../media/part.ts";
import type { ToolDef } from "../tools/files.ts";
import type { Item } from "../providers/provider.ts";
import type { Tokens } from "../usage.ts";
import { wireJson } from "../text.ts";
import type { Writes } from "./budget.ts";

export const ANTHROPIC_API = "https://api.anthropic.com";
const VERSION = "2023-06-01";
export const MAX_TOKENS = 64_000; // streamed, so a long answer doesn't time out

type Json = Schema.Json;
// a 5-minute entry, the API's default and the only one gist §8 uses
const EPHEMERAL = { type: "ephemeral" } as const;

export type MessagesAsk<E extends Tagged = never> = {
  readonly model: string;
  readonly system: string;
  readonly history: readonly Item[];
  readonly tools?: readonly ToolDef[];
  readonly toolChoice?: "auto" | "none";
  readonly maxTokens?: number;
  readonly effort?: string;
  readonly onText?: (delta: string) => Effect.Effect<void>;
  readonly onThinking?: (tokens: number) => Effect.Effect<void>; // the size of the thought so far
  readonly onItem?: (item: Item) => Effect.Effect<void, E>; // each block as it completes, in order
};
// `writes` splits the cache writes by TTL when the API says how; `stop` is the API's stop_reason
export type MessagesReply = {
  readonly items: readonly Item[];
  readonly usage: Tokens;
  readonly writes: Writes | undefined;
  readonly model: string;
  readonly stop: string | null;
};
export type Messages = <E extends Tagged = never>(ask: MessagesAsk<E>) => Effect.Effect<MessagesReply, EngineError | E>;

const decodeObject = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)));
// a tool call's input as the API wants it back: an object, {} for one cut short
const inputOf = (text: string): Json => Option.getOrElse(decodeObject(text), () => ({}));

// The conversation as Messages: user parts and tool results on the user side, text, calls and
// kept blocks on the assistant side, neighbours of one side merged into one message. A user
// message's parts that end at a view cut (its `marks`) get a breakpoint each.
export const messagesOf = (history: readonly Item[]) => {
  const out: { role: "user" | "assistant"; content: Json[] }[] = [];
  const push = (role: "user" | "assistant", blocks: readonly Json[]) => {
    if (blocks.length === 0) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else out.push({ content: [...blocks], role });
  };
  for (const item of history) {
    switch (item.type) {
      case "user": {
        const marks = item.marks ?? 0;
        const blocks: Json[] = [];
        for (const [k, part] of item.parts.entries()) {
          if (isPicture(part)) {
            blocks.push({ source: { data: part.data, media_type: part.mime, type: "base64" }, type: "image" });
            continue;
          }
          if (!part) continue; // the API refuses empty text blocks
          blocks.push(k < marks ? { cache_control: EPHEMERAL, text: part, type: "text" } : { text: part, type: "text" });
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
        if (item.provider === "anthropic") push("assistant", [item.block]);
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
  // automatic caching: a breakpoint on the request's last cacheable block (gist §8)
  cache_control: Schema.Struct({ type: Schema.Literal("ephemeral") }),
  stream: Schema.Literal(true),
});
// every string made well-formed on the way out (wireJson)
const encodeBody = (body: typeof Body.Type) => wireJson(Schema.encodeSync(Body)(body));

export const requestBody = (ask: MessagesAsk<Tagged>) => {
  const tools = ask.tools === undefined || ask.tools.length === 0 ? undefined : ask.tools;
  return encodeBody({
    cache_control: EPHEMERAL,
    max_tokens: ask.maxTokens ?? MAX_TOKENS,
    messages: messagesOf(ask.history),
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
const blockStop = json(Schema.Struct({ index: Schema.Number }));
const errorEvent = json(Schema.Struct({ error: ApiError }));
const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ error: ApiError })));

// a spent key, a rate limit, an overloaded API or a key it won't take: the chain moves on (E4)
const LIMITS = new Set(["rate_limit_error", "overloaded_error", "authentication_error", "permission_error", "billing_error"]);
export const classifyAnthropic = (status: number | null, type: string | undefined, message: string | undefined, spent?: Spent): EngineError => {
  const text = `api-key: anthropic ${[status, type, message].filter((x) => x !== null && x !== undefined && x !== "").join(" ")}`;
  const limited = status === 429 || status === 529 || status === 401 || status === 403 || (type !== undefined && LIMITS.has(type)) || /credit balance/i.test(message ?? "");
  return limited ? new UsageLimit({ message: text, spent }) : new ModelError({ message: text, spent });
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

type Hooks<E extends Tagged> = Pick<MessagesAsk<E>, "onItem" | "onText" | "onThinking">;

const onEvent =
  <E extends Tagged>(o: Hooks<E>) =>
  (r: Read, data: string): Effect.Effect<Read, E | EngineError | Schema.SchemaError> =>
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
            if (o.onText) yield* o.onText(delta.text);
          }
          if (b?.type === "tool_use" && delta.partial_json !== undefined) b.json += delta.partial_json;
          if (b?.type === "thinking") {
            b.thinking += delta.thinking ?? "";
            b.signature += delta.signature ?? "";
            if (o.onThinking && delta.thinking) yield* o.onThinking(Math.ceil(b.thinking.length / 4));
          }
          return r;
        }
        // a block is whole: it goes out now, so what follows it streams after it
        case "content_block_stop": {
          const { index } = yield* blockStop(data);
          const b = r.blocks[index];
          if (b && o.onItem) for (const item of itemOf(b)) yield* o.onItem(item);
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
          return yield* classifyAnthropic(null, error.type, error.message, spentOf(r));
        }
        default:
          return r; // ping
      }
    });

const itemOf = (b: Block): Item[] => {
  switch (b.type) {
    case "text":
      return [{ text: b.text, type: "text" }];
    case "tool_use":
      return [{ id: b.id, input: b.json || "{}", name: b.name, type: "call" }];
    case "thinking":
      return [{ block: { signature: b.signature, thinking: b.thinking, type: "thinking" }, provider: "anthropic", type: "kept" }];
    case "redacted_thinking":
      return [{ block: { data: b.data, type: "redacted_thinking" }, provider: "anthropic", type: "kept" }];
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

// what a reply that went wrong cost so far, once the API has said anything about it
const spentOf = (r: Read): Spent | undefined => (r.start === null && r.end === null ? undefined : { model: r.model, usage: usageOf(r.start, r.end).usage });

export const readMessages = <E extends Tagged = never>(stream: Stream.Stream<Uint8Array, EngineError>, ask: MessagesAsk<E>) =>
  Effect.gen(function* () {
    const init: Read = { blocks: [], done: false, end: null, model: ask.model, start: null, stop: null };
    const r = yield* sseFold<Read, E>("api-key: anthropic", stream, init, onEvent<E>(ask), (state) => state.done);
    if (r.stop === "refusal") return yield* new Refusal({ message: "api-key: anthropic refused this request (stop_reason: refusal)", spent: spentOf(r) });
    if (!r.done) return yield* new ModelError({ message: "api-key: anthropic: the stream ended without message_stop", spent: spentOf(r) });
    return { items: r.blocks.flatMap(itemOf), model: r.model, stop: r.stop, ...usageOf(r.start, r.end) } satisfies MessagesReply;
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
      }).pipe(Effect.catchIf(HttpClientError.isHttpClientError, (err) => Effect.fail(new ModelError({ message: `api-key: anthropic: ${err.message}` }))));
    return messages;
  });
