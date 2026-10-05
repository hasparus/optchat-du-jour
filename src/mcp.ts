// zoom and date (gist §7.1, ref §9) as an MCP server over HTTP (E8), answered from the server's
// memory; it never takes the lock. JSON-RPC requests in, JSON responses out (MCP's streamable HTTP
// transport allows a plain JSON reply), no sessions, no server-sent events.
import { Option, Schema } from "effect";
import { address } from "./kernel.ts";
import { type Mem, getNode, localTime, msgText } from "./tree.ts";
import { flat } from "./view.ts";

// the gist's tool descriptions, verbatim; no property descriptions (ref §9)
export const TOOLS = [
  {
    description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
    inputSchema: { properties: { id: { type: "integer" }, n: { type: "integer" } }, required: ["id", "n"], type: "object" },
    name: "zoom",
  },
  {
    description: "The date and time of message id.",
    inputSchema: { properties: { id: { type: "integer" } }, required: ["id"], type: "object" },
    name: "date",
  },
];

const label = (id: unknown, n: unknown) => `No line ${String(id)}+${String(n)}.`;

export function zoom(mem: Mem, id: number, n: number): string {
  const c = address(id, n, mem.root.length);
  if (!c) return label(id, n);
  const m = mem.root[c.i];
  if (c.l === 0) return m ? `${id}+0|${msgText(m)}` : label(id, n); // whole, newlines kept; built or not
  const [a, b] = [getNode(mem, c.l - 1, 2 * c.i), getNode(mem, c.l - 1, 2 * c.i + 1)];
  if (!getNode(mem, c.l, c.i) || !a || !b) return label(id, n);
  const half = n / 2;
  return `${id}+${half}|${flat(a.text)}\n${id + half}+${half}|${flat(b.text)}`;
}

export const date = (mem: Mem, id: number) => {
  const m = Number.isSafeInteger(id) && id >= 0 ? mem.root[id] : undefined;
  return m ? localTime(m.date) : `No message ${id}.`;
};

const Request = Schema.Struct({
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
  method: Schema.String,
  params: Schema.optional(
    Schema.Struct({
      arguments: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.Number), n: Schema.optional(Schema.Number) })),
      name: Schema.optional(Schema.String),
      protocolVersion: Schema.optional(Schema.String),
    }),
  ),
});
const decodeRequest = Schema.decodeUnknownOption(Schema.fromJsonString(Request));

type Reply = { readonly status: number; readonly body: string | null };
const json = (id: string | number | null, payload: object): Reply => ({ body: JSON.stringify({ id, jsonrpc: "2.0", ...payload }), status: 200 });

// one JSON-RPC message in, the HTTP answer out; a notification gets 202 and no body
export function handleMcp(mem: Mem, body: string): Reply {
  const parsed = decodeRequest(body);
  if (Option.isNone(parsed)) return json(null, { error: { code: -32_700, message: "parse error" } });
  const req = parsed.value;
  if (req.id === undefined) return { body: null, status: 202 };
  const id = req.id;
  switch (req.method) {
    case "initialize":
      return json(id, {
        result: {
          capabilities: { tools: {} },
          protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
          serverInfo: { name: "optchat", version: "1" },
        },
      });
    case "ping":
      return json(id, { result: {} });
    case "tools/list":
      return json(id, { result: { tools: TOOLS } });
    case "tools/call": {
      const args = req.params?.arguments;
      const text =
        req.params?.name === "zoom"
          ? zoom(mem, args?.id ?? Number.NaN, args?.n ?? Number.NaN)
          : req.params?.name === "date"
            ? date(mem, args?.id ?? Number.NaN)
            : null;
      if (text === null) return json(id, { result: { content: [{ text: `unknown tool ${String(req.params?.name)}`, type: "text" }], isError: true } });
      return json(id, { result: { content: [{ text, type: "text" }] } });
    }
    default:
      return json(id, { error: { code: -32_601, message: `method not found: ${req.method}` } });
  }
}

// the --mcp-config every claude gets: generated once per device, identical for priming and turns.
// The server name stays `optchat`, so the tools are mcp__optchat__zoom and mcp__optchat__date
// everywhere; only the URL differs, and the URL is not sent to the model.
export const mcpConfig = (url: string) => JSON.stringify({ mcpServers: { optchat: { type: "http", url } } });
