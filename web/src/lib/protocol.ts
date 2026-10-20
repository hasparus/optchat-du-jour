// What /ws carries (SPEC "Protocol", E15): the AG-UI events server/agui.ts writes, decoded here at
// the boundary, and the frames a client sends. The state they carry and the JSON of /api/* are
// the server's own schemas (src/wire.ts, imported as @wire), not a copy.
import { EventType } from "@ag-ui/core";
import { ArtifactDraft, ArtifactVersion, Asset, type FollowUp, Received } from "@wire";
import { Option, Schema } from "effect";

const ToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});

// An echo whose tool failed (E28): server/agui.ts puts `metadata: {error: true}` on its tool
// message and its TOOL_CALL_RESULT. Other keys of AG-UI's open metadata are ignored, and `error` is
// taken as any value, read as failed only when it is `true` (log.ts): a malformed one never costs
// the frame its message.
const ToolMetadata = Schema.Struct({ error: Schema.optional(Schema.Unknown) });

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
  Schema.Struct({
    id: Schema.String,
    role: Schema.Literal("tool"),
    content: Schema.String,
    toolCallId: Schema.String,
    metadata: Schema.optional(ToolMetadata),
  }),
]);
export type Message = typeof Message.Type;

// A JSON Patch operation. The server sends only top-level "replace" and "remove" ops (server/agui.ts
// delta), but the op is decoded as any string, so an op this client doesn't know costs that op (the
// session store logs and skips it), not the whole frame.
const Patch = Schema.Struct({ op: Schema.String, path: Schema.String, value: Schema.optional(Schema.Json) });
export type Patch = typeof Patch.Type;

// The log's window a MESSAGES_SNAPSHOT is the newest part of (E42): entries [from, to); the frame
// holds those of them that fit in its bytes, from its first message's index up, and the client reads
// the others from /api/messages. A server from before it sends none: the frame is the whole window.
const SnapshotWindow = Schema.Struct({ from: Schema.Number, to: Schema.Number });

export const Inbound = Schema.Union([
  Schema.Struct({ type: Schema.Literal(EventType.MESSAGES_SNAPSHOT), messages: Schema.Array(Message), metadata: Schema.optional(SnapshotWindow) }),
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
    metadata: Schema.optional(ToolMetadata),
  }),
  // A turn's thinking (SPEC "Reasoning"): a reasoning message `r<index>` per piece, opened, streamed
  // and ended; REASONING_END's metadata says which entry it was kept before (`i`, after `ms`, with
  // `cut` characters left out) or that it was `dropped`. Each key is optional, so a server that
  // sends less, or more, still decodes.
  Schema.Struct({ type: Schema.Literal(EventType.REASONING_START), messageId: Schema.String }),
  Schema.Struct({ type: Schema.Literal(EventType.REASONING_MESSAGE_START), messageId: Schema.String, role: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal(EventType.REASONING_MESSAGE_CONTENT), messageId: Schema.String, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal(EventType.REASONING_MESSAGE_END), messageId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal(EventType.REASONING_END),
    messageId: Schema.String,
    metadata: Schema.optional(
      Schema.Struct({ i: Schema.optional(Schema.Number), ms: Schema.optional(Schema.Number), cut: Schema.optional(Schema.Number), dropped: Schema.optional(Schema.Boolean) }),
    ),
  }),
  // A subagent's run (SPEC M7a) began, ended with its report, or ended without one (failed, or
  // stopped). The app follows subagents by the state's `subagents` list; these are read so they
  // aren't dropped as unknown, and so a card can read its side log again when its run ends.
  Schema.Struct({ type: Schema.Literal(EventType.SUBAGENT_STARTED), subagentRunId: Schema.String, name: Schema.String, description: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal(EventType.SUBAGENT_FINISHED), subagentRunId: Schema.String, result: Schema.optional(Schema.Unknown) }),
  Schema.Struct({ type: Schema.Literal(EventType.SUBAGENT_ERROR), subagentRunId: Schema.String, message: Schema.String, code: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal(EventType.CUSTOM), name: Schema.Literal("info"), value: Schema.String }),
  Schema.Struct({ type: Schema.Literal(EventType.CUSTOM), name: Schema.Literal("thinking"), value: Schema.Struct({ tokens: Schema.Number }) }),
  Schema.Struct({ type: Schema.Literal(EventType.CUSTOM), name: Schema.Literal("usage"), value: Schema.Json }),
  // what became of a message a client sent: logged (`messageId`, its log index) or not (`error`)
  Schema.Struct({
    type: Schema.Literal(EventType.CUSTOM),
    name: Schema.Literal("ack"),
    value: Schema.Struct({ clientId: Schema.String, messageId: Schema.NullOr(Schema.String), error: Schema.NullOr(Schema.String) }),
  }),
  // the server got an action this client sent, by its id (E41): done now, or a repeat it answers
  // as it stands (a message logged, held, taken back) and doesn't do again
  Schema.Struct({ type: Schema.Literal(EventType.CUSTOM), name: Schema.Literal("received"), value: Received }),
  // An artifact's live draft while the model writes a publish or an edit (SPEC "Artifacts")
  Schema.Struct({ type: Schema.Literal(EventType.CUSTOM), name: Schema.Literal("artifact-draft"), value: ArtifactDraft }),
  // a version of an artifact was saved
  Schema.Struct({ type: Schema.Literal(EventType.CUSTOM), name: Schema.Literal("artifact"), value: Schema.Struct({ name: Schema.String, version: ArtifactVersion }) }),
  // a held message a client took back: its text and attachments again (`text` null and `error`
  // set when it was too late)
  Schema.Struct({
    type: Schema.Literal(EventType.CUSTOM),
    name: Schema.Literal("taken-back"),
    value: Schema.Struct({ clientId: Schema.String, error: Schema.NullOr(Schema.String), text: Schema.NullOr(Schema.String), media: Schema.Array(Asset) }),
  }),
]);
export type Inbound = typeof Inbound.Type;

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(Inbound));
export const parseFrame = (frame: string): Option.Option<Inbound> => decodeFrame(frame);

// an uploaded attachment, as a message names it (SPEC "Media")
export type AttachmentRef = { readonly sha: string; readonly kind: "image" | "video"; readonly mime: string };

// A user message's content: its text, or with attachments AG-UI's parts, the text and then an
// image or video part per attachment whose source is "asset:<sha256>" (PUT /api/assets stored it)
const contentOf = (text: string, attachments: readonly AttachmentRef[]) =>
  attachments.length === 0
    ? text
    : [{ text, type: "text" }, ...attachments.map((a) => ({ source: { mimeType: a.mime, type: "url", value: `asset:${a.sha}` }, type: a.kind }))];

// A message's forwardedProps: the `device` and the `engine` of the master's chain it is for, and
// `followUp` when it asks for the other behavior than the session's. An unset one is left out.
export type Forwarded = { readonly device?: string; readonly engine?: string; readonly followUp?: FollowUp };

// What a client sends (server/routes/ws.ts Inbound): AG-UI's RunAgentInput, whose user message
// (with its id, which the server acks) is the one to answer, with its forwardedProps and its
// uploaded `attachments`; or an action (below). Its id is its message's: the server answers it once.
export const runInput = (text: string, id: string, { attachments = [], ...forwardedProps }: Forwarded & { readonly attachments?: readonly AttachmentRef[] } = {}) =>
  JSON.stringify({
    context: [],
    forwardedProps,
    messages: [{ content: contentOf(text, attachments), id, role: "user" }],
    runId: crypto.randomUUID(),
    state: {},
    threadId: "web",
    tools: [],
  });
export type Settings = { readonly followUp?: FollowUp };
// A subagent card's action (SPEC M7a, server/routes/ws.ts): a message to it, its stop, the model of
// its next call. What goes wrong comes back as an `info` to this client.
export type SubagentAction =
  | { readonly type: "tell"; readonly name: string; readonly text: string }
  | { readonly type: "stop-subagent"; readonly name: string }
  | { readonly type: "subagent-model"; readonly name: string; readonly model: string };
// Every other action: a Stop, Background work's Stop all (the turn and every running subagent), the
// resume of a turn waiting for a model, a take-back of a held message, a change to the session's
// settings, a card's. A Stop, a Stop all and a resume name the run of the turn loop this page saw
// (the state's `loop`, E41), so one the link sends again after a reconnect never stops or settles
// a later turn.
export type Action =
  | { readonly type: "abort" | "stop-all"; readonly loop: number }
  | { readonly type: "resume"; readonly engine: string; readonly loop: number }
  | { readonly type: "take-back"; readonly clientId: string }
  | ({ readonly type: "settings" } & Settings)
  | SubagentAction;
// an action with the id the server answers it by (E41)
export const actionFrame = (action: Action, id: string) => JSON.stringify({ ...action, id });
