// A turn's tools on an engine with its own loop (SPEC "Engines", tools on non-Claude engines; M5):
// the read-only file tools of the turn's device, and zoom and date answered from memory on the
// server, as /mcp answers them for claude (E8). Write tools are not offered in M5.
import { Effect, Option, Schema } from "effect";
import { memoryTool, TOOLS } from "../mcp.ts";
import type { Mem } from "../tree.ts";
import type { ToolBox } from "../turn/loop.ts";
import { type FileTools, fileToolDefs } from "./files.ts";

const decodeInput = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json));

export const toolBox = (o: { readonly device: string; readonly folders: readonly string[]; readonly files: FileTools; readonly mem: Mem }): ToolBox => ({
  defs: [...fileToolDefs(o), ...TOOLS.map((t) => ({ description: t.description, name: t.name, parameters: t.inputSchema }))],
  run: (name, input) => {
    const args = decodeInput(input);
    if (Option.isNone(args)) return Effect.succeed(`Error: the input of ${name} is not JSON`);
    const answer = memoryTool(o.mem, name, args.value);
    return answer === null ? o.files(name, args.value) : Effect.succeed(answer);
  },
});
