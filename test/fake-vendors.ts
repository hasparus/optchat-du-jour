// The vendors the cache replay (test/cache-replay.ts) talks to, in this process, on the replay's
// clock, every request fed to one prompt cache (./fake-cache.ts):
//
//   - Anthropic's Messages API and the Responses API (an OpenAI key's, and the ChatGPT plan's at
//     host `plan`), as an HttpClient the real api-key and openai-plan clients send through;
//   - `claude` as a Runner: the stream-json the claude-code engine speaks, and the Messages request
//     Claude Code would build from it (see `claudeBody`).
//
// Each answers its first event RESPONSE after the request, and only then writes the cache (A4).
// What a reply says is decided from the request alone, so a replay is the same every time: a
// compaction answers a line whose size depends on its node (a quarter of the leaves too long at
// first, so size retries happen), a turn calls Read as many times as its message's `[steps N]`
// asks, then answers. An engine named in `out` answers every call with its usage limit, and one
// named in `limitOnce` its next turn. No model, no network.
import { type Cause, Clock, Effect, Predicate, Queue, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import { makeClaude, type Runner, type Spawn } from "../src/claude/process.ts";
import { type CacheRequest, decodeMessagesBody, decodeResponsesBody, makeVendorCache, type MessagesBody, messagesRequest, responsesRequest, type Use } from "./fake-cache.ts";
import { claudeBody, type Message, modelOf, procOf } from "./fake-claude-request.ts";
import { sse } from "./fake-http.ts";

export const RESPONSE = 1000; // ms from a request to the first event of its response

export type Role = "turn" | "prime" | "compact";
// one request, as the vendor saw it; `begun` once its response began (its writes are in)
// `opening`: a turn's opening text (the first message's last text), "" for other calls
export type Sent = { readonly at: number; readonly engine: string; readonly role: Role; readonly opening: string; readonly use: Use; begun: boolean; readonly output: number };
// a request to ask the cache: what it is (`build` throws for one the API refuses), and for Sent
type Asked = { readonly build: () => CacheRequest; readonly engine: string; readonly role: Role; readonly opening: string; readonly output: number };

// a small deterministic hash, for sizes that differ between nodes and turns but never between runs
export const hash = (s: string) => {
  let h = 2_166_136_261;
  for (let k = 0; k < s.length; k++) h = Math.imul(h ^ (s.codePointAt(k) ?? 0), 16_777_619);
  return h >>> 0;
};

// How the fakes name an engine (the model it runs, as its vendor spells it), from a chain's ref:
// what `out` and `limitOnce` take and what Sent.engine says
export const engineName = (ref: { readonly engine: string; readonly model: string; readonly provider?: string }) =>
  ref.engine === "claude-code" ? `claude-code:${modelOf(ref.model)}` : ref.engine === "openai-plan" ? `openai-plan:${ref.model}` : `api-key:${ref.provider ?? ""}/${ref.model}`;

type Json = Schema.Json;

// ---------------------------------------------------------------------------------------------
// what a reply says

// A compaction's line: 200 to 480 bytes by its node; the first try of a quarter of the leaves 620
// bytes, so a size retry follows (docs/optchat.md §4 "The size")
const compactionLine = (task: string, retries: number) => {
  const node = /compress message (\d+)|merge lines (\d+)\+(\d+)/.exec(task)?.[0] ?? task.slice(0, 80);
  const h = hash(node);
  const size = retries > 0 ? 380 : node.startsWith("compress") && h % 4 === 0 ? 620 : 200 + (h % 280);
  return `line ${node} `.padEnd(size, "x");
};
const stepsOf = (opening: string) => Number(/\[steps (\d+)\]/.exec(opening)?.[1] ?? 0);
// a turn's last reply: 100 to 2,100 characters by its opening
const replyText = (opening: string) => "reply ".padEnd(100 + (hash(opening) % 2000), "y");
// what Read answers: 200 to 6,200 characters by the file named
export const readText = (path: string) => `contents of ${path}\n`.padEnd(200 + (hash(path) % 6000), "r");
const readInput = (opening: string, step: number) => ({ file_path: `~/repos/notes-${hash(opening) % 97}-${step}.md` });

type Reply = { readonly kind: "line"; readonly text: string } | { readonly kind: "call"; readonly input: Readonly<Record<string, string>> } | { readonly kind: "text"; readonly text: string };

// what a request asks for: its texts, the first message's last text (a turn's opening), the calls
// made so far
const replyTo = (texts: readonly string[], opening: string, calls: number): Reply => {
  const task = texts.find((t) => t.startsWith("Compaction:"));
  if (task !== undefined) return { kind: "line", text: compactionLine(task, texts.filter((t) => t.startsWith("Too long:")).length) };
  if (calls < stepsOf(opening)) return { input: readInput(opening, calls), kind: "call" };
  return { kind: "text", text: replyText(opening) };
};

// the texts of a Responses input item, when it is a user message
const userTexts = (i: Readonly<Record<string, Json>>) =>
  i.role === "user" && Array.isArray(i.content) ? i.content.flatMap((p) => (Predicate.isObject(p) && "text" in p && Predicate.isString(p.text) ? [p.text] : [])) : [];
const textsOf = (blocks: readonly Readonly<Record<string, Json>>[]) => blocks.flatMap((b) => (b.type === "text" && Predicate.isString(b.text) ? [b.text] : []));

// a 400, as the API answers a request it refuses
const badRequest = (why: string) => Effect.succeed(Response.json({ error: { message: why, type: "invalid_request_error" }, type: "error" }, { status: 400 }));

// a Messages reply: its thought, then its text or its call, with what the cache said it cost
const anthropicReply = (body: MessagesBody, use: Use, reply: Reply) => {
  const usage = {
    cache_creation: { ephemeral_1h_input_tokens: use.write1h, ephemeral_5m_input_tokens: use.write5m },
    cache_creation_input_tokens: use.write5m + use.write1h,
    cache_read_input_tokens: use.read,
    input_tokens: use.input,
    output_tokens: 1,
  };
  const n = body.messages.length;
  const blocks: { readonly start: Json; readonly delta: Json }[] = [
    // Opus 5.5 and Haiku 5.5 always think (the claude-api skill); the block goes back with each later request
    { delta: { signature: `sig-${n}`, type: "signature_delta" }, start: { signature: "", thinking: "", type: "thinking" } },
    reply.kind === "call"
      ? { delta: { partial_json: JSON.stringify(reply.input), type: "input_json_delta" }, start: { id: `toolu_${n}`, input: {}, name: "Read", type: "tool_use" } }
      : { delta: { text: reply.text, type: "text_delta" }, start: { text: "", type: "text" } },
  ];
  return [
    sse({ message: { content: [], model: body.model, role: "assistant", usage }, type: "message_start" }),
    ...blocks.flatMap((b, index) => [sse({ content_block: b.start, index, type: "content_block_start" }), sse({ delta: b.delta, index, type: "content_block_delta" }), sse({ index, type: "content_block_stop" })]),
    sse({ delta: { stop_reason: reply.kind === "call" ? "tool_use" : "end_turn" }, type: "message_delta", usage: { output_tokens: outputOf(reply) } }),
    sse({ type: "message_stop" }),
  ].join("");
};

export const makeVendors = () => {
  const cache = makeVendorCache();
  const sent: Sent[] = [];
  const out = new Set<string>(); // engines that answer every call with a usage limit
  const limitOnce = new Set<string>(); // engines whose next turn does
  const fired: string[] = []; // the engines whose turn limitOnce stopped, in order
  const limited = (engine: string, role: Role) => {
    if (out.has(engine)) return true;
    if (role !== "turn" || !limitOnce.delete(engine)) return false;
    fired.push(engine);
    return true;
  };

  // what the vendors refused: a request the cache rules say the API would answer with a 400 (A2)
  const refused: string[] = [];
  // a request sent now: what it reads and writes; then RESPONSE later its response begins, and
  // the cache has what it wrote. Interrupted before that, it wrote nothing (A4). One the API would
  // refuse fails with why
  const ask = ({ build, engine, opening, output, role }: Asked) =>
    Effect.gen(function* () {
      const req = yield* Effect.try({ catch: (e) => (e instanceof Error ? e.message : String(e)), try: build });
      const at = yield* Clock.currentTimeMillis;
      const look = cache.look(req, at);
      const record: Sent = { at, begun: false, engine, opening: role === "turn" ? opening : "", output, role, use: look.use };
      sent.push(record);
      yield* Effect.sleep(RESPONSE);
      look.commit();
      record.begun = true;
      return look.use;
    }).pipe(Effect.tapError((why) => Effect.sync(() => void refused.push(`${engine}: ${why}`))));

  // -------------------------------------------------------------------------------------------
  // Anthropic's Messages API

  const anthropic = (raw: string) =>
    Effect.gen(function* () {
      const body = decodeMessagesBody(raw);
      const engine = engineName({ engine: "api-key", model: body.model, provider: "anthropic" });
      const users = body.messages.filter((m) => m.role === "user").flatMap((m) => textsOf(m.content));
      const calls = body.messages.flatMap((m) => m.content).filter((b) => b.type === "tool_use").length;
      const opening = textsOf(body.messages[0]?.content ?? []).at(-1) ?? "";
      const reply = replyTo(users, opening, calls);
      const role: Role = reply.kind === "line" ? "compact" : "turn";
      if (limited(engine, role))
        return Response.json({ error: { message: "rate limited", type: "rate_limit_error" }, type: "error" }, { headers: { "retry-after": "3600" }, status: 429 });
      return yield* ask({ build: () => messagesRequest(body), engine, opening, output: outputOf(reply), role }).pipe(
        Effect.map((use) => new Response(anthropicReply(body, use, reply), { headers: { "content-type": "text/event-stream" } })),
        Effect.catch(badRequest),
      );
    });

  // -------------------------------------------------------------------------------------------
  // the Responses API

  const responses = (raw: string, plan: boolean) =>
    Effect.gen(function* () {
      const body = decodeResponsesBody(raw);
      const engine = plan ? engineName({ engine: "openai-plan", model: body.model }) : engineName({ engine: "api-key", model: body.model, provider: "openai" });
      const parts = body.input.flatMap(userTexts);
      const opening = userTexts(body.input.find((i) => i.role === "user") ?? {}).at(-1) ?? "";
      const calls = body.input.filter((i) => i.type === "function_call").length;
      const reply = replyTo(parts, opening, calls);
      const role: Role = reply.kind === "line" ? "compact" : "turn";
      if (limited(engine, role)) return Response.json({ error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } }, { status: 429 });
      const asked = yield* ask({ build: () => responsesRequest(body), engine, opening, output: outputOf(reply), role }).pipe(Effect.result);
      if (asked._tag === "Failure") return yield* badRequest(asked.failure);
      const use = asked.success;
      const n = body.input.length;
      const reasoning = { encrypted_content: `enc:${n}:${hash(raw) % 1000}`, id: `rs_${n}`, summary: [], type: "reasoning" };
      const item: Json =
        reply.kind === "call"
          ? { arguments: JSON.stringify(reply.input), call_id: `call_${n}`, name: "Read", type: "function_call" }
          : { content: [{ text: reply.text, type: "output_text" }], type: "message" };
      const usage = { input_tokens: use.total, input_tokens_details: { cached_tokens: use.read }, output_tokens: outputOf(reply) };
      return new Response(
        [
          sse({ type: "response.created" }),
          sse({ item: { type: "reasoning" }, type: "response.output_item.added" }),
          sse({ item: reasoning, type: "response.output_item.done" }),
          ...(reply.kind === "call" ? [] : [sse({ delta: reply.text, type: "response.output_text.delta" })]),
          sse({ item, type: "response.output_item.done" }),
          sse({ response: { model: body.model, usage }, type: "response.completed" }),
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    });

  const decoder = new TextDecoder();
  const bodyOf = (request: HttpClientRequest.HttpClientRequest) => (request.body._tag === "Uint8Array" ? decoder.decode(request.body.body) : "");
  // api.anthropic.com, an OpenAI key's api.openai.com, the plan's route at host `plan`
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const raw = bodyOf(request);
      const res = url.pathname.endsWith("/v1/messages") ? yield* anthropic(raw) : url.pathname.endsWith("/responses") ? yield* responses(raw, url.host === "plan") : new Response("not found", { status: 404 });
      return HttpClientResponse.fromWeb(request, res);
    }),
  );

  // -------------------------------------------------------------------------------------------
  // claude

  const claude: Runner["Service"] = { spawn: (s) => spawnClaude(s, { ask, limited }), warm: () => Effect.void };
  return { claude, fired, http, limitOnce, out, refused, sent };
};
export type Vendors = ReturnType<typeof makeVendors>;

const outputOf = (reply: Reply) => Math.ceil((reply.kind === "call" ? JSON.stringify(reply.input) : reply.text).length / 4) + 40; // and its thought

// ---------------------------------------------------------------------------------------------
// claude: the request it builds is test/fake-claude-request.ts's (C1-C4); this plays the rest (C5)

const Line = Schema.Struct({ message: Schema.Struct({ content: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }) });
const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(Line));

type Ask = (o: Asked) => Effect.Effect<Use, string>;

const spawnClaude = (s: Spawn, v: { readonly ask: Ask; readonly limited: (engine: string, role: Role) => boolean }) =>
  Effect.gen(function* () {
    const p = procOf(s.args, s.env);
    const role: Role = p.role === "prime" || p.role === "compact" ? p.role : "turn";
    const engine = engineName({ engine: "claude-code", model: p.model });
    const stdin = yield* Queue.unbounded<string>();
    const lines = yield* Queue.unbounded<string, Cause.Done>();
    const emit = (e: Readonly<Record<string, Json>>) => Queue.offer(lines, JSON.stringify(e));
    const convo: Message[] = [];
    // a message from stdin joins the conversation (after what is there, C5) and is replayed
    const take = (line: string) =>
      Effect.gen(function* () {
        const { content } = decodeLine(line).message;
        const last = convo.at(-1);
        if (last?.role === "user") last.content.push(...content);
        else convo.push({ content: [...content], role: "user" });
        if (p.replays) yield* emit({ isReplay: true, message: { content, role: "user" }, type: "user" });
      });
    const total = { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, input_tokens: 0, output_tokens: 0 };
    // one request of the conversation so far; its message_start, with what it cost
    const request = (output: number, opening: string) =>
      Effect.gen(function* () {
        const use = yield* v.ask({ build: () => messagesRequest(claudeBody(p, convo)), engine, opening, output, role });
        const usage = { cache_creation_input_tokens: use.write5m + use.write1h, cache_read_input_tokens: use.read, input_tokens: use.input, output_tokens: output };
        for (const k of ["cache_creation_input_tokens", "cache_read_input_tokens", "input_tokens", "output_tokens"] as const) total[k] += usage[k];
        yield* emit({ event: { message: { model: p.model, usage }, type: "message_start" }, type: "stream_event" });
      });
    const limit = Effect.andThen(
      emit({ message: { content: [{ text: "Claude AI usage limit reached|1760000000", type: "text" }], model: "<synthetic>" }, type: "assistant" }),
      emit({ is_error: true, result: "Claude AI usage limit reached", subtype: "success", type: "result" }),
    );
    const play = Effect.gen(function* () {
      yield* emit({ mcp_servers: [{ name: "optchat", status: "connected" }], model: p.model, subtype: "init", type: "system" });
      for (;;) {
        yield* take(yield* Queue.take(stdin));
        if (v.limited(engine, role)) {
          yield* limit;
          continue;
        }
        const opening = textsOf(convo[0]?.content ?? []).at(-1) ?? "";
        // a result's usage is its own message's requests' (a size retry is a message of its own)
        for (const k of ["cache_creation_input_tokens", "cache_read_input_tokens", "input_tokens", "output_tokens"] as const) total[k] = 0;
        for (;;) {
          const texts = convo.filter((m) => m.role === "user").flatMap((m) => textsOf(m.content));
          const calls = convo.flatMap((m) => m.content).filter((b) => b.type === "tool_use").length;
          const reply = replyTo(texts, opening, calls);
          const asked = yield* request(outputOf(reply), opening).pipe(Effect.result);
          if (asked._tag === "Failure") {
            yield* emit({ is_error: true, result: `API Error: 400 ${asked.failure}`, subtype: "success", type: "result" });
            break;
          }
          if (p.role === "prime") return yield* Effect.never; // killed at message_start
          if (reply.kind !== "call") {
            const said = { text: reply.text, type: "text" };
            convo.push({ content: [said], role: "assistant" }); // a size retry is sent after it
            yield* emit({ message: { content: [said], model: p.model }, type: "assistant" });
            yield* emit({ result: reply.text, stop_reason: "end_turn", subtype: "success", type: "result", usage: { ...total } });
            break;
          }
          const id = `toolu_${calls}`;
          const use = { id, input: reply.input, name: "Read", type: "tool_use" };
          yield* emit({ message: { content: [use], model: p.model }, type: "assistant" });
          convo.push({ content: [use], role: "assistant" });
          const result = { content: readText(reply.input.file_path ?? ""), tool_use_id: id, type: "tool_result" };
          yield* emit({ message: { content: [result], role: "user" }, type: "user" });
          convo.push({ content: [result], role: "user" });
          for (const line of yield* Queue.clear(stdin)) yield* take(line); // C5
        }
      }
    });
    yield* play.pipe(Effect.ensuring(Queue.end(lines)), Effect.forkScoped);
    return yield* makeClaude({ exit: Effect.succeed("the fake claude ended"), lines: Stream.fromQueue(lines), stdin });
  });
