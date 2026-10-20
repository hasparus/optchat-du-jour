// The read-only JSON of /api/* (SPEC "Server, WebSocket API and CLI"), decoded at the boundary with
// the server's own schemas (src/wire.ts).
import { ArtifactList, Devices, MemoryChildren, MemoryPage, MessagesPage, ReasoningHeads, ReasoningPiece, SubagentLog, Usage } from "@wire";
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
  // the memory view (E46, E47): its lines before `before` (none: the newest), and node (l, i) opened
  // `depth` levels down, its descendants from the `from`-th
  memoryView: async (before: number | null, limit: number) => get(`/api/memory/view?${before === null ? "" : `before=${before}&`}limit=${limit}`, MemoryPage),
  memoryChildren: async (l: number, i: number, depth = 1, from = 0, limit = 100) => get(`/api/memory/children?l=${l}&i=${i}&depth=${depth}&from=${from}&limit=${limit}`, MemoryChildren),
  usage: async () => get("/api/usage", Usage),
  devices: async () => get("/api/devices", Devices),
  // a subagent and its side log from entry `from` on, `limit` entries at most (SPEC M7a)
  // every artifact and its versions (SPEC "Artifacts")
  artifacts: async () => {
    const { artifacts } = await get("/api/artifacts", ArtifactList);
    return artifacts;
  },
  subagent: async (name: string, from = 0, limit = 100) => get(`/api/subagent?name=${encodeURIComponent(name)}&from=${from}&limit=${limit}`, SubagentLog),
};
