// A stand-in for Anthropic's Messages API (POST /v1/messages, streamed), on a free port: it checks
// the key, keeps every request body, and answers from a script with text, tool calls and an
// optional thinking block, or an HTTP error. No model.
export type AnthropicAnswer =
  | { readonly text?: string; readonly thinking?: string; readonly calls?: readonly { readonly name: string; readonly input: unknown }[] }
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

export type FakeAnthropicState = { readonly headers: Headers[]; script: AnthropicAnswer[]; readonly seen: string[] };

export function fakeAnthropic(key: string) {
  const state: FakeAnthropicState = { headers: [], script: [], seen: [] };
  const server = Bun.serve({
    fetch: async (req) => {
      if (new URL(req.url).pathname !== "/v1/messages") return new Response("not found", { status: 404 });
      if (req.headers.get("x-api-key") !== key) return Response.json({ error: { message: "invalid x-api-key", type: "authentication_error" }, type: "error" }, { status: 401 });
      state.seen.push(await req.text());
      state.headers.push(req.headers);
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
      ];
      const events = [
        sse({ message: { content: [], model: "fake-opus", role: "assistant", usage: USAGE }, type: "message_start" }),
        ...blocks.flatMap((b, index) => [
          sse({ content_block: b.start, index, type: "content_block_start" }),
          ...b.deltas.map((delta) => sse({ delta, index, type: "content_block_delta" })),
          sse({ index, type: "content_block_stop" }),
        ]),
        sse({ delta: { stop_reason: answer.calls?.length ? "tool_use" : "end_turn" }, type: "message_delta", usage: { output_tokens: 50 } }),
        sse({ type: "message_stop" }),
      ];
      return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  return { base: `http://127.0.0.1:${server.port ?? 0}`, server, state };
}
