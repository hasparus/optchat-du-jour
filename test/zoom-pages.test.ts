// A long message read in pages (E48) and what a compaction reads of it (E49): zoom(id, 1, at) pages
// a 200 KB paste under CAP each, never inside a character, and the pages put back together are the
// message; the compactor's task holds its head and tail and a line whose zoom reads what was cut.
import { expect, test } from "bun:test";
import { Schema } from "effect";
import { cap } from "../src/cap.ts";
import { CAP, LEAF } from "../src/config.ts";
import { type Attached, handleMcp, ZOOM_PAGE } from "../src/mcp.ts";
import { newMsg } from "../src/store.ts";
import { leafText, task } from "../src/summarize/step.ts";
import { type Mem, newMem } from "../src/tree.ts";
import { addMessage, addNode } from "../src/view.ts";

// 4,000 rows of about 50 characters, an emoji (a surrogate pair) in each: about 200 KB
const PASTE = Array.from({ length: 4000 }, (_, k) => `row ${k} ${"x".repeat(36)} 😀`).join("\n");

function memory(): Mem {
  const mem = newMem();
  addMessage(mem, newMsg(0, "user", `look at this log:\n${PASTE}\n[image 1]`));
  addMessage(mem, newMsg(1, "talk", "a short reply"));
  addMessage(mem, newMsg(2, "talk", `a${"😀".repeat(20_000)}`)); // every pair starts at an odd character
  addNode(mem, { i: 0, l: 0, text: "user: pasted a log" });
  addNode(mem, { i: 1, l: 0, text: "talk: a short reply" });
  addNode(mem, { i: 0, l: 1, text: "user pasted a log; talk replied" });
  return mem;
}

const Result = Schema.fromJsonString(Schema.Struct({ result: Schema.Struct({ content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })) }) }));
// a picture for every user message, so a test sees which answers carry it
const picture: Attached = () => [{ data: "AAAA", mimeType: "image/png", type: "image" }];
const zoom = (mem: Mem, args: Record<string, Schema.Json>) => {
  const reply = handleMcp(mem, JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/call", params: { arguments: args, name: "zoom" } }), picture);
  const { content } = Schema.decodeUnknownSync(Result)(reply.body).result;
  return { pictures: content.filter((c) => c.type === "image").length, text: content[0]?.text ?? "" };
};
// Every page of message `id`, from its first on, each checked as the model gets it: the message's
// head line, its text under ZOOM_PAGE, which characters it holds, the zoom that reads on
function readAll(mem: Mem, id: number) {
  const whole = mem.root[id]?.text ?? "";
  const head = `${id}+0|${mem.root[id]?.kind}: `;
  const footer = new RegExp(String.raw`\n\[characters (\d+) to (\d+) of (\d+)(?:; zoom\(${id}, 1, (\d+)\) reads on)?\]$`);
  const parts: string[] = [];
  let at = 0;
  let breaks = 0; // pages that end at a line break
  for (;;) {
    const { pictures, text } = zoom(mem, at === 0 ? { id, n: 1 } : { at, id, n: 1 });
    expect(text.length).toBeLessThanOrEqual(CAP); // a turn's echo of it is never cut
    expect(pictures).toBe(at === 0 && mem.root[id]?.kind === "user" ? 1 : 0); // the pictures come with the first page only
    expect(text.startsWith(head)).toBe(true);
    const found = footer.exec(text);
    expect(found).not.toBeNull();
    const [, from, to, of, next] = found ?? [];
    expect([Number(from), Number(of)]).toEqual([at, whole.length]);
    const part = text.slice(head.length, text.length - (found?.[0].length ?? 0));
    expect(part.length).toBe(Number(to) - at);
    expect(part.length).toBeLessThanOrEqual(ZOOM_PAGE);
    expect(part.isWellFormed()).toBe(true);
    parts.push(part);
    if (next === undefined) return { breaks, parts };
    if (part.endsWith("\n")) breaks++;
    at = Number(next);
  }
}

test("a 200 KB message comes in pages from character at: each under CAP, cut at a line break, never inside a character, the whole message when put back together", () => {
  const mem = memory();
  const whole = mem.root[0]?.text ?? "";
  const { breaks, parts } = readAll(mem, 0);
  expect(parts.join("")).toBe(whole);
  expect(parts.length).toBeGreaterThanOrEqual(Math.ceil(whole.length / ZOOM_PAGE));
  expect(breaks).toBe(parts.length - 1); // every page but the last ends after its last line break
  // one line of emoji with nothing to break at: a page may end only between two of them
  const line = readAll(mem, 2);
  expect(line.parts.join("")).toBe(mem.root[2]?.text ?? "");
  expect(line.parts.map((p) => p.length)).toEqual([ZOOM_PAGE - 1, 40_001 - (ZOOM_PAGE - 1)]);

  // from inside a surrogate pair, the page starts at its first half
  const emoji = whole.indexOf("😀");
  expect(zoom(mem, { at: emoji + 1, id: 0, n: 1 }).text.startsWith("0+0|user: 😀")).toBe(true);
  // past the end, or not a character
  expect(zoom(mem, { at: whole.length, id: 0, n: 1 }).text).toBe(`No character ${whole.length} in line 0+1: it has ${whole.length}.`);
  expect(zoom(mem, { at: -1, id: 0, n: 1 }).text).toBe(`No character -1 in line 0+1: it has ${whole.length}.`);
  // a short message, and a node's two halves, are answered as they always were; from a later
  // character they say where they are
  expect(zoom(mem, { id: 1, n: 1 }).text).toBe("1+0|talk: a short reply");
  expect(zoom(mem, { at: 0, id: 1, n: 1 }).text).toBe("1+0|talk: a short reply");
  expect(zoom(mem, { at: 8, id: 1, n: 1 }).text).toBe("1+0|talk: reply\n[characters 8 to 13 of 13]");
  expect(zoom(mem, { id: 0, n: 2 }).text).toBe("0+1|user: pasted a log\n1+1|talk: a short reply");
  expect(zoom(mem, { at: 23, id: 0, n: 2 }).text).toBe("1+1|talk: a short reply\n[characters 23 to 46 of 46]");
});

test("a compaction reads at most LEAF characters of a message: its head and tail, and a line whose zoom reads what was cut", () => {
  const mem = memory();
  const whole = mem.root[0]?.text ?? "";
  const asked = task({ ctx: [], i: 0, l: 0, msg: mem.root[0] ?? newMsg(0, "user", "") });
  const input = asked.slice(asked.indexOf("<input>\nuser: ") + "<input>\nuser: ".length, asked.lastIndexOf("\n</input>"));
  const cut = /\n\[… (\d+) chars cut; zoom\(0, 1, (\d+)\) reads them …\]\n/.exec(input);
  expect(cut).not.toBeNull();
  const [line, left, from] = cut ?? [];
  const head = input.slice(0, cut?.index), tail = input.slice((cut?.index ?? 0) + (line?.length ?? 0));
  // half each, one less where a half would end inside a character
  for (const half of [head, tail]) expect(LEAF / 2 - half.length).toBeOneOf([0, 1]);
  expect(whole.startsWith(head) && whole.endsWith(tail)).toBe(true);
  expect(head.length + Number(left) + tail.length).toBe(whole.length);
  expect(input.isWellFormed()).toBe(true);
  // the zoom it names reads on exactly where the head stops
  expect(Number(from)).toBe(head.length);
  expect(zoom(mem, { at: Number(from), id: 0, n: 1 }).text.startsWith(`0+0|user: ${whole.slice(head.length, head.length + 100)}`)).toBe(true);

  // a tool's output was capped when it was logged: a compaction reads it whole, as before
  const echo = cap(PASTE);
  expect(echo.length).toBeGreaterThan(CAP);
  expect(leafText(3, echo)).toBe(echo);
  expect(leafText(3, "short")).toBe("short");
});
