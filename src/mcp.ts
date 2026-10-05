// zoom and date (gist §7.1, ref §9) as an MCP server over HTTP (E8): one JSON-RPC message per
// POST, answered from the server's memory. It only reads; the lock stays with the chat.
import { Option, Schema } from "effect";
import { address } from "./kernel.ts";
import { children, getNode, label, localTime, type Mem } from "./tree.ts";
import { flat } from "./view.ts";

// The descriptions are the gist's, word for word; the input schemas carry no descriptions (ref §9).
export const TOOLS = [
  {
    description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    inputSchema: {
      properties: { id: { type: "integer" }, n: { type: "integer" } },
      required: ["id", "n"],
      type: "object",
    },
    name: "zoom",
  },
  {
    description: "The date and time of message id.",
    inputSchema: { properties: { id: { type: "integer" } }, required: ["id"], type: "object" },
    name: "date",
  },
] as const;

// what the model asked for, shown back as it was written
const shown = (x: Schema.Json | undefined) => (x === undefined ? "undefined" : JSON.stringify(x));
const noLine = (id: number | string, n: number | string) => `No line ${id}+${n}.`;

// Line id+n opened into its two halves, or for n = 1 the message itself, whole. A merge that is
// not built yet is no line at all; a single message always opens, since the view tells the model
// to zoom a line that has no summary yet.
export function zoom(mem: Mem, id: number, n: number): string {
  const c = address(id, n, mem.root.length);
  if (!c) return noLine(id, n);
  if (c.l === 0) {
    const m = mem.root[id];
    return m ? `${id}+0|${m.kind}: ${m.text}` : noLine(id, n);
  }
  if (!getNode(mem, c)) return noLine(id, n);
  const [left, right] = children(c).map((h) => ({ at: h, node: getNode(mem, h) }));
  // a parent is only built after its children: a missing half is a broken tree
  if (!left?.node || !right?.node) return noLine(id, n);
  return `${label(left.at)}|${flat(left.node.text)}\n${label(right.at)}|${flat(right.node.text)}`;
}

// the local date and time of message id, "YYYY-MM-DD HH:MM"
export function date(mem: Mem, id: number): string {
  const m = Number.isSafeInteger(id) && id >= 0 ? mem.root[id] : undefined;
  return m ? localTime(m.date) : `No message ${id}.`;
}

// JSON-RPC 2.0, the subset Claude Code uses: initialize, ping, tools/list, tools/call.

const Id = Schema.Union([Schema.String, Schema.Number, Schema.Null]);
type Id = typeof Id.Type;
const Request = Schema.Struct({
  id: Schema.optional(Id),
  jsonrpc: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Json),
});
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Request));

const Initialize = Schema.Struct({ protocolVersion: Schema.optional(Schema.String) });
const decodeInitialize = Schema.decodeUnknownOption(Initialize);
const Call = Schema.Struct({ arguments: Schema.optional(Schema.Record(Schema.String, Schema.Json)), name: Schema.String });
const decodeCall = Schema.decodeUnknownOption(Call);
// zoom and date take integers; zoom() and date() check the rest
const decodeZoom = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Number, n: Schema.Number }));
const decodeDate = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Number }));

// what the server says it speaks when the client names no version
const FALLBACK_PROTOCOL = "2025-06-18";

type Reply = { readonly status: number; readonly body: string | null };
type ToolResult = { readonly content: readonly { readonly type: "text"; readonly text: string }[]; readonly isError?: true };

type Initialized = {
  readonly capabilities: { readonly tools: Record<string, never> };
  readonly protocolVersion: string;
  readonly serverInfo: { readonly name: string; readonly version: string };
};
type Result = Initialized | ToolResult | { readonly tools: typeof TOOLS } | Record<string, never>;

const respond = (id: Id, result: Result): Reply => ({ body: JSON.stringify({ id, jsonrpc: "2.0", result }), status: 200 });
const failure = (id: Id, code: number, message: string, status = 200): Reply => ({
  body: JSON.stringify({ error: { code, message }, id, jsonrpc: "2.0" }),
  status,
});
const answer = (text: string): ToolResult => ({ content: [{ text, type: "text" }] });
const refuse = (text: string): ToolResult => ({ content: [{ text, type: "text" }], isError: true });

function call(mem: Mem, params: Schema.Json | undefined): ToolResult {
  const found = decodeCall(params);
  if (Option.isNone(found)) return refuse("tools/call needs a tool name.");
  const { arguments: args = {}, name } = found.value;
  switch (name) {
    case "zoom":
      return answer(
        Option.match(decodeZoom(args), {
          onNone: () => noLine(shown(args.id), shown(args.n)),
          onSome: ({ id, n }) => zoom(mem, id, n),
        }),
      );
    case "date":
      return answer(
        Option.match(decodeDate(args), {
          onNone: () => `No message ${shown(args.id)}.`,
          onSome: ({ id }) => date(mem, id),
        }),
      );
    default:
      return refuse(`There is no tool named ${name}.`);
  }
}

// zoom and date for an engine with its own tool loop (M5): the same answers, run on the server
// from memory. The text the tool returns, or null for a tool that isn't one of these.
export const MEMORY_TOOLS: readonly string[] = TOOLS.map((t) => t.name);
export const memoryTool = (mem: Mem, name: string, args: Schema.Json): string | null =>
  MEMORY_TOOLS.includes(name) ? (call(mem, { arguments: args, name }).content[0]?.text ?? "") : null;

// One POSTed message in, the HTTP status and body out. A notification (no id) or a client's
// response gets 202 and no body, as MCP's HTTP transport asks.
export function handleMcp(mem: Mem, body: string): Reply {
  const found = decodeRequest(body);
  if (Option.isNone(found)) return failure(null, -32_700, "Parse error: one JSON-RPC message per request", 400);
  const { id, method, params } = found.value;
  if (id === undefined || method === undefined) return { body: null, status: 202 };
  switch (method) {
    case "initialize": {
      const asked = Option.getOrUndefined(decodeInitialize(params ?? {}))?.protocolVersion;
      return respond(id, {
        capabilities: { tools: {} },
        protocolVersion: asked ?? FALLBACK_PROTOCOL,
        serverInfo: { name: "optchat", version: "1.0.0" },
      });
    }
    case "ping":
      return respond(id, {});
    case "tools/list":
      return respond(id, { tools: TOOLS });
    case "tools/call":
      return respond(id, call(mem, params));
    default:
      return failure(id, -32_601, `Method not found: ${method}`);
  }
}

// The --mcp-config JSON. Built once per device and passed to the turn and the priming call alike:
// it is part of the cached tool list, and the name `optchat` makes the tools mcp__optchat__*.
export const mcpConfig = (url: string) => JSON.stringify({ mcpServers: { optchat: { type: "http", url } } });
