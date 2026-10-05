// What /ws carries (SPEC "Protocol", E15): the AG-UI events server/agui.ts writes, decoded here at
// the boundary, and the two frames a client sends. The state they carry and the JSON of /api/* are
// the server's own schemas (src/wire.ts, imported as @wire), not a copy.
import { EventType } from "@ag-ui/core";
import { Option, Schema } from "effect";

const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});

// server/agui.ts toMessages: user and note entries are user messages (a note is named "note"),
// talk and tool entries assistant messages, echo entries tool messages
export const Message = Schema.Union([
  Schema.Struct({ id: Schema.String, role: Schema.Literal("user"), content: Schema.String, name: Schema.optional(Schema.String) }),
  Schema.Struct({
    id: Schema.String,
    role: Schema.Literal("assistant"),
    content: Schema.optional(Schema.String),
    toolCalls: Schema.optional(Schema.Array(ToolCall)),
  }),
  Schema.Struct({ id: Schema.String, role: Schema.Literal("tool"), content: Schema.String, toolCallId: Schema.String }),
]);
export type Message = typeof Message.Type;

// A JSON Patch operation. The server sends only top-level "replace" ops (server/agui.ts delta), but
// the op is decoded as any string, so an op this client doesn't know costs that op (the session
// store logs and skips it), not the whole frame.
const Patch = Schema.Struct({ op: Schema.String, path: Schema.String, value: Schema.optional(Schema.Json) });
export type Patch = typeof Patch.Type;

export const Inbound = Schema.Union([
  Schema.Struct({ type: Schema.Literal(EventType.MESSAGES_SNAPSHOT), messages: Schema.Array(Message) }),
  Schema.Struct({ type: Schema.Literal(EventType.STATE_SNAPSHOT), snapshot: Schema.Record(Schema.String, Schema.Json) }),
  Schema.Struct({ type: Schema.Literal(EventType.STATE_DELTA), delta: Schema.Array(Patch) }),
  Schema.Struct({ type: Schema.Literal(EventType.RUN_STARTED), threadId: Schema.String, runId: Schema.String }),
  Schema.Struct({ type: Schema.Literal(EventType.RUN_FINISHED), threadId: Schema.String, runId: Schema.String }),
  Schema.Struct({ type: Schema.Literal(EventType.RUN_ERROR), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal(EventType.TEXT_MESSAGE_START),
    messageId: Schema.String,
    role: Schema.Literals(["user", "assistant"]),
  }),
  Schema.Struct({ type: Schema.Literal(EventType.TEXT_MESSAGE_CONTENT), messageId: Schema.String, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal(EventType.TEXT_MESSAGE_END), messageId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal(EventType.TOOL_CALL_START),
    toolCallId: Schema.String,
    toolCallName: Schema.String,
    parentMessageId: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal(EventType.TOOL_CALL_ARGS), toolCallId: Schema.String, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal(EventType.TOOL_CALL_END), toolCallId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal(EventType.TOOL_CALL_RESULT),
    messageId: Schema.String,
    toolCallId: Schema.String,
    content: Schema.String,
    role: Schema.optional(Schema.Literal("tool")),
  }),
  Schema.Struct({ type: Schema.Literal(EventType.CUSTOM), name: Schema.Literal("info"), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal(EventType.CUSTOM), name: Schema.Literal("thinking"), value: Schema.Struct({ tokens: Schema.Number }) }),
  Schema.Struct({ type: Schema.Literal(EventType.CUSTOM), name: Schema.Literal("usage"), value: Schema.Json }),
  // what became of a message a client sent: logged (`messageId`, its log index) or not (`error`)
  Schema.Struct({
    type: Schema.Literal(EventType.CUSTOM),
    name: Schema.Literal("ack"),
    value: Schema.Struct({ clientId: Schema.String, messageId: Schema.NullOr(Schema.String), error: Schema.NullOr(Schema.String) }),
  }),
]);
export type Inbound = typeof Inbound.Type;

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(Inbound));
export const parseFrame = (frame: string): Option.Option<Inbound> => decodeFrame(frame);

// What a client sends: AG-UI's RunAgentInput, whose user message (with its id, which the server
// acks) is the one to answer, and an abort (server/app.ts Inbound)
export const runInput = (text: string, device: string | null, id: string) =>
  JSON.stringify({
    context: [],
    forwardedProps: device ? { device } : {},
    messages: [{ content: text, id, role: "user" }],
    runId: crypto.randomUUID(),
    state: {},
    threadId: "web",
    tools: [],
  });
export const ABORT = JSON.stringify({ type: "abort" });
