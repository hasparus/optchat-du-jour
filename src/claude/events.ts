// The stream-json events of `claude -p` that optchat reads (ref §5.3), as Schemas. A line that
// matches none of them is an event we don't use, and is dropped.
import { Option, Schema } from "effect";

export const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
});
export type Usage = typeof Usage.Type;

const McpServer = Schema.Struct({ name: Schema.String, status: Schema.String });

export const Init = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  model: Schema.optional(Schema.String),
  mcp_servers: Schema.optional(Schema.Array(McpServer)),
});

const TextDelta = Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String });
const ThinkingDelta = Schema.Struct({
  type: Schema.Literal("thinking_delta"),
  thinking: Schema.optional(Schema.String),
  estimated_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
});

const MessageStart = Schema.Struct({
  type: Schema.Literal("message_start"),
  message: Schema.Struct({ model: Schema.optional(Schema.String), usage: Schema.optional(Usage) }),
});
const BlockDelta = Schema.Struct({ type: Schema.Literal("content_block_delta"), delta: Schema.Union([TextDelta, ThinkingDelta]) });

export const StreamEvent = Schema.Struct({
  type: Schema.Literal("stream_event"),
  event: Schema.Union([MessageStart, BlockDelta]),
});

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const ThinkingBlock = Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.optional(Schema.String) });
const ToolUseBlock = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.optional(Schema.String),
  name: Schema.String,
  input: Schema.Json,
});
const OtherBlock = Schema.Struct({ type: Schema.String });

// `model` is "<synthetic>" on a message Claude Code wrote itself rather than the model: how it
// reports an API error (a spent plan, an overload) just before the error result
export const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  message: Schema.Struct({
    model: Schema.optional(Schema.String),
    content: Schema.Array(Schema.Union([TextBlock, ThinkingBlock, ToolUseBlock, OtherBlock])),
  }),
});
export const SYNTHETIC = "<synthetic>";

const ResultPart = Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) });
const ToolResultBlock = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ResultPart)])),
});

export const User = Schema.Struct({
  type: Schema.Literal("user"),
  isReplay: Schema.optional(Schema.Boolean),
  message: Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(Schema.Union([ToolResultBlock, OtherBlock]))]) }),
});

export const Result = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.optional(Schema.String),
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.String),
  stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
  usage: Schema.optional(Usage),
  duration_ms: Schema.optional(Schema.Number),
});
export type Result = typeof Result.Type;

export const Event = Schema.Union([Init, StreamEvent, Assistant, User, Result]);
export type Event = typeof Event.Type;

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Event));
export const parseEvent = (line: string): Option.Option<Event> => (line.trim() ? decodeLine(line) : Option.none());

// a content block for a user message (ref §5.1): text, with an optional cache mark (E6 sets the
// TTL), or an image (SPEC "Media"). The image block's shape is the one the SDK's streaming-input
// docs show and claude 2.1.289's own input schema takes: a base64 source with its media type.
export type Block =
  | {
      readonly type: "text";
      readonly text: string;
      readonly cache_control?: { readonly type: "ephemeral"; readonly ttl?: "1h" | "5m" };
    }
  | { readonly type: "image"; readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string } };
export type TextBlock = Extract<Block, { readonly type: "text" }>;
