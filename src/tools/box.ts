// A turn's tools on an engine with its own loop (SPEC "Engines", tools on non-Claude engines; M5):
// the read-only file tools of the turn's device, zoom and date answered from memory on the server,
// and spawn and tell (SPEC "Subagents"), as /mcp answers them for claude (E8). Write tools are not
// offered in M5. A subagent's box offers the same list (the cached prefix), its spawn and tell its
// own (E38).
import { Effect, Option, Schema } from "effect";
import { type AgentTools, memoryTool, noAgents, TOOLS } from "../mcp.ts";
import type { Mem } from "../tree.ts";
import { type FileTools, type ToolDef, type ToolOutput, fileToolDefs, toolError, toolOk } from "./files.ts";

// a device's tools for one turn; `run` answers every call with text, errors included and flagged
export type ToolBox = { readonly defs: readonly ToolDef[]; readonly run: (name: string, input: string) => Effect.Effect<ToolOutput> };

const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

// what a turn on `device` is offered: its file tools, then zoom and date. Compactions on the same
// engine are offered these too, and call none (docs/optchat.md §4, §5).
export const toolDefs = (o: { readonly device: string; readonly folders: readonly string[] }): ToolDef[] => [
  ...fileToolDefs(o),
  ...TOOLS.map((t) => ({ description: t.description, name: t.name, parameters: t.inputSchema })),
];

const decodeArgs = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json));

export const toolBox = (o: { readonly device: string; readonly folders: readonly string[]; readonly files: FileTools; readonly mem: Mem; readonly agents?: AgentTools }): ToolBox => ({
  defs: toolDefs(o),
  run: (name, input) => {
    const args = decodeInput(input);
    if (Option.isNone(args)) return Effect.succeed(toolError(`Error: the input of ${name} is not JSON`));
    const agents = o.agents ?? noAgents;
    if (name === "spawn" || name === "tell") {
      const fields = decodeArgs(args.value);
      if (Option.isNone(fields)) return Effect.succeed(toolError(`Error: the input of ${name} is not an object`));
      return agents.call(name, fields.value).pipe(Effect.map(({ error, text }) => (error ? toolError(text) : toolOk(text))));
    }
    // zoom and date answer as /mcp does, never with isError: "No line …" is an answer
    const answer = memoryTool(o.mem, name, args.value, agents);
    return answer === null ? o.files(name, args.value) : Effect.succeed(toolOk(answer));
  },
});
