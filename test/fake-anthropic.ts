// A stand-in for Anthropic's Messages API (POST /v1/messages, streamed), on a free port: it checks
// the key, keeps every request body, refuses with a 400 what the real API refuses about cache
// breakpoints (more than 4, the top-level automatic `cache_control` counting as one; a 1-hour
// entry after a 5-minute one), and answers from a script with an optional thinking block, text,
// tool calls and text after them, in that order, with the stop reason it is given (else tool_use
// or end_turn), or an HTTP error. No model.
import { Schema } from "effect";

export type AnthropicAnswer =
  | {
      readonly text?: string;
      readonly thinking?: string;
      readonly calls?: readonly { readonly name: string; readonly input: unknown }[];
      readonly after?: string;
      readonly stop?: string;
    }
  | { readonly status: number; readonly errorType: string };

type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
const sse = (event: { readonly type: string; readonly [key: string]: Json }) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

// what every reply reports: 100 fresh input tokens, 500 read, 3000 written (2000 for 5 min, 1000 for 1 h), 50 out
export const USAGE = {
  cache_creation: { ephemeral_1h_input_tokens: 1000, ephemeral_5m_input_tokens: 2000 },
  cache_creation_input_tokens: 3000,
  cache_read_input_tokens: 500,
  input_tokens: 100,
  output_tokens: 1,
};

// the parts of a request body that can hold a cache breakpoint
const Mark = Schema.optional(Schema.Struct({ ttl: Schema.optional(Schema.String) }));
const Marked = Schema.Struct({ cache_control: Mark });
const decodeMarks = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      tools: Schema.optional(Schema.Array(Marked)),
      system: Schema.optional(Schema.Array(Marked)),
      messages: Schema.optional(Schema.Array(Schema.Struct({ content: Schema.Array(Marked) }))),
      cache_control: Mark,
    }),
  ),
);
// what the real API answers a request with too many breakpoints or misordered TTLs, or null when
// it takes it: the breakpoints in prompt order (tools, system, messages), then the automatic one
// at its end, each by its TTL
const cacheRefusal = (raw: string) => {
  const body = decodeMarks(raw);
  const blocks = [...(body.tools ?? []), ...(body.system ?? []), ...(body.messages ?? []).flatMap((m) => m.content)];
  const ttls = [...blocks, body].flatMap((b) => (b.cache_control ? [b.cache_control.ttl ?? "5m"] : []));
  if (ttls.length > 4) return `A maximum of 4 blocks with cache_control may be provided. Found ${ttls.length}.`;
  if (ttls.some((t, k) => t === "1h" && ttls.slice(0, k).includes("5m"))) return "a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block";
  return null;
};

export type FakeAnthropicState = { readonly headers: Headers[]; script: AnthropicAnswer[]; readonly seen: string[] };

export function fakeAnthropic(key: string) {
  const state: FakeAnthropicState = { headers: [], script: [], seen: [] };
  const server = Bun.serve({
    fetch: async (req) => {
      if (new URL(req.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 });
      if (req.headers.get("x-api-key") !== key) return Response.json({ error: { message: "invalid x-api-key", type: "authentication_error" }, type: "error" }, { status: 401 });
      const raw = await req.text();
      state.seen.push(raw);
      state.headers.push(req.headers);
      const refused = cacheRefusal(raw);
      if (refused !== null) return Response.json({ error: { message: refused, type: "invalid_request_error" }, type: "error" }, { status: 400 });
      const answer = state.script.shift() ?? { text: "ok" };
      if ("status" in answer) return Response.json({ error: { message: "no", type: answer.errorType }, type: "error" }, { status: answer.status });
      const blocks: { readonly start: Json; readonly deltas: readonly Json[] }[] = [
        ...(answer.thinking === undefined
          ? []
          : [{ deltas: [{ thinking: answer.thinking, type: "thinking_delta" }, { signature: `sig-${state.seen.length}`, type: "signature_delta" }], start: { signature: "", thinking: "", type: "thinking" } }]),
        ...(answer.text === undefined ? [] : [{ deltas: [{ text: answer.text, type: "text_delta" }], start: { text: "", type: "text" } }]),
        ...(answer.calls ?? []).map((c, k) => ({
          deltas: [{ partial_json: JSON.stringify(c.input), type: "input_json_delta" }],
          start: { id: `toolu_${state.seen.length}_${k}`, input: {}, name: c.name, type: "tool_use" },
        })),
        ...(answer.after === undefined ? [] : [{ deltas: [{ text: answer.after, type: "text_delta" }], start: { text: "", type: "text" } }]),
      ];
      const events = [
        sse({ message: { content: [], model: "fake-opus", role: "assistant", usage: USAGE }, type: "message_start" }),
        ...blocks.flatMap((b, index) => [
          sse({ content_block: b.start, index, type: "content_block_start" }),
          ...b.deltas.map((delta) => sse({ delta, index, type: "content_block_delta" })),
          sse({ index, type: "content_block_stop" }),
        ]),
        sse({ delta: { stop_reason: answer.stop ?? (answer.calls?.length ? "tool_use" : "end_turn") }, type: "message_delta", usage: { output_tokens: 50 } }),
        sse({ type: "message_stop" }),
      ];
      return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return { base: `http://127.0.0.1:${server.port ?? 0}`, server, state };
}
