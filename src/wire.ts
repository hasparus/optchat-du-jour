// The contract between optchat-server and its clients (SPEC "Server, WebSocket API and CLI",
// "Protocol"): the session state the AG-UI events carry, the JSON of /api/*, and the small rules
// both sides read the log by. Pure schemas and helpers with no node imports, so the web UI bundles
// this same file instead of restating it.
import { Schema } from "effect";
import { Kind, Msg } from "./records.ts";

export { Kind, Msg } from "./records.ts";

// ---------------------------------------------------------------------------------------------
// the session's shared state (STATE_SNAPSHOT, STATE_DELTA)

export const Phase = Schema.Literals(["idle", "running", "waiting"]);
export type Phase = typeof Phase.Type;

export const SessionState = Schema.Struct({
  phase: Phase,
  device: Schema.String, // where the next or current turn runs
  engine: Schema.NullOr(Schema.String), // the engine of the current turn
  waiting: Schema.Number, // view lines not summarized yet
  viewBytes: Schema.Number,
  budget: Schema.Number,
  messages: Schema.Number,
  queued: Schema.Array(Schema.String), // sent mid-run, not taken by the call yet
});
export type SessionState = typeof SessionState.Type;

// ---------------------------------------------------------------------------------------------
// how log entries map to AG-UI messages (SPEC "Protocol"): a message id is the entry's log index,
// a tool call's id is `t<index>` of its tool entry

// a tool entry is "<name> <json input>" (ref §5.3)
export const splitTool = (text: string) => {
  const space = text.indexOf(" ");
  return space === -1 ? { args: "", name: text } : { args: text.slice(space + 1), name: text.slice(0, space) };
};
// splitTool's inverse, for a tool call that came as a name and its arguments
export const joinTool = (name: string, args: string) => (args === "" ? name : `${name} ${args}`);
export const toolCallId = (i: number) => `t${i}`;

// a message id or tool call id back to its log index; null for an id that isn't one
export const logIndex = (id: string): number | null => {
  const digits = /^t?(\d+)$/.exec(id)?.[1];
  return digits === undefined ? null : Number(digits);
};

// gist §3 "Addressing": node (l, i) covers the messages [i·2^l, (i+1)·2^l), named `id+n`
export const span = ({ l, i }: { readonly l: number; readonly i: number }) => {
  const n = 2 ** l;
  return { id: i * n, n };
};

// ---------------------------------------------------------------------------------------------
// /api/*

// /api/messages: log entries (records.ts Msg, with the size the server adds), oldest first
export const MessagesPage = Schema.Struct({ entries: Schema.Array(Msg), total: Schema.Number });
export type MessagesPage = typeof MessagesPage.Type;

// /api/view: each view line with its range, dates and size
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

// /api/devices
export const Device = Schema.Struct({ name: Schema.String, url: Schema.String, folders: Schema.Array(Schema.String), local: Schema.Boolean });
export type Device = typeof Device.Type;
export const Devices = Schema.Array(Device);

// /api/usage: usage.jsonl, one record per model call (E11)
export const Role = Schema.Literals(["turn", "prime", "compact", "subagent"]);
export const Engine = Schema.Literals(["claude-code", "openai-plan", "api-key"]);
export const Auth = Schema.Literals(["claude-max", "chatgpt-pro", "api-key"]);

export const Tokens = Schema.Struct({
  input: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  output: Schema.Number,
});
export type Tokens = typeof Tokens.Type;

export const UsageRecord = Schema.Struct({
  date: Schema.String,
  role: Role,
  engine: Engine,
  auth: Auth,
  model: Schema.NullOr(Schema.String),
  device: Schema.NullOr(Schema.String),
  level: Schema.NullOr(Schema.Number),
  usage: Tokens,
  cold: Schema.Boolean,
  attempt: Schema.Number,
  failoverFrom: Schema.NullOr(Schema.String),
  ms: Schema.Number,
  dollars: Schema.optional(Schema.Number),
});
export type UsageRecord = typeof UsageRecord.Type;
export const Usage = Schema.Array(UsageRecord);
