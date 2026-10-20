// A vendor's prompt cache, as a model: what a request reads from it, writes to it and sends
// uncached, by the rules below. test/single-flight.test.ts and the cache replay
// (test/cache-replay.ts) feed it the requests our engines build; it never sees a model.
//
// The rules, and where each comes from. "skill" is the claude-api skill's shared/prompt-caching.md
// (Anthropic's prompt-caching docs as of Oct 2026); an assumption is marked as one.
//
//   A1  A request is a list of blocks, keyed in a chain: a block's key names every byte up to its
//       end, so two requests share a key exactly where they share their whole prefix
//       (docs/optchat.md §3.3 "the cached prefix ends at the first changed byte"; skill "prefix
//       match"). Anthropic renders tools, then system, then messages; `tool_choice` is keyed in
//       front of the messages, so changing it keeps the tools and system entry and loses the
//       messages' (skill "Invalidation hierarchy").
//   A2  An entry is written only at a marked block: `cache_control` on a block, or the top-level
//       automatic one on the request's last block. At most 4 marks, the automatic one counted; a
//       1-hour mark after a 5-minute one is refused (skill; SPEC E6, E26). Our test fakes refuse
//       both as the API does (test/fake-anthropic.ts); here they fail the replay.
//   A3  A mark looks back at most VENDOR_LOOKBACK (20) positions for an entry an earlier request
//       wrote, its own included; a run of consecutive tool_use blocks is one position, and so is a
//       run of tool_result blocks (docs/optchat.md §3.3; skill "20-block lookback window"). The
//       request reads the longest entry any of its marks finds. The vendor's own number, not our
//       LOOKBACK (src/config.ts), which is our guess at it: the replay checks the guess, never
//       borrows it.
//   A4  An entry is readable once the writing request's response begins (message_start) and not
//       before: requests sent together all write (skill "Concurrent-request timing"; SPEC E50).
//       A request whose client is gone before then writes nothing (an assumption, the cautious
//       one: priming killed before message_start, E17).
//   A5  An entry lives its TTL from the start of the request that wrote or last read it: 5
//       minutes by default, an hour with `ttl: "1h"` (docs/optchat.md §3.3 "5 minutes from their
//       last read"; skill "Choosing the TTL"). A read renews the entry it read by that entry's own
//       TTL, and only that one: a shorter entry under it, a system prompt's, ages on (an
//       assumption, the cautious one).
//   A6  A prefix under the model's minimum is never written (skill table): 512 tokens on Opus 5.5,
//       Opus 5, Sonnet 5.5 and Haiku 5.5; 1024 on Opus 4.8, 4.1 and 4, Sonnet 5, 4.6, 4.5 and 4;
//       2048 on Opus 4.7 and Haiku 3.5; 4096 on Opus 4.6 and 4.5 and Haiku 4.5. A model not in the
//       table fails the request, rather than being guessed at.
//   A7  Tokens are counted as a block's JSON text over 4, rounded up (an assumption: no tokenizer
//       here, and every engine is measured with the same one).
//   A8  `effort` and `thinking` key the whole prefix, the tools and system prompt included: the skill
//       says changing them loses the tools and system entry on models that render them first and
//       not on others, without naming which (an assumption, the cautious one).
//   O1  The Responses API (openai-plan, an OpenAI key) caches the same way, keyed on the model,
//       effort, tool choice, tools and instructions, then the input items: an entry at each
//       `prompt_cache_breakpoint` and at the request's end, which OpenAI caches implicitly (SPEC
//       E26, "Compactor calls" openai-plan). 5-minute entries, the least OpenAI keeps one (SPEC E50,
//       src/engines/inflight.ts); 1024 tokens at least; no run of items is one position. OpenAI's
//       real cache matches any prefix in 128-token steps, so it can only read more than this
//       model: the fake's reads on the plan are a floor. That `tool_choice` keys the prefix is an
//       assumption, the cautious one (M5). A write costs what input costs there; the fake still
//       counts it apart, as Anthropic's would be.
import { Schema } from "effect";

// A3: how far back a mark looks for an entry (skill "20-block lookback window"; docs/optchat.md §3.3)
export const VENDOR_LOOKBACK = 20;

export type Ttl = "5m" | "1h";
export const TTL_MS = { "1h": 3_600_000, "5m": 300_000 } as const satisfies Record<Ttl, number>;
export type Vendor = "anthropic" | "openai";

// one block as the cache sees it: `key` its own part of the prefix, `tokens` its size (A7),
// `mark` its cache mark, `run` the run it is part of (A3), `tier` "message" for the blocks after
// the tools and system prompt
export type CacheBlock = {
  readonly key: string;
  readonly tokens: number;
  readonly mark: Ttl | null;
  readonly run: "tool_use" | "tool_result" | null;
  readonly tier: "head" | "message";
};
// `front`: what keys the whole prefix besides the model (A8)
export type CacheRequest = { readonly vendor: Vendor; readonly model: string; readonly front: string; readonly blocks: readonly CacheBlock[]; readonly least: number };

// what one request did: tokens read, written (by TTL) and sent uncached; the blocks it read and
// wrote, for tests that count in blocks; each marked prefix it wrote, by key, with its tier
export type Use = {
  readonly read: number;
  readonly write5m: number;
  readonly write1h: number;
  readonly input: number;
  readonly blocksRead: number;
  readonly blocksWritten: number;
  readonly wrote: readonly { readonly key: string; readonly tier: CacheBlock["tier"]; readonly ttl: Ttl }[];
  readonly keys: readonly string[];
  readonly marks: readonly number[]; // the blocks it marks, by index into keys
  readonly readKey: string | null; // the entry it read
  readonly total: number;
};

export const tokensOf = (text: string) => Math.ceil(text.length / 4);

// the chain of keys (A1): each names the block and every block before it
const chain = (blocks: readonly CacheBlock[], model: string) => {
  let key = new Bun.CryptoHasher("sha256").update(model).digest("hex");
  return blocks.map((b) => (key = new Bun.CryptoHasher("sha256").update(`${key}:${b.key.length}:${b.key}`).digest("hex")));
};

// each block's lookback position (A3): a run of tool_use or tool_result blocks is one
const positions = (blocks: readonly CacheBlock[]) => {
  let at = -1;
  return blocks.map((b, k) => (b.run !== null && blocks[k - 1]?.run === b.run ? at : ++at));
};

export type Look = { readonly use: Use; readonly commit: () => void };

export const makeVendorCache = () => {
  const entries = new Map<string, { until: number; readonly ttl: Ttl }>();
  // A request sent at `sent`: what it reads now (and renews), what it would write; `commit` writes
  // it, called as its response begins (A4)
  const look = (req: CacheRequest, sent: number): Look => {
    const keys = chain(req.blocks, `${req.vendor}:${req.model}:${req.front}`);
    const pos = positions(req.blocks);
    const sums: number[] = [];
    for (const b of req.blocks) sums.push((sums.at(-1) ?? 0) + b.tokens);
    const total = sums.at(-1) ?? 0;
    const live = (k: number) => (entries.get(keys[k] ?? "")?.until ?? -1) > sent;
    const marks = req.blocks.flatMap((b, k) => (b.mark === null ? [] : [k]));
    let hit = -1;
    for (const m of marks)
      for (let k = m; k >= 0 && (pos[m] ?? 0) - (pos[k] ?? 0) <= VENDOR_LOOKBACK; k--)
        if (live(k)) {
          hit = Math.max(hit, k);
          break;
        }
    const read = hit < 0 ? 0 : (sums[hit] ?? 0);
    // the marks past the read whose prefix is long enough to keep (A6)
    const writes = marks.filter((m) => m > hit && (sums[m] ?? 0) >= req.least);
    let write5m = 0, write1h = 0, from = read;
    for (const m of writes) {
      const size = (sums[m] ?? 0) - from;
      if (req.blocks[m]?.mark === "1h") write1h += size;
      else write5m += size;
      from = sums[m] ?? 0;
    }
    const kept = entries.get(keys[hit] ?? "");
    if (kept) kept.until = Math.max(kept.until, sent + TTL_MS[kept.ttl]);
    const last = writes.at(-1);
    const use: Use = {
      blocksRead: hit + 1,
      blocksWritten: last === undefined ? 0 : last - hit,
      input: total - from,
      keys,
      marks,
      read,
      readKey: hit < 0 ? null : (keys[hit] ?? null),
      total,
      write1h,
      write5m,
      wrote: writes.map((m) => ({ key: keys[m] ?? "", tier: req.blocks[m]?.tier ?? "message", ttl: req.blocks[m]?.mark ?? "5m" })),
    };
    const commit = () => {
      for (const m of writes) {
        const ttl = req.blocks[m]?.mark ?? "5m";
        const key = keys[m] ?? "";
        const until = Math.max(entries.get(key)?.until ?? 0, sent + TTL_MS[ttl]);
        entries.delete(key); // the least lately used first, as a vendor evicts
        entries.set(key, { ttl, until });
      }
    };
    return { commit, use };
  };
  return { look };
};
export type VendorCache = ReturnType<typeof makeVendorCache>;

// ---------------------------------------------------------------------------------------------
// Anthropic's Messages API (A1-A6)

const Mark = Schema.Struct({ type: Schema.Literal("ephemeral"), ttl: Schema.optional(Schema.Literals(["5m", "1h"])) });
const Marked = Schema.Record(Schema.String, Schema.Json);
const MessagesBody = Schema.Struct({
  model: Schema.String,
  tools: Schema.optional(Schema.Array(Marked)),
  system: Schema.optional(Schema.Array(Marked)),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Schema.Array(Marked) })),
  tool_choice: Schema.optional(Schema.Json),
  output_config: Schema.optional(Schema.Json),
  thinking: Schema.optional(Schema.Json),
  cache_control: Schema.optional(Mark),
});
export type MessagesBody = typeof MessagesBody.Type;
export const decodeMessagesBody = Schema.decodeUnknownSync(Schema.fromJsonString(MessagesBody));
const decodeMark = Schema.decodeUnknownOption(Mark);

// a model's least cacheable prefix (A6), by its id without a date
const LEAST = new Map<string, number>([
  ...["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((m) => [m, 512] as const),
  ...["claude-opus-4-8", "claude-opus-4-1", "claude-opus-4", "claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-sonnet-4"].map((m) => [m, 1024] as const),
  ...["claude-opus-4-7", "claude-haiku-3-5"].map((m) => [m, 2048] as const),
  ...["claude-opus-4-6", "claude-opus-4-5", "claude-haiku-4-5"].map((m) => [m, 4096] as const),
]);
export const leastTokens = (model: string) => {
  const least = LEAST.get(model.replace(/-\d{8}$/, ""));
  if (least === undefined) throw new Error(`no least cacheable size known for ${model} (fake-cache.ts A6)`);
  return least;
};

// What Anthropic answers a request whose marks it refuses (A2), or null: `ttls` are the marks' TTLs
// in prompt order (tools, system, messages), then the automatic one. test/fake-anthropic.ts too.
export const markRefusal = (ttls: readonly Ttl[]) => {
  if (ttls.length > 4) return `A maximum of 4 blocks with cache_control may be provided. Found ${ttls.length}.`;
  if (ttls.some((t, k) => t === "1h" && ttls.slice(0, k).includes("5m"))) return "a ttl='1h' cache_control block must not come after a ttl='5m' cache_control block";
  return null;
};

// a block without its mark, as its key and size; and its mark
type Split = { readonly text: string; readonly mark: Ttl | null };
const split = (b: Readonly<Record<string, Schema.Json>>) => {
  const { cache_control: control, ...rest } = b;
  const mark = control === undefined ? undefined : decodeMark(control);
  return { mark: mark?._tag === "Some" ? (mark.value.ttl ?? "5m") : null, text: JSON.stringify(rest) } satisfies Split;
};
const runOf = (b: Readonly<Record<string, Schema.Json>>) => (b.type === "tool_use" ? "tool_use" : b.type === "tool_result" ? "tool_result" : null);

export const messagesRequest = (body: MessagesBody): CacheRequest => {
  const head = [...(body.tools ?? []), ...(body.system ?? [])].map((b): CacheBlock => {
    const s = split(b);
    return { key: s.text, mark: s.mark, run: null, tier: "head", tokens: tokensOf(s.text) };
  });
  // what keys the messages in front of them (A1)
  const choice = JSON.stringify(body.tool_choice ?? null);
  const rest = body.messages.flatMap((m) => m.content).map((b, k): CacheBlock => {
    const s = split(b);
    return { key: k === 0 ? `${choice}\u0000${s.text}` : s.text, mark: s.mark, run: runOf(b), tier: "message", tokens: tokensOf(s.text) };
  });
  const blocks = [...head, ...rest];
  const last = blocks.at(-1);
  // the automatic mark on the last block (A2), unless that one is marked already
  if (body.cache_control && last?.mark === null) blocks[blocks.length - 1] = { ...last, mark: body.cache_control.ttl ?? "5m" };
  const ttls = [...head, ...rest].flatMap((b) => (b.mark === null ? [] : [b.mark]));
  if (body.cache_control) ttls.push(body.cache_control.ttl ?? "5m");
  const refused = markRefusal(ttls);
  if (refused !== null) throw new Error(refused);
  const front = JSON.stringify({ effort: body.output_config ?? null, thinking: body.thinking ?? null }); // A8
  return { blocks, front, least: leastTokens(body.model), model: body.model, vendor: "anthropic" };
};

// ---------------------------------------------------------------------------------------------
// The Responses API (O1)

const Item = Schema.Record(Schema.String, Schema.Json);
const ResponsesBody = Schema.Struct({
  model: Schema.String,
  instructions: Schema.String,
  input: Schema.Array(Item),
  tools: Schema.optional(Schema.Json),
  tool_choice: Schema.optional(Schema.Json),
  reasoning: Schema.Struct({ effort: Schema.optional(Schema.String), context: Schema.optional(Schema.String) }),
  include: Schema.optional(Schema.Array(Schema.String)),
  store: Schema.optional(Schema.Boolean),
});
export type ResponsesBody = typeof ResponsesBody.Type;
export const decodeResponsesBody = Schema.decodeUnknownSync(Schema.fromJsonString(ResponsesBody));
const decodeParts = Schema.decodeUnknownOption(Schema.Array(Schema.Record(Schema.String, Schema.Json)));

// The fields E26 says every request of ours carries; one without them is a bug the replay reports
export const responsesFieldsOk = (b: ResponsesBody) =>
  b.store === false && b.reasoning.context === "all_turns" && (b.include ?? []).includes("reasoning.encrypted_content");

export const responsesRequest = (body: ResponsesBody): CacheRequest => {
  if (!responsesFieldsOk(body)) throw new Error("a Responses request without store: false, reasoning.context: all_turns and the encrypted reasoning");
  const front = JSON.stringify({ effort: body.reasoning.effort ?? null, instructions: body.instructions, tool_choice: body.tool_choice ?? null, tools: body.tools ?? null });
  const blocks: CacheBlock[] = [{ key: front, mark: null, run: null, tier: "head", tokens: tokensOf(front) }];
  for (const item of body.input) {
    const parts = item.role === "user" ? decodeParts(item.content) : undefined;
    if (parts?._tag !== "Some") {
      const text = JSON.stringify(item);
      blocks.push({ key: text, mark: null, run: null, tier: "message", tokens: tokensOf(text) });
      continue;
    }
    blocks.push({ key: '{"role":"user"}', mark: null, run: null, tier: "message", tokens: 1 });
    for (const p of parts.value) {
      const { prompt_cache_breakpoint: point, ...rest } = p;
      const text = JSON.stringify(rest);
      blocks.push({ key: text, mark: point === undefined ? null : "5m", run: null, tier: "message", tokens: tokensOf(text) });
    }
  }
  const last = blocks.at(-1);
  if (last?.mark === null) blocks[blocks.length - 1] = { ...last, mark: "5m" }; // the implicit end
  return { blocks, front: "", least: 1024, model: body.model, vendor: "openai" };
};
