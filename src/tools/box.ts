// A turn's tools on an engine with its own loop (SPEC "Engines", tools on non-Claude engines; M5):
// the read-only file tools of the turn's device, and zoom and date answered from memory on the
// server, as /mcp answers them for claude (E8). Write tools are not offered in M5.
import { Effect, Option, Schema } from "effect";
import { memoryTool, TOOLS } from "../mcp.ts";
import type { Mem } from "../tree.ts";
import { type FileTools, type ToolDef, fileToolDefs } from "./files.ts";

// a device's tools for one turn; `run` answers every call with text, errors included
export type ToolBox = { readonly defs: readonly ToolDef[]; readonly run: (name: string, input: string) => Effect.Effect<string> };

const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

// what a turn on `device` is offered: its file tools, then zoom and date. Compactions on the same
// engine are offered these too, and call none (docs/optchat.md §4, §5).
export const toolDefs = (o: { readonly device: string; readonly folders: readonly string[] }): ToolDef[] => [
  ...fileToolDefs(o),
  ...TOOLS.map((t) => ({ description: t.description, name: t.name, parameters: t.inputSchema })),
];

export const toolBox = (o: { readonly device: string; readonly folders: readonly string[]; readonly files: FileTools; readonly mem: Mem }): ToolBox => ({
  defs: toolDefs(o),
  run: (name, input) => {
    const args = decodeInput(input);
    if (Option.isNone(args)) return Effect.succeed(`Error: the input of ${name} is not JSON`);
    const answer = memoryTool(o.mem, name, args.value);
    return answer === null ? o.files(name, args.value) : Effect.succeed(answer);
  },
});
