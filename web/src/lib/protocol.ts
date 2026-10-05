// What the server sends and accepts (SPEC "Protocol", E15; "Server, WebSocket API and CLI"): the
// AG-UI events of /ws as server/agui.ts writes them, the session state they carry, and the JSON of
// /api/*. Every frame and response is decoded here, at the boundary; anything else is dropped.
import { EventType } from "@ag-ui/core";
import { Option, Schema } from "effect";

export const Phase = Schema.Literals(["idle", "priming", "running", "waiting"]);
export type Phase = typeof Phase.Type;

// src/session.ts SessionState
export const SessionState = Schema.Struct({
  phase: Phase,
  device: Schema.String,
  engine: Schema.NullOr(Schema.String),
  waiting: Schema.Number,
  viewBytes: Schema.Number,
  budget: Schema.Number,
  messages: Schema.Number,
  queued: Schema.Array(Schema.String),
});
export type SessionState = typeof SessionState.Type;

const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});

// server/agui.ts toMessages: user and note entries are user messages, talk and tool entries
// assistant messages, echo entries tool messages
const Message = Schema.Union([
  Schema.Struct({ id: Schema.String, role: Schema.Literal("user"), content: Schema.String, name: Schema.optional(Schema.String) }),
  Schema.Struct({
    id: Schema.String,
    role: Schema.Literal("assistant"),
    content: Schema.optional(Schema.String),
    toolCalls: Schema.optional(Schema.mutable(Schema.Array(ToolCall))),
  }),
  Schema.Struct({ id: Schema.String, role: Schema.Literal("tool"), content: Schema.String, toolCallId: Schema.String }),
]);

const Patch = Schema.Struct({ op: Schema.Literal("replace"), path: Schema.String, value: Schema.Json });

export const Inbound = Schema.Union([
  Schema.Struct({ type: Schema.Literal(EventType.MESSAGES_SNAPSHOT), messages: Schema.mutable(Schema.Array(Message)) }),
  Schema.Struct({ type: Schema.Literal(EventType.STATE_SNAPSHOT), snapshot: Schema.Record(Schema.String, Schema.Json) }),
  Schema.Struct({ type: Schema.Literal(EventType.STATE_DELTA), delta: Schema.mutable(Schema.Array(Patch)) }),
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
]);
export type Inbound = typeof Inbound.Type;

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(Inbound));
export const parseFrame = (frame: string): Option.Option<Inbound> => decodeFrame(frame);
export const parseState = Schema.decodeUnknownOption(SessionState);

// What a client sends: AG-UI's RunAgentInput, whose newest user message is the one to answer, and
// an abort (server/app.ts Inbound)
export const runInput = (text: string, device: string | null) =>
  JSON.stringify({
    context: [],
    forwardedProps: device ? { device } : {},
    messages: [{ content: text, id: crypto.randomUUID(), role: "user" }],
    runId: crypto.randomUUID(),
    state: {},
    threadId: "web",
    tools: [],
  });
export const ABORT = JSON.stringify({ type: "abort" });

// ---------------------------------------------------------------------------------------------
// /api/*

export const Kind = Schema.Literals(["user", "talk", "tool", "echo", "note"]);
export type Kind = typeof Kind.Type;

// src/records.ts Msg, with the size the server adds
export const Entry = Schema.Struct({
  i: Schema.Number,
  kind: Kind,
  text: Schema.String,
  date: Schema.String,
  device: Schema.optional(Schema.String),
});
export type Entry = typeof Entry.Type;

export const MessagesPage = Schema.Struct({ entries: Schema.Array(Entry), total: Schema.Number });
export type MessagesPage = typeof MessagesPage.Type;

export const ViewLine = Schema.Struct({
  built: Schema.Boolean,
  from: Schema.NullOr(Schema.String),
  to: Schema.NullOr(Schema.String),
  id: Schema.Number,
  n: Schema.Number,
  l: Schema.Number,
  i: Schema.Number,
  size: Schema.NullOr(Schema.Number),
  text: Schema.String,
});
export type ViewLine = typeof ViewLine.Type;

export const View = Schema.Struct({ budget: Schema.Number, lines: Schema.Array(ViewLine), size: Schema.Number });
export type View = typeof View.Type;

// /api/node: a message (level 0), or a node and its two children
export const NodeView = Schema.Union([
  Schema.Struct({ l: Schema.Literal(0), i: Schema.Number, id: Schema.Number, n: Schema.Number, kind: Kind, text: Schema.String, date: Schema.String }),
  Schema.Struct({
    l: Schema.Number,
    i: Schema.Number,
    id: Schema.Number,
    n: Schema.Number,
    text: Schema.NullOr(Schema.String),
    children: Schema.Array(Schema.Struct({ built: Schema.Boolean, l: Schema.Number, i: Schema.Number, text: Schema.NullOr(Schema.String) })),
  }),
]);
export type NodeView = typeof NodeView.Type;

// src/usage.ts UsageRecord (E11)
export const UsageRecord = Schema.Struct({
  date: Schema.String,
  role: Schema.Literals(["turn", "prime", "compact", "subagent"]),
  engine: Schema.Literals(["claude-code", "openai-plan", "api-key"]),
  auth: Schema.String,
  model: Schema.NullOr(Schema.String),
  device: Schema.NullOr(Schema.String),
  level: Schema.NullOr(Schema.Number),
  usage: Schema.Struct({ input: Schema.Number, cacheRead: Schema.Number, cacheWrite: Schema.Number, output: Schema.Number }),
  cold: Schema.Boolean,
  attempt: Schema.Number,
  failoverFrom: Schema.NullOr(Schema.String),
  ms: Schema.Number,
  dollars: Schema.optional(Schema.Number),
});
export type UsageRecord = typeof UsageRecord.Type;
export const Usage = Schema.Array(UsageRecord);

export const Device = Schema.Struct({ name: Schema.String, url: Schema.String, folders: Schema.Array(Schema.String), local: Schema.Boolean });
export type Device = typeof Device.Type;
export const Devices = Schema.Array(Device);
