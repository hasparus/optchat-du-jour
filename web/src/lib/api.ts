// The read-only JSON of /api/* (SPEC "Server, WebSocket API and CLI"), decoded at the boundary with
// the server's own schemas (src/wire.ts).
import { Devices, MessagesPage, NodeView, ReasoningHeads, ReasoningPiece, SubagentLog, Usage, View } from "@wire";
import { Schema } from "effect";

async function get<S extends Schema.Top & { readonly DecodingServices: never }>(path: string, schema: S): Promise<S["Type"]> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return Schema.decodeUnknownPromise(schema)(await res.json());
}

export const api = {
  // log entries before message `before`, oldest first
  messages: async (before: number, limit = 100) => get(`/api/messages?before=${before}&limit=${limit}`, MessagesPage),
  // the thinking kept before entries from..to-1, without its text; and one piece's text, null when
  // the server has none for it (SPEC "Reasoning")
  reasoning: async (from: number, to: number) => {
    const { pieces } = await get(`/api/reasoning?from=${from}&to=${to}`, ReasoningHeads);
    return pieces;
  },
  reasoningText: async (i: number) => {
    const res = await fetch(`/api/reasoning/text?i=${i}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`/api/reasoning/text: ${res.status} ${res.statusText}`);
    return Schema.decodeUnknownPromise(ReasoningPiece)(await res.json());
  },
  view: async () => get("/api/view", View),
  node: async (l: number, i: number) => get(`/api/node?l=${l}&i=${i}`, NodeView),
  usage: async () => get("/api/usage", Usage),
  devices: async () => get("/api/devices", Devices),
  // a subagent and its side log from entry `from` on (SPEC M7a)
  subagent: async (name: string, from = 0) => get(`/api/subagent?name=${encodeURIComponent(name)}&from=${from}`, SubagentLog),
};
