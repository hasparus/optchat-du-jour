// The chat as rows (SPEC "Web UI", Chat): `user` and `talk` entries are messages, a `note` a user
// message marked as such, a `tool` entry and the `echo` answering it one tool row. Every row is
// keyed by the log index it starts at, so a row keeps its key (and a tool row its open state) from
// the first streamed event to the snapshot that confirms it.
import { splitTool } from "@wire";
import { Option, Schema } from "effect";
import { type Draft, draftItem, type Item, withDraft } from "./log.ts";

export type Row =
  | { readonly kind: "user" | "note" | "talk"; readonly key: string; readonly id: number; readonly text: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly id: number;
      readonly name: string;
      readonly args: string;
      readonly output: string | null;
      // the echo is flagged: the tool said it failed (E28)
      readonly failed: boolean;
    };

type ToolRow = Extract<Row, { kind: "tool" }>;

// An echo answers the nearest tool call before it that has no answer yet, as server/agui.ts pairs
// them (a mid-run message can come between); one with none, or across a hole, stands alone.
export function entryRows(entries: readonly Pick<Item, "error" | "i" | "kind" | "text">[]): Row[] {
  const out: Row[] = [];
  let open: number | null = null; // where in `out` the unanswered tool row is
  let prev: number | null = null;
  for (const e of entries) {
    if (prev !== null && e.i !== prev + 1) open = null;
    prev = e.i;
    const key = `e${e.i}`;
    switch (e.kind) {
      case "user":
      case "note":
      case "talk":
        out.push({ id: e.i, key, kind: e.kind, text: e.text });
        break;
      case "tool":
        open = out.length;
        out.push({ failed: false, id: e.i, key, kind: "tool", output: null, ...splitTool(e.text) });
        break;
      case "echo": {
        const tool = open === null ? undefined : out[open];
        const failed = e.error === true;
        if (open !== null && tool?.kind === "tool") out[open] = { ...tool, failed, output: e.text } satisfies ToolRow;
        else out.push({ args: "", failed, id: e.i, key, kind: "tool", name: "output", output: e.text });
        open = null;
        break;
      }
    }
  }
  return out;
}

// The rows with the draft streaming after them. `base` is entryRows(items), which a streamed token
// doesn't change: the draft is one row more, unless it rewrites an entry already held.
export function chatRows(items: readonly Item[], base: readonly Row[], draft: Draft | null): readonly Row[] {
  if (!draft) return base;
  if (draft.i > (items.at(-1)?.i ?? -1)) return [...base, ...entryRows([draftItem(draft)])];
  return entryRows(withDraft(items, draft));
}

// the index in `rows` of the last row starting at or before log index i; -1 when i is above all
export function rowIndexFor(rows: readonly Row[], i: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((rows[mid]?.id ?? 0) <= i) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

// the row to scroll to for log index i: the last one starting at or before it
export const rowFor = (rows: readonly Row[], i: number) => rows.findLast((r) => r.id <= i) ?? rows[0];

// ---- how a tool row reads (components/ai-elements/tool.tsx draws it) ----

// running: no echo yet and the turn goes on; done: the echo is in; ended: the turn ended without
// one; error: the echo is flagged failed
export type ToolState = "running" | "done" | "ended" | "error";

export const TOOL_STATE_LABELS = {
  done: "Completed",
  ended: "No output",
  error: "Failed",
  running: "Running",
} satisfies Record<ToolState, string>;

// A tool row's state: `busy` is whether a turn runs or waits, `last` whether this is the newest
// tool row (only the newest can still be running). Failed comes from the echo's flag alone (SPEC
// "Web UI", E28), never from what the output says: an echo logged without one, including every
// echo from before the flag existed, reads as done.
export const toolStateOf = (row: Pick<ToolRow, "failed" | "output">, busy: boolean, last: boolean): ToolState =>
  row.output === null ? (busy && last ? "running" : "ended") : row.failed ? "error" : "done";

// an MCP tool comes as mcp__<server>__<name>; the row names it by <name>
export const toolName = (name: string) => name.split("__").at(-1) ?? name;

const oneLine = (s: string, max = 120) => {
  const flat = s.replaceAll(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// What a tool was called on, for its one line: the command, the file, the pattern or the address
// when the input names one, a memory node as `id+n`, a todo list by its length, else the input
// itself on one line. The input as logged is under the line, open.
const Text = Schema.optional(Schema.String);
const ToolInputFields = Schema.Struct({
  command: Text,
  description: Text,
  file_path: Text,
  id: Schema.optional(Schema.Number),
  n: Schema.optional(Schema.Number),
  notebook_path: Text,
  path: Text,
  pattern: Text,
  prompt: Text,
  query: Text,
  todos: Schema.optional(Schema.Array(Schema.Unknown)),
  url: Text,
});
const decodeToolInput = Schema.decodeUnknownOption(Schema.fromJsonString(ToolInputFields));

export const toolSummary = (args: string): string =>
  Option.match(decodeToolInput(args), {
    onNone: () => oneLine(args),
    onSome: (input) => {
      if (input.id !== undefined && input.n !== undefined) return `${input.id}+${input.n}`;
      const named = [input.command, input.file_path, input.notebook_path, input.pattern, input.url, input.query, input.path, input.description, input.prompt].find(
        (v) => v !== undefined && v.trim() !== "",
      );
      if (named !== undefined) return oneLine(named);
      if (input.todos !== undefined) return `${input.todos.length} items`;
      return oneLine(args);
    },
  });
