// The cache marks (docs/optchat.md §3.3 "How the cache is marked"): the view in blocks of 4 lines,
// one mark on the last whole block and one at the request's end, on every engine; and over a
// sawtooth run, each call's marked prefix holds the one before it byte for byte, so each turn
// reads it from the cache. No model calls.
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { BREAKPOINTS, requestBody } from "../src/apikey/anthropic.ts";
import { BLOCK } from "../src/config.ts";
import { body as responsesBody } from "../src/openai/responses.ts";
import type { Item } from "../src/providers/provider.ts";
import { newMsg } from "../src/store.ts";
import { built, type Coord, newMem, nodes } from "../src/tree.ts";
import { primeBlocks } from "../src/turn/claude-code.ts";
import { addMessage, addNode, render, viewBlocks } from "../src/view.ts";

const view = (rows: number) => `<chat>\n${Array.from({ length: rows }, (_, k) => `${k}+1|user: line ${k}`).join("\n")}\n</chat>`;
const breaks = (text: string) => text.match(/\n/g)?.length ?? 0;

test("the view goes in blocks of 4 lines from its start; the last, partial one holds </chat>", () => {
  expect(BLOCK).toBe(4);
  // <chat>, 10 rows, </chat>: 11 lines end in a line break, so 2 whole blocks and 3 lines over
  const text = view(10);
  const { blocks, whole } = viewBlocks(text);
  expect(whole).toBe(2);
  expect(blocks).toHaveLength(3);
  expect(blocks.join("")).toBe(text);
  for (const b of blocks.slice(0, whole)) {
    expect(breaks(b)).toBe(4);
    expect(b.endsWith("\n")).toBe(true);
  }
  expect(blocks.at(-1)).toBe("7+1|user: line 7\n8+1|user: line 8\n9+1|user: line 9\n</chat>");
  // 4 lines end in a line break: one whole block, and </chat> alone is the partial one
  expect(viewBlocks(view(3))).toEqual({ blocks: ["<chat>\n0+1|user: line 0\n1+1|user: line 1\n2+1|user: line 2\n", "</chat>"], whole: 1 });
  // nothing whole: no mark anywhere
  expect(viewBlocks("<chat>\n</chat>")).toEqual({ blocks: ["<chat>\n</chat>"], whole: 0 });
  // a full view, ~128 KB in ~250 lines of 512 bytes: 63 blocks, far under any cap we know of
  const full = `<chat>\n${Array.from({ length: 250 }, (_, k) => `${k}+1|${"x".repeat(505)}`).join("\n")}\n</chat>`;
  expect(viewBlocks(full).blocks).toHaveLength(63);
});

// the content blocks of the view as each engine sends them, and where its view mark is
type Sent = { readonly content: readonly Readonly<Record<string, Schema.Json>>[]; readonly marked: readonly number[] };
const Content = Schema.Array(Schema.Record(Schema.String, Schema.Json));
const AnthropicBody = Schema.fromJsonString(Schema.Struct({ messages: Schema.Array(Schema.Struct({ content: Content })), cache_control: Schema.Json }));
const ResponsesBody = Schema.fromJsonString(Schema.Struct({ input: Schema.Array(Schema.Struct({ content: Content })) }));
const indexes = (content: Sent["content"], key: string) => content.flatMap((b, k) => (key in b ? [k] : []));
const opening = "what now?";

const engines = {
  // claude-code: priming's stream-json input (the turn sends the same blocks unmarked, D2)
  "claude-code priming": (text) => {
    const content = [...primeBlocks(text, "1h"), { text: "ok", type: "text" }];
    return { content, marked: indexes(content, "cache_control") };
  },
  // an api-key turn on Anthropic: the request body our tool loop's first request gets
  "anthropic": (text) => {
    const { blocks, whole } = viewBlocks(text);
    const history: Item[] = [{ marks: whole, parts: [...blocks, opening], type: "user" }];
    const sent = Schema.decodeUnknownSync(AnthropicBody)(requestBody({ history, model: "m", system: "s" }));
    expect(sent.cache_control).toEqual({ type: "ephemeral" }); // and the request's end
    const content = sent.messages[0]?.content ?? [];
    return { content, marked: indexes(content, "cache_control") };
  },
  // the Responses API (openai-plan, or an OpenAI key)
  "responses": (text) => {
    const { blocks, whole } = viewBlocks(text);
    const sent = Schema.decodeUnknownSync(ResponsesBody)(responsesBody({ input: [{ marks: whole, parts: [...blocks, opening], role: "user" }], instructions: "s", model: "m" }));
    const content = sent.input[0]?.content ?? [];
    return { content, marked: indexes(content, "prompt_cache_breakpoint") };
  },
} satisfies Record<string, (text: string) => Sent>;

test("each engine marks the view's last whole block once, and the partial one only where it is the request's end", () => {
  const text = view(10); // 3 blocks: 2 whole, 1 partial
  expect(engines["claude-code priming"](text).marked).toEqual([1, 2]); // the turn right after reads the whole view; "ok" unmarked
  expect(engines.anthropic(text).marked).toEqual([1]); // plus the top-level mark on the request's end
  expect(engines.responses(text).marked).toEqual([1]); // the request's end cached implicitly
  for (const send of Object.values(engines)) expect(send("<chat>\n</chat>").marked).toEqual(send === engines["claude-code priming"] ? [0] : []);
});

test("an Anthropic request never carries more than 4 breakpoints, the request's end included", () => {
  const { blocks, whole } = viewBlocks(view(40));
  // more user messages with view blocks than there are slots
  const history: Item[] = Array.from({ length: 6 }, (): Item => ({ marks: whole, parts: [...blocks, opening], type: "user" }));
  const wire = requestBody({ history, model: "m", system: "s" });
  expect(wire.split('"cache_control"').length - 1).toBe(BREAKPOINTS);
});

// a summary of 150 to 449 bytes, the same for a node every time
const summary = (c: Coord) => `${c.l}+${c.i} ${"s".repeat(150 + ((c.i * 37 + c.l * 11) % 300))}`;

// a call's marked prefix: its content blocks through the mark on the view's last whole block (none
// while no block is whole), marks stripped
const prefix = (s: Sent, at: number) => {
  if (at >= 0) expect(s.marked).toContain(at);
  return s.content.slice(0, at + 1).map((b) => JSON.stringify({ ...b, cache_control: undefined, prompt_cache_breakpoint: undefined }));
};

test("over a sawtooth run, each call's marked prefix holds the one before it byte for byte, within the lookback", () => {
  // messages of 600 bytes, every summary built at once (a turn waits for them), high 6000, low 3000
  const mem = newMem({ high: 6000, low: 3000 });
  const calls: { readonly lines: readonly Coord[]; readonly text: string }[] = [];
  for (let t = 0; t < 400; t++) {
    addMessage(mem, newMsg(t, "echo", "w".repeat(600)));
    for (const c of nodes(mem.root.length)) if (!built(mem, c)) addNode(mem, { ...c, text: summary(c) });
    calls.push({ lines: mem.view, text: render(mem) });
  }
  let appends = 0, batches = 0;
  for (const [n, call] of calls.entries()) {
    const next = calls[n + 1];
    if (!next) break;
    // a batch rewrites the view from the merged line on (docs/optchat.md §3.3): the cache misses there
    const grew = JSON.stringify(next.lines.slice(0, call.lines.length)) === JSON.stringify(call.lines);
    if (!grew) {
      batches++;
      continue;
    }
    appends++;
    // the next call's view mark finds this one's entry: at or after it, at most 20 blocks on
    const [from, to] = [viewBlocks(call.text).whole - 1, viewBlocks(next.text).whole - 1];
    expect(to - from).toBeGreaterThanOrEqual(0);
    expect(to - from).toBeLessThanOrEqual(20);
    for (const [name, send] of Object.entries(engines)) {
      const [was, is] = [prefix(send(call.text), from), prefix(send(next.text), to)];
      expect(is.slice(0, was.length), name).toEqual(was);
    }
  }
  expect(batches).toBeGreaterThan(3);
  expect(appends).toBeGreaterThan(batches * 10);
});
