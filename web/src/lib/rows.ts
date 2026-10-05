// The chat as rows (SPEC "Web UI", Chat): `user` and `talk` entries are messages, a `note` a user
// message marked as such, a `tool` entry and the `echo` answering it one tool row. Every row is
// keyed by the log index it starts at, so a row keeps its key (and a tool row its open state) from
// the first streamed event to the snapshot that confirms it.
import { splitTool } from "@wire";
import type { Item } from "./log.ts";

export type Row =
  | { readonly kind: "user" | "note" | "talk"; readonly key: string; readonly id: number; readonly text: string }
  | { readonly kind: "tool"; readonly key: string; readonly id: number; readonly name: string; readonly args: string; readonly output: string | null };

type ToolRow = Extract<Row, { kind: "tool" }>;

// An echo answers the nearest tool call before it that has no answer yet, as server/agui.ts pairs
// them (a mid-run message can come between); one with none, or across a hole, stands alone.
export function entryRows(entries: readonly Pick<Item, "i" | "kind" | "text">[]): Row[] {
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
        out.push({ id: e.i, key, kind: "tool", output: null, ...splitTool(e.text) });
        break;
      case "echo": {
        const tool = open === null ? undefined : out[open];
        if (open !== null && tool?.kind === "tool") out[open] = { ...tool, output: e.text } satisfies ToolRow;
        else out.push({ args: "", id: e.i, key, kind: "tool", name: "output", output: e.text });
        open = null;
        break;
      }
    }
  }
  return out;
}

// the row to scroll to for log index i: the last one starting at or before it
export const rowFor = (rows: readonly Row[], i: number) => rows.findLast((r) => r.id <= i) ?? rows[0];
