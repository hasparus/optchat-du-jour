// zoom and date as the model reaches them: JSON-RPC over the /mcp handler (gist §7.1, ref §9, E8).
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { handleMcp, mcpConfig } from "../src/mcp.ts";
import { newMsg } from "../src/store.ts";
import { type Mem, newMem } from "../src/tree.ts";
import { addMessage, addNode } from "../src/view.ts";

const at = (minute: number) => new Date(2026, 9, 4, 14, minute); // local time, as date() answers

// six messages; the first four summarized up to one line, 4+2 not merged yet
function memory(): Mem {
  const mem = newMem();
  const texts = [
    ["user", "fix the importer\nit skips notes"],
    ["talk", "looking"],
    ["tool", 'Bash {"command":"ls"}'],
    ["echo", "src test"],
    ["user", "thanks"],
    ["talk", "done"],
  ] as const;
  for (const [i, [kind, text]] of texts.entries()) addMessage(mem, newMsg(i, kind, text, at(i)));
  for (let i = 0; i < 6; i++) addNode(mem, { i, l: 0, text: `line ${i}` });
  addNode(mem, { i: 0, l: 1, text: "user: fix the importer;\ntalk: looking" });
  addNode(mem, { i: 1, l: 1, text: "tool: ls; echo: src test" });
  addNode(mem, { i: 0, l: 2, text: "user asked to fix the importer; listed src" });
  return mem;
}

const Response = Schema.fromJsonString(
  Schema.Struct({ error: Schema.optional(Schema.Struct({ code: Schema.Number })), id: Schema.Number, result: Schema.optional(Schema.Json) }),
);
const ToolResult = Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) });
const ToolList = Schema.Struct({ tools: Schema.Array(Schema.Struct({ description: Schema.String, name: Schema.String })) });

let next = 0;
const rpc = (mem: Mem, method: string, params?: Schema.Json) => {
  const reply = handleMcp(mem, JSON.stringify({ id: ++next, jsonrpc: "2.0", method, params }));
  expect(reply.status).toBe(200);
  return Schema.decodeUnknownSync(Response)(reply.body);
};
const callTool = (mem: Mem, name: string, args: Record<string, Schema.Json>) =>
  Schema.decodeUnknownSync(ToolResult)(rpc(mem, "tools/call", { arguments: args, name }).result).content[0]?.text;

test("zoom and date over JSON-RPC: the handshake, the verbatim tools, a zoom down to a message, and lines that don't exist", () => {
  const mem = memory();
  const init = rpc(mem, "initialize", { capabilities: {}, clientInfo: { name: "claude-code" }, protocolVersion: "2025-03-26" });
  expect(init.result).toMatchObject({ capabilities: { tools: {} }, protocolVersion: "2025-03-26", serverInfo: { name: "optchat" } });
  expect(handleMcp(mem, JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toEqual({ body: null, status: 202 });
  expect(rpc(mem, "ping").result).toEqual({});

  const { tools } = Schema.decodeUnknownSync(ToolList)(rpc(mem, "tools/list").result);
  expect(tools.map((t) => [t.name, t.description])).toEqual([
    ["zoom", "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole."],
    ["date", "The date and time of message id."],
  ]);

  // from the view's 0+4 down to message 0, newlines flattened on the way and kept at the end
  expect(callTool(mem, "zoom", { id: 0, n: 4 })).toBe("0+2|user: fix the importer; talk: looking\n2+2|tool: ls; echo: src test");
  expect(callTool(mem, "zoom", { id: 0, n: 2 })).toBe("0+1|line 0\n1+1|line 1");
  expect(callTool(mem, "zoom", { id: 0, n: 1 })).toBe("0+0|user: fix the importer\nit skips notes");
  expect(callTool(mem, "zoom", { id: 5, n: 1 })).toBe("5+0|talk: done");

  const nowhere: [Schema.Json, Schema.Json, string][] = [
    [1, 2, "No line 1+2."], // not aligned
    [0, 3, "No line 0+3."], // not a power of 2
    [4, 4, "No line 4+4."], // past the end
    [4, 2, "No line 4+2."], // not built yet
    [6, 1, "No line 6+1."], // no such message
    [-2, 2, "No line -2+2."],
    [2 ** 52, 2 ** 52, `No line ${2 ** 52}+${2 ** 52}.`], // past what the kernel takes
    [0.5, 1, "No line 0.5+1."],
    ["0", 1, 'No line "0"+1.'], // not an integer either
  ];
  for (const [id, n, answer] of nowhere) expect(callTool(mem, "zoom", { id, n })).toBe(answer);

  expect(callTool(mem, "date", { id: 3 })).toBe("2026-10-04 14:03");
  expect(callTool(mem, "date", { id: 6 })).toBe("No message 6.");

  expect(rpc(mem, "resources/list").error?.code).toBe(-32_601);
  expect(handleMcp(mem, "{not json").status).toBe(400);
  expect(JSON.parse(mcpConfig("http://127.0.0.1:7700/mcp?key=k"))).toEqual({
    mcpServers: { optchat: { type: "http", url: "http://127.0.0.1:7700/mcp?key=k" } },
  });
});
