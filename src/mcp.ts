// zoom and date (docs/optchat.md §6, ref §9) as an MCP server (E8): one JSON-RPC message per WebSocket
// frame, or per POST over HTTP, answered from the server's memory. It only reads; the lock stays
// with the chat.
import { Effect, Option, Schema } from "effect";
import type { McpTransport } from "./config.ts";
import { address } from "./kernel.ts";
import { wireJson } from "./text.ts";
import { type Built, children, type Coord, type Entry, getNode, label, localTime, type Mem } from "./tree.ts";
import { flat } from "./view.ts";

// zoom's and date's descriptions are docs/optchat.md §6's, word for word; the input schemas carry
// no descriptions (ref §9). zoom's id may also be a subagent's name (docs/optchat.md §5's
// zoom("Name"), SPEC M7a), which the system prompt explains; spawn and tell are the earlier gist's
// (§9), ours in words. Nothing here changes from call to call: the list is part of every cached prefix.
export const TOOLS = [
  {
    description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    inputSchema: {
      properties: { id: { type: ["integer", "string"] }, n: { type: "integer" } },
      required: ["id"],
      type: "object",
    },
    name: "zoom",
  },
  {
    description: "The date and time of message id.",
    inputSchema: { properties: { id: { type: "integer" } }, required: ["id"], type: "object" },
    name: "date",
  },
  {
    description:
      'Start a subagent called name on task, in the background, and return at once. It has your tools and works directly in folder (your own folder when left out) on device (yours when left out); isolate: true gives it a git worktree of its own instead, on branch optchat/name, merged back into the folder\'s branch when it ends. Its report reaches you as a message starting "[name] ". model: an engine:model@effort ref of your chain; yours when left out.',
    inputSchema: {
      properties: {
        device: { type: "string" },
        folder: { type: "string" },
        isolate: { type: "boolean" },
        model: { type: "string" },
        name: { type: "string" },
        task: { type: "string" },
      },
      required: ["name", "task"],
      type: "object",
    },
    name: "spawn",
  },
  {
    description: "Send text to the subagent called name: a running one reads it between its tool calls; one that has ended starts again with it.",
    inputSchema: { properties: { name: { type: "string" }, text: { type: "string" } }, required: ["name", "text"], type: "object" },
    name: "tell",
  },
] as const;

// What the tools that reach subagents (SPEC "Subagents") need: zoom("Name", from) reads a side log
// from memory, at once; spawn and tell go to the supervisor (src/subagents.ts). `error`: the answer
// is a refusal (an unknown model, the cap, a name taken, a folder that can't be isolated), which the
// model reads as a tool error.
export type AgentTools = {
  readonly zoom: (name: string, from: number) => string;
  readonly call: (tool: "spawn" | "tell", args: Readonly<Record<string, Schema.Json>>) => Effect.Effect<{ readonly text: string; readonly error: boolean }>;
};
// who calls the tools that reach subagents: the master (a turn), or the subagent so named (E38),
// known by the /mcp key its claude was given or by the tool box its call was given
export type Caller = "master" | { readonly agent: string };

// a server without subagents (tests, the CLI's local commands): a name opens nothing, spawn and tell refuse
export const noAgents: AgentTools = {
  call: (tool) => Effect.succeed({ error: true, text: `${tool}: there are no subagents here.` }),
  zoom: (name) => `No subagent ${name}.`,
};

// what the model asked for, shown back as it was written
const shown = (x: Schema.Json | undefined) => (x === undefined ? "undefined" : JSON.stringify(x));
const noLine = (id: number | string, n: number | string) => `No line ${id}+${n}.`;

// Node id+n of the tree, opened: for n = 1 the message, else the node (if built) and its two halves.
// Null when there is no such node in a chat of this length (address() decides, docs/optchat.md §6).
export type Opened =
  | { readonly at: Coord; readonly message: Entry }
  | { readonly at: Coord; readonly node: Built | undefined; readonly halves: readonly { readonly at: Coord; readonly node: Built | undefined }[] };
export function openNode(mem: Mem, id: number, n: number): Opened | null {
  const at = address(id, n, mem.root.length);
  if (!at) return null;
  if (at.l > 0) return { at, halves: children(at).map((h) => ({ at: h, node: getNode(mem, h) })), node: getNode(mem, at) };
  const message = mem.root[id];
  return message ? { at, message } : null;
}

// Line id+n opened into its two halves, or for n = 1 the message itself, whole. A merge that is
// not built yet is no line at all; a single message always opens, since the view tells the model
// to zoom a line that has no summary yet.
export function zoom(mem: Mem, id: number, n: number): string {
  const found = openNode(mem, id, n);
  if (!found) return noLine(id, n);
  if ("message" in found) return `${id}+0|${found.message.kind}: ${found.message.text}`;
  const [left, right] = found.halves;
  // a parent is only built after its children: a missing half is a broken tree
  if (!found.node || !left?.node || !right?.node) return noLine(id, n);
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
// zoom and date take integers; zoom() and date() check the rest. zoom("Name") and zoom("Name", n)
// open a subagent's side log, from its entry n on.
const decodeZoom = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Number, n: Schema.Number }));
// A subagent's name (SPEC M7a): a letter, then up to 31 letters, digits, "-" or "_": a folder name
// on every system, and one that can't end a report's "[Name] " early. Any other string is no name.
export const SUBAGENT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const decodeAgentZoom = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String.check(Schema.isPattern(SUBAGENT_NAME)), n: Schema.optional(Schema.Number) }));
const decodeDate = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.Number }));

// what the server says it speaks when the client names no version
const FALLBACK_PROTOCOL = "2025-06-18";

type Reply = { readonly status: number; readonly body: string | null };
// a block of a tool's result: text, or an image the model can look at (MCP's ImageContent)
export type Content = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string };
type ToolResult = { readonly content: readonly Content[]; readonly isError?: true };
// the pictures of a message's attachments, from its marker lines (SPEC "Media")
export type Attached = (text: string) => readonly Content[];
// for a server with no media service (tests): a message has no pictures
export const noAttached: Attached = () => [];

type Initialized = {
  readonly capabilities: { readonly tools: Record<string, never> };
  readonly protocolVersion: string;
  readonly serverInfo: { readonly name: string; readonly version: string };
};
type Result = Initialized | ToolResult | { readonly tools: typeof TOOLS } | Record<string, never>;

// a tool's answer goes to the model with its strings made well-formed (wireJson)
const respond = (id: Id, result: Result): Reply => ({ body: wireJson({ id, jsonrpc: "2.0", result }), status: 200 });
const failure = (id: Id, code: number, message: string, status = 200): Reply => ({
  body: JSON.stringify({ error: { code, message }, id, jsonrpc: "2.0" }),
  status,
});
const answer = (text: string): ToolResult => ({ content: [{ text, type: "text" }] });
const refuse = (text: string): ToolResult => ({ content: [{ text, type: "text" }], isError: true });

// zoom(id, 1) on a message with attachments answers with their pictures after its text, so the
// model can look again at what it was sent (SPEC "Media"); the tool's schema is the same
function zoomed(mem: Mem, id: number, n: number, attached: Attached): ToolResult {
  const text = answer(zoom(mem, id, n));
  const found = n === 1 ? openNode(mem, id, n) : null;
  if (!found || !("message" in found) || found.message.kind !== "user") return text;
  return { content: [...text.content, ...attached(found.message.text)] };
}

function call(mem: Mem, params: Schema.Json | undefined, attached: Attached, agents: AgentTools): ToolResult {
  const found = decodeCall(params);
  if (Option.isNone(found)) return refuse("tools/call needs a tool name.");
  const { arguments: args = {}, name } = found.value;
  switch (name) {
    case "zoom": {
      const named = decodeAgentZoom(args);
      if (Option.isSome(named)) return answer(agents.zoom(named.value.id, named.value.n ?? 0));
      return Option.match(decodeZoom(args), {
        onNone: () => answer(noLine(shown(args.id), shown(args.n))),
        onSome: ({ id, n }) => zoomed(mem, id, n, attached),
      });
    }
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
// from memory, with no pictures (function-call outputs with images are not wired). The text the
// tool returns, or null for a tool that isn't one of these.
export const MEMORY_TOOLS: readonly string[] = ["zoom", "date"];
export const memoryTool = (mem: Mem, name: string, args: Schema.Json, agents: AgentTools = noAgents): string | null =>
  MEMORY_TOOLS.includes(name) ? call(mem, { arguments: args, name }, noAttached, agents).content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n") : null;

// One message in (a POST's body or a WebSocket frame), the HTTP status and body out. A
// notification (no id) or a client's response gets 202 and no body, as MCP's HTTP transport asks;
// over a WebSocket, no frame.
export function handleMcp(mem: Mem, body: string, attached: Attached, agents: AgentTools = noAgents): Reply {
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
        serverInfo: { name: "optchat", version: "0.1.0" },
      });
    }
    case "ping":
      return respond(id, {});
    case "tools/list":
      return respond(id, { tools: TOOLS });
    case "tools/call":
      return respond(id, call(mem, params, attached, agents));
    default:
      return failure(id, -32_601, `Method not found: ${method}`);
  }
}

// handleMcp, with spawn and tell (SPEC "Subagents"), which go to the supervisor and so take an effect;
// every other message is answered as handleMcp answers it.
export const answerMcp = (mem: Mem, body: string, attached: Attached, agents: AgentTools = noAgents): Effect.Effect<Reply> => {
  const found = decodeRequest(body);
  if (Option.isNone(found) || found.value.id === undefined || found.value.method !== "tools/call") return Effect.succeed(handleMcp(mem, body, attached, agents));
  const { id, params } = found.value;
  const tool = decodeCall(params);
  if (Option.isNone(tool) || (tool.value.name !== "spawn" && tool.value.name !== "tell")) return Effect.succeed(handleMcp(mem, body, attached, agents));
  return agents.call(tool.value.name, tool.value.arguments ?? {}).pipe(Effect.map(({ error, text }) => respond(id, error ? refuse(text) : answer(text))));
};

// The --mcp-config JSON for `url`, the http(s) URL of /mcp with its key; over "ws" the same URL
// as ws(s). Passed to the turn and the priming call alike: the name `optchat` makes the tools
// mcp__optchat__*, and the transport is not part of what the model is sent, so the cache doesn't
// care which one it is.
export const mcpConfig = (url: string, transport: McpTransport = "ws") =>
  JSON.stringify({ mcpServers: { optchat: { type: transport, url: transport === "ws" ? url.replace(/^http/, "ws") : url } } });

// What a claude showed of the MCP server optchat: the status its system/init gives it ("not
// listed" when init leaves it out), or, when it ended before any init, why it ended.
export type McpSeen = { readonly status: string } | { readonly ended: string };

// Claude Code checks --mcp-config as it starts and ends before system/init on a config it rejects,
// saying "Error: Invalid MCP configuration:" and the path of each entry at fault: ours only when
// that names mcpServers.optchat
const REJECTED = /Invalid MCP configuration[\s\S]*\bmcpServers\.optchat\b/;

// The transport per device: `preferred` until a claude there shows that ws does not work for it;
// that device then uses http from the next call on, and the user is told once. While on ws, it
// shows when init lists optchat as failed, or not at all (2.1.289 skips an entry of a type it
// doesn't know, with a warning), when claude ends before init with its config rejected, or when it
// ends before init twice in a row for any reason. "pending" and "needs-auth" are not: they say
// nothing about the type. `seen` is true when it moved the device to http.
export const mcpTransports = (preferred: McpTransport, report: (message: string) => Effect.Effect<void>) => {
  const fellBack = new Set<string>();
  const early = new Map<string, number>(); // claude ended before init, in a row, per device
  const of = (device: string): McpTransport => (fellBack.has(device) ? "http" : preferred);
  const verdict = (device: string, s: McpSeen) => {
    if ("status" in s) {
      early.delete(device);
      return s.status === "failed" || s.status === "not listed" ? `MCP server optchat is ${s.status}` : null;
    }
    const n = (early.get(device) ?? 0) + 1;
    early.set(device, n);
    if (REJECTED.test(s.ended)) return `its MCP config was rejected: ${s.ended}`;
    return n >= 2 ? `it ended twice in a row before starting: ${s.ended}` : null;
  };
  const seen = (device: string, s: McpSeen): Effect.Effect<boolean> =>
    Effect.suspend(() => {
      if (of(device) !== "ws") return Effect.succeed(false); // over http, the turn's own notice says it
      const why = verdict(device, s);
      if (why === null) return Effect.succeed(false);
      fellBack.add(device);
      return report(`zoom and date over WebSocket did not work for claude on ${device} (${why}); trying HTTP there from now on`).pipe(Effect.as(true));
    });
  return { of, seen };
};
