// The chat as rows (SPEC "Web UI", Chat): `user` and `talk` entries are messages, a `note` a user
// message marked as such, a `tool` entry and the `echo` after it one tool row. Rows come from two
// places: useChat's messages (the snapshot window and the live turn) and older pages of
// /api/messages. Every row carries the log index it starts at, for scrolling to a message.
import type { UIMessage } from "@tanstack/ai-client";
import type { Entry } from "./protocol.ts";

export type Row =
  | { readonly kind: "user" | "note" | "talk"; readonly key: string; readonly id: number; readonly text: string }
  | { readonly kind: "tool"; readonly key: string; readonly id: number; readonly name: string; readonly args: string; readonly output: string | null };

// a tool entry is "<name> <json input>" (server/agui.ts splitTool)
export const splitTool = (text: string) => {
  const space = text.indexOf(" ");
  return space === -1 ? { args: "", name: text } : { args: text.slice(space + 1), name: text.slice(0, space) };
};

export function entryRows(entries: readonly Entry[]): Row[] {
  const out: Row[] = [];
  for (const e of entries) {
    const key = `e${e.i}`;
    switch (e.kind) {
      case "user":
      case "note":
      case "talk":
        out.push({ id: e.i, key, kind: e.kind, text: e.text });
        break;
      case "tool":
        out.push({ id: e.i, key, kind: "tool", output: null, ...splitTool(e.text) });
        break;
      case "echo": {
        const last = out.at(-1);
        if (last?.kind === "tool" && last.output === null) out[out.length - 1] = { ...last, output: e.text };
        else out.push({ args: "", id: e.i, key, kind: "tool", name: "output", output: e.text });
        break;
      }
    }
  }
  return out;
}

const text = (parts: UIMessage["parts"]) => parts.map((p) => (p.type === "text" ? p.content : "")).join("");

export function messageRows(messages: readonly UIMessage[]): Row[] {
  const out: Row[] = [];
  for (const m of messages) {
    const id = Number(m.id);
    if (!Number.isInteger(id)) continue; // not from the log
    if (m.role === "user") {
      out.push({ id, key: `m${m.id}`, kind: m.name === "note" ? "note" : "user", text: text(m.parts) });
      continue;
    }
    const results = new Map<string, string>();
    for (const p of m.parts) if (p.type === "tool-result") results.set(p.toolCallId, Array.isArray(p.content) ? "" : p.content);
    for (const [j, p] of m.parts.entries()) {
      const key = `m${m.id}.${j}`;
      if (p.type === "text" && p.content) out.push({ id, key, kind: "talk", text: p.content });
      if (p.type === "tool-call") out.push({ args: p.arguments, id, key, kind: "tool", name: p.name, output: results.get(p.id) ?? null });
    }
  }
  return out;
}

// older pages first, then the live window; an older row the window also holds is dropped
export function mergeRows(older: readonly Row[], live: readonly Row[]): Row[] {
  const first = live[0]?.id ?? Number.POSITIVE_INFINITY;
  return [...older.filter((r) => r.id < first), ...live];
}

// the row to scroll to for log index i: the last one starting at or before it
export const rowFor = (rows: readonly Row[], i: number) => rows.findLast((r) => r.id <= i) ?? rows[0];
