// The read-only JSON of /api/* (SPEC "Server, WebSocket API and CLI"), decoded at the boundary with
// the server's own schemas (src/wire.ts).
import { Devices, MessagesPage, NodeView, Usage, View } from "@wire";
import { Schema } from "effect";

async function get<S extends Schema.Top & { readonly DecodingServices: never }>(path: string, schema: S): Promise<S["Type"]> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
  return Schema.decodeUnknownPromise(schema)(await res.json());
}

export const api = {
  // log entries before message `before`, oldest first
  messages: async (before: number, limit = 100) => get(`/api/messages?before=${before}&limit=${limit}`, MessagesPage),
  view: async () => get("/api/view", View),
  node: async (l: number, i: number) => get(`/api/node?l=${l}&i=${i}`, NodeView),
  usage: async () => get("/api/usage", Usage),
  devices: async () => get("/api/devices", Devices),
};
