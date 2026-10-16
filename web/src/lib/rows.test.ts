import { describe, expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { type Kind, MessagesPage, Msg } from "@wire";
import { Option, Schema } from "effect";
import { openStream } from "../../../server/agui.ts";
import { type Entry, IDLE, snapshot } from "../test/fixture";
import { applyEvent, applyPage, emptyLog, type Log, MAX_HELD, trimHeld, visible } from "./log";
import { type Inbound, parseFrame } from "./protocol";
import { chatRows, entryRows, planOf, planStates, rowFor, rowIndexFor, sourcesOfTool, toolStateOf, toolSummary, turnSources } from "./rows";
import { runStart } from "./session";

const entry = (i: number, kind: Kind, text: string) => ({ date: "2026-10-05T10:00:00Z", i, kind, text });
const play = (log: Log, ...events: readonly Inbound[]) => {
  let out = log;
  for (const e of events) out = applyEvent(out, e);
  return out;
};

const text = (i: number, delta: string): Inbound => ({ delta, messageId: String(i), type: EventType.TEXT_MESSAGE_CONTENT });
const start = (i: number): Inbound => ({ messageId: String(i), role: "assistant", type: EventType.TEXT_MESSAGE_START });
const end = (i: number): Inbound => ({ messageId: String(i), type: EventType.TEXT_MESSAGE_END });
const tool = (i: number, name: string, args: string): Inbound[] => [
  { parentMessageId: String(i), toolCallId: `t${i}`, toolCallName: name, type: EventType.TOOL_CALL_START },
  { delta: args, toolCallId: `t${i}`, type: EventType.TOOL_CALL_ARGS },
  { toolCallId: `t${i}`, type: EventType.TOOL_CALL_END },
];
const echo = (i: number, call: number, content: string): Inbound => ({ content, messageId: String(i), role: "tool", toolCallId: `t${call}`, type: EventType.TOOL_CALL_RESULT });

describe("rows", () => {
  test("an echo answers the nearest unanswered tool call before it; one with none stands alone", () => {
    const rows = entryRows([entry(4, "echo", "orphan"), entry(5, "tool", 'Bash {"command":"ls"}'), entry(6, "user", "mid-run"), entry(7, "echo", "a b"), entry(8, "talk", "done")]);
    expect(rows.map((r) => (r.kind === "tool" ? [r.id, r.name, r.args, r.output] : [r.id, r.kind]))).toEqual([
      [4, "output", "", "orphan"],
      [5, "Bash", '{"command":"ls"}', "a b"],
      [6, "user"],
      [8, "talk"],
    ]);
    expect(rowFor(rows, 7)?.id).toBe(6);
    expect(entryRows([entry(1, "tool", "Bash"), entry(5, "echo", "x")]).map((r) => r.id)).toEqual([1, 5]);
  });
});

test("echo identity follows its answered call across a hole fill and a held-window trim", () => {
  const call = { i: 0, kind: "tool", text: "Bash {}" } satisfies Parameters<typeof applyPage>[1][number];
  const answer = { i: 2, kind: "echo", text: "out", error: true } satisfies Parameters<typeof applyPage>[1][number];
  const hole = applyPage(emptyLog, [call, answer]);
  const before = entryRows(visible(hole));
  expect(before.map((r) => r.id)).toEqual([0, 2]);
  expect(before[1]).toMatchObject({ name: "output", output: "out", failed: true });
  const filled = applyPage(hole, [{ i: 1, kind: "note", text: "between" }]);
  expect(filled.items.get(2)).toBe(hole.items.get(2));
  const paired = entryRows(visible(filled));
  expect(paired.map((r) => r.id)).toEqual([0, 1]);
  expect(paired[0]).not.toBe(before[0]);
  expect(paired[0]).toMatchObject({ name: "Bash", output: "out", failed: true });
  expect(entryRows(visible(filled))[0]).toBe(paired[0]);

  const replaced = applyPage(filled, [{ ...call, text: "Read {}" }]);
  const reread = entryRows(visible(replaced));
  expect(replaced.items.get(2)).toBe(filled.items.get(2));
  expect(reread[0]).not.toBe(paired[0]);
  expect(reread[0]).toMatchObject({ name: "Read", output: "out", failed: true });

  const grown = applyPage(replaced, Array.from({ length: MAX_HELD - 1 }, (_, k) => ({ i: k + 3, kind: "user", text: "later" })));
  const trimmed = trimHeld(grown);
  expect(trimmed.items.size).toBe(MAX_HELD);
  expect(trimmed.items.has(0)).toBe(false);
  expect(trimmed.items.get(2)).toBe(replaced.items.get(2));
  const standalone = entryRows(visible(trimmed))[0];
  expect(standalone).not.toBe(reread[0]);
  expect(standalone).toMatchObject({ id: 2, name: "output", output: "out", failed: true });
});

for (const via of ["snapshot", "page"] as const) {
  test(`Sources and settled rows keep identity across append and identical ${via}`, () => {
    const entries: Entry[] = [
      { kind: "user", text: "look" },
      { kind: "tool", text: 'WebSearch {"query":"q"}' },
      { kind: "echo", text: 'Links: [{"title":"A","url":"https://a.example/"}]' },
      { kind: "talk", text: "found" },
    ];
    const canonical = applyEvent(emptyLog, snapshot(entries));
    const before = entryRows(visible(canonical));
    const sources = turnSources(before).get("e3");
    expect(sources).toEqual([{ title: "A", url: "https://a.example/" }]);
    const tool = before.find((r) => r.kind === "tool");
    const citations = tool === undefined ? undefined : sourcesOfTool(tool);
    expect(citations).toEqual(sources);
    const appended = applyPage(canonical, [{ i: 4, kind: "user", text: "thanks" }]);
    const extended: Entry[] = [...entries, { kind: "user", text: "thanks" }];
    const same = via === "snapshot" ? applyEvent(appended, snapshot(extended)) : applyPage(appended, extended.map((e, i) => ({ ...e, i })));
    const after = entryRows(visible(same));
    expect(after.slice(0, before.length).every((r, k) => r === before[k])).toBe(true);
    expect(turnSources(after).get("e3")).toBe(sources);
    const afterTool = after.find((r) => r.kind === "tool");
    expect(afterTool === undefined ? undefined : sourcesOfTool(afterTool)).toBe(citations);
  });
}

describe("draft rows", () => {
  const LOG: Entry[] = [{ kind: "user", text: "u0" }, { kind: "talk", text: "t1" }];
  test("the draft is one row after the settled ones, which keep their objects; one that rewrites an entry replaces it", () => {
    const tools: Entry[] = [...LOG, { kind: "tool", text: "Bash {}" }, { kind: "echo", text: "out" }, { kind: "talk", text: "done" }];
    const log = play(emptyLog, snapshot(tools), start(5), text(5, "a"));
    const items = visible(log);
    const settled = entryRows(items);
    const live = chatRows(items, settled, log.draft);
    expect(live.slice(0, -1).every((r, k) => r === settled[k])).toBe(true);
    expect(live.map((r) => r.id)).toEqual([0, 1, 2, 4, 5]);
    const same = play(log, text(5, "b"));
    expect(chatRows(items, settled, same.draft).at(-1)).toMatchObject({ id: 5, text: "ab" });
    const rewrite = chatRows(items, settled, { i: 4, kind: "talk", text: "again" });
    expect(rewrite.map((r) => r.id)).toEqual([0, 1, 2, 4]);
    expect(rewrite.at(-1)).toMatchObject({ text: "again" });
    expect([-1, 0, 1, 2, 3, 4, 9].map((i) => rowIndexFor(settled, i))).toEqual([-1, 0, 1, 2, 2, 3, 3]);
  });
});

describe("a tool call's one line", () => {
  test("names what the tool was called on, else shows the input on one line", () => {
    expect(toolSummary('{"command":"cd web && bun run e2e"}')).toBe("cd web && bun run e2e");
    expect(toolSummary('{"file_path":"test/media/budget.test.ts","old_string":"let"}')).toBe("test/media/budget.test.ts");
    expect(toolSummary('{"id":412,"n":64}')).toBe("412+64");
    expect(toolSummary('{"todos":[{"content":"a"},{"content":"b"}]}')).toBe("2 items");
    expect(toolSummary('{"command":"  "}')).toBe('{"command":" "}');
    expect(toolSummary("not json\n  at all")).toBe("not json at all");
    expect(toolSummary("")).toBe("");
  });
  test("says a call failed only when its echo is flagged, whatever the output starts with", () => {
    const rows = entryRows([
      { i: 0, kind: "tool", text: 'Bash {"command":"bun run lint"}' },
      { error: true, i: 1, kind: "echo", text: "src/x.ts:1:1 lint error" },
      { i: 2, kind: "tool", text: 'Bash {"command":"grep -h Error: log.txt"}' },
      { i: 3, kind: "echo", text: "Error: disk quota exceeded (from log.txt, line 3)" },
      { i: 4, kind: "tool", text: 'Bash {"command":"false"}' },
      { i: 5, kind: "echo", text: "Exit code 1" },
      { error: true, i: 7, kind: "echo", text: "not run: cancelled" },
    ]);
    expect(rows.map((r) => (r.kind === "tool" ? [r.id, r.failed] : [r.id]))).toEqual([
      [0, true],
      [2, false],
      [4, false],
      [7, true],
    ]);
    expect(rows.map((r) => (r.kind === "tool" ? toolStateOf(r, false, false) : null))).toEqual(["error", "done", "done", "error"]);
  });
  test("a tool row's state: done or failed once answered, running only while it is the turn's newest", () => {
    expect(toolStateOf({ failed: false, output: "ok" }, true, true)).toBe("done");
    expect(toolStateOf({ failed: true, output: "Exit code 2" }, false, false)).toBe("error");
    expect(toolStateOf({ failed: false, output: "Exit code 2" }, false, false)).toBe("done");
    expect(toolStateOf({ failed: false, output: null }, true, true)).toBe("running");
    expect(toolStateOf({ failed: false, output: null }, true, false)).toBe("ended");
    expect(toolStateOf({ failed: false, output: null }, false, true)).toBe("ended");
  });
});

const failedRows = (log: Log) => entryRows(visible(log)).flatMap((r) => (r.kind === "tool" ? [`${r.id} ${r.failed} ${toolStateOf(r, false, false)}`] : []));
const decoded = (events: readonly unknown[]) => events.map((e) => Option.getOrThrow(parseFrame(JSON.stringify(e))));

describe("an echo's error flag, from the log line to the row", () => {
  const date = "2026-10-05T10:00:00.000Z";
  const lines = [
    { date, i: 0, kind: "user", size: 10, text: "look" },
    { date, device: "mini", i: 1, kind: "tool", size: 30, text: 'Read {"file_path":"gone.md"}' },
    { date, device: "mini", error: true, i: 2, kind: "echo", size: 26, text: "File does not exist." },
    { date, i: 3, kind: "tool", size: 30, text: 'Bash {"command":"false"}' },
    { date, i: 4, kind: "echo", size: 17, text: "Exit code 1" },
  ].map((record) => JSON.stringify(record));
  const entries = lines.map((line) => ({ ...Schema.decodeUnknownSync(Schema.fromJsonString(Msg))(line), size: 0 }));
  const expected = ["1 true error", "3 false done"];

  test("the decoder keeps it, and leaves it out where the line has none", () => {
    expect(entries[2]?.error).toBe(true);
    expect("error" in (entries[4] ?? {})).toBe(false);
  });
  test("a snapshot carries it", () => {
    const { first } = openStream({ entries, live: null, state: IDLE, thread: "mini", window: 50 });
    expect(failedRows(play(emptyLog, ...decoded(first)))).toEqual(expected);
  });
  test("live events carry it", () => {
    const { first, translate } = openStream({ entries: entries.slice(0, 1), live: null, state: IDLE, thread: "mini", window: 50 });
    const live = entries.slice(1).flatMap((e) => translate({ entry: e, runId: "1", type: "logged" }));
    const log = play(emptyLog, ...decoded(first), ...decoded(live));
    expect(failedRows(log)).toEqual(expected);
    expect([...log.items.values()].every((item) => item.live === (item.i > 0))).toBe(true);
  });
  test("a malformed flag never drops the message: it reads as not failed", () => {
    const frames = [null, "true", 1].map((error) => ({
      messages: [
        { id: "0", role: "assistant", toolCalls: [{ function: { arguments: "{}", name: "Bash" }, id: "t0", type: "function" }] },
        { content: "out", id: "1", metadata: { error }, role: "tool", toolCallId: "t0" },
      ],
      type: EventType.MESSAGES_SNAPSHOT,
    }));
    for (const log of decoded(frames).map((e) => play(emptyLog, e))) {
      expect(entryRows(visible(log)).map((r) => (r.kind === "tool" ? [r.output, r.failed] : null))).toEqual([["out", false]]);
    }
    const live = decoded([{ content: "out", messageId: "1", metadata: { error: "true" }, role: "tool", toolCallId: "t0", type: EventType.TOOL_CALL_RESULT }]);
    expect(play(emptyLog, ...live).items.get(1)).toEqual({ i: 1, kind: "echo", live: true, text: "out" });
  });
  test("a page of /api/messages carries it", () => {
    const body = JSON.stringify(Schema.encodeSync(MessagesPage)({ entries, total: entries.length }));
    const page = Schema.decodeUnknownSync(Schema.fromJsonString(MessagesPage))(body);
    expect(failedRows(applyPage(emptyLog, page.entries))).toEqual(expected);
  });
});

type Todo = { readonly content: string; readonly status: string; readonly activeForm?: string };
const todo = (todos: readonly Todo[]) => ({ args: JSON.stringify({ todos }), name: "TodoWrite" });
type Link = { readonly title?: string; readonly url: string };
const search = (links: readonly Link[]) => `Web search results for query: "q"\n\nLinks: ${JSON.stringify(links)}\n\nSome summary.`;
const readPatterns = (log: Log) => {
  const rows = entryRows(visible(log));
  return { plans: rows.flatMap((r) => (r.kind === "tool" ? (planOf(r) ?? []) : [])).map((s) => s.content), sources: Object.fromEntries(turnSources(rows)) };
};

describe("a plan: a TodoWrite call's steps", () => {
  test("reads Claude Code's todo list, in order, with each step's present tense", () => {
    expect(
      planOf(todo([
        { activeForm: "Reading the spec", content: "Read the spec", status: "completed" },
        { activeForm: "Writing the test", content: "Write the test", status: "in_progress" },
        { content: "Ship it", status: "pending" },
      ])),
    ).toEqual([
      { activeForm: "Reading the spec", content: "Read the spec", status: "completed" },
      { activeForm: "Writing the test", content: "Write the test", status: "in_progress" },
      { activeForm: null, content: "Ship it", status: "pending" },
    ]);
  });
  test("an MCP-named TodoWrite is one too; any other tool, or input that isn't a todo list, is a tool line", () => {
    expect(planOf({ ...todo([{ content: "a", status: "pending" }]), name: "mcp__todo__TodoWrite" })).toHaveLength(1);
    expect(planOf({ args: JSON.stringify({ todos: [{ content: "a", status: "pending" }] }), name: "Bash" })).toBeNull();
    expect(planOf(todo([]))).toBeNull();
    expect(planOf(todo([{ content: "a", status: "blocked" }]))).toBeNull();
    expect(planOf({ args: "not json", name: "TodoWrite" })).toBeNull();
  });
});

describe("sources: the links a turn's web tools used", () => {
  test("a WebFetch's address and a WebSearch's result links, only http(s), titled or by host", () => {
    expect(sourcesOfTool({ args: '{"url":"https://a.example/x","prompt":"p"}', name: "WebFetch", output: "..." })).toEqual([{ title: "a.example", url: "https://a.example/x" }]);
    expect(
      sourcesOfTool({
        args: '{"query":"q"}',
        name: "WebSearch",
        output: search([{ title: "B", url: "https://b.example/" }, { url: "http://c.example/p" }, { title: "evil", url: "javascript:alert(1)" }, { title: "data", url: "data:text/html,x" }]),
      }),
    ).toEqual([
      { title: "B", url: "https://b.example/" },
      { title: "c.example", url: "http://c.example/p" },
    ]);
    expect(sourcesOfTool({ args: '{"query":"q"}', name: "WebSearch", output: null })).toEqual([]);
    expect(sourcesOfTool({ args: '{"query":"q"}', name: "WebSearch", output: "Links: not json" })).toEqual([]);
    expect(sourcesOfTool({ args: '{"url":"https://a.example/"}', name: "Read", output: "x" })).toEqual([]);
  });
  test("go under each turn's last reply, deduplicated, and keep their array while unchanged", () => {
    const rows = entryRows([
      { i: 0, kind: "user", text: "look" },
      { i: 1, kind: "talk", text: "searching" },
      { i: 2, kind: "tool", text: 'WebSearch {"query":"q"}' },
      { i: 3, kind: "echo", text: search([{ title: "A", url: "https://a.example/" }]) },
      { i: 4, kind: "tool", text: 'WebFetch {"url":"https://a.example/","prompt":"p"}' },
      { i: 5, kind: "echo", text: "page" },
      { i: 6, kind: "talk", text: "found it" },
      { i: 7, kind: "user", text: "thanks" },
      { i: 8, kind: "talk", text: "welcome" },
      { i: 9, kind: "user", text: "fetch b" },
      { i: 10, kind: "tool", text: 'WebFetch {"url":"https://b.example/","prompt":"p"}' },
      { i: 11, kind: "echo", text: "page" },
    ]);
    const first = turnSources(rows);
    expect([...first]).toEqual([["e6", [{ title: "A", url: "https://a.example/" }]]]);
    const tools = rows.filter((r) => r.kind === "tool");
    const before = tools.map((r) => sourcesOfTool(r));
    const streaming = [...rows, ...entryRows([{ i: 12, kind: "talk", text: "and b says" }])];
    const again = turnSources(streaming);
    expect(tools.map((r) => sourcesOfTool(r)).every((list, k) => list === before[k])).toBe(true);
    expect(again.get("e6")).toBe(first.get("e6"));
    expect(again.get("e12")).toEqual([{ title: "b.example", url: "https://b.example/" }]);
    const copy = tools[0] === undefined ? null : { ...tools[0] };
    expect(copy === null ? null : sourcesOfTool(copy)).not.toBe(before[0]);
  });
  test("a newly logged entry keeps the rows above it, so an earlier search isn't parsed again; an echo still fills its call's row", () => {
    const searched = play(
      emptyLog,
      { messageId: "0", role: "user", type: EventType.TEXT_MESSAGE_START },
      text(0, "look"),
      end(0),
      ...tool(1, "WebSearch", '{"query":"q"}'),
    );
    const before = entryRows(visible(searched));
    const answered = play(searched, echo(2, 1, search([{ title: "A", url: "https://a.example/" }])), start(3), text(3, "found it"), end(3));
    const rows = entryRows(visible(answered));
    expect(rows[0]).toBe(before[0]);
    expect(rows[1]).not.toBe(before[1]);
    expect(rows[1]?.kind === "tool" ? rows[1].output : null).toContain("Links: ");
    const cites = rows.map((r) => (r.kind === "tool" ? sourcesOfTool(r) : null));
    const list = turnSources(rows).get("e3");
    expect(list).toEqual([{ title: "A", url: "https://a.example/" }]);
    const next = play(answered, { messageId: "4", role: "user", type: EventType.TEXT_MESSAGE_START }, text(4, "thanks"), end(4));
    const after = entryRows(visible(next));
    expect(after).toHaveLength(4);
    expect(after.slice(0, 3).every((r, k) => r === rows[k])).toBe(true);
    expect(after.map((r) => (r.kind === "tool" ? sourcesOfTool(r) : null)).slice(0, 3).every((c, k) => c === cites[k])).toBe(true);
    expect(turnSources(after).get("e3")).toBe(list);
    const canonical = applyPage(next, visible(next));
    const confirmed = entryRows(visible(canonical));
    expect(confirmed[1]).not.toBe(after[1]);
    expect(confirmed).toEqual(after);
    const same = entryRows(visible(applyPage(canonical, visible(canonical))));
    expect(same.every((r, k) => r === confirmed[k])).toBe(true);
    expect(turnSources(same).get("e3")).toBe(turnSources(confirmed).get("e3"));
  });
  test("a turn ends at a user row: a steered message starts the next one (the log keeps no turn boundaries)", () => {
    const rows = entryRows([
      { i: 0, kind: "user", text: "look" },
      { i: 1, kind: "tool", text: 'WebFetch {"url":"https://a.example/","prompt":"p"}' },
      { i: 2, kind: "echo", text: "page" },
      { i: 3, kind: "talk", text: "reading" },
      { i: 4, kind: "user", text: "also b (steered)" },
      { i: 5, kind: "tool", text: 'WebFetch {"url":"https://b.example/","prompt":"p"}' },
      { i: 6, kind: "echo", text: "page" },
      { i: 7, kind: "talk", text: "done" },
    ]);
    expect([...turnSources(rows)].map(([key, list]) => [key, list.map((s) => s.url)])).toEqual([
      ["e3", ["https://a.example/"]],
      ["e7", ["https://b.example/"]],
    ]);
  });
});

const write = (status: string) => `TodoWrite ${JSON.stringify({ todos: [{ content: "a", status }] })}`;

describe("each turn's plan", () => {
  test("is its last TodoWrite: the calls before it in the turn are plain tool lines; each turn has its own", () => {
    const rows = entryRows([
      { i: 0, kind: "user", text: "go" },
      { i: 1, kind: "tool", text: write("pending") },
      { i: 2, kind: "echo", text: "ok" },
      { i: 3, kind: "tool", text: write("in_progress") },
      { i: 4, kind: "echo", text: "ok" },
      { i: 5, kind: "tool", text: 'Bash {"command":"ls"}' },
      { i: 6, kind: "echo", text: "x" },
      { i: 7, kind: "tool", text: write("completed") },
      { i: 8, kind: "echo", text: "ok" },
      { i: 9, kind: "user", text: "again" },
      { i: 10, kind: "tool", text: write("pending") },
      { i: 11, kind: "echo", text: "ok" },
      { i: 12, kind: "tool", text: write("invalid") },
      { i: 13, kind: "echo", text: "invalid list" },
      { i: 14, kind: "user", text: "no plan here" },
      { i: 15, kind: "talk", text: "fine" },
    ]);
    expect(Object.fromEntries(planStates(rows, null))).toEqual({ e7: "turn", e10: "newest" });
  });
  test("a run id names the log index its turn started at, resumed or not", () => {
    expect([runStart("12"), runStart("12+1"), runStart("x"), runStart("")]).toEqual([12, 12, null, null]);
  });
  test("only the newest plan of the running run is live: one steered in after a plan doesn't make two", () => {
    const rows = entryRows([
      { i: 0, kind: "user", text: "old" },
      { i: 1, kind: "tool", text: write("completed") },
      { i: 2, kind: "echo", text: "ok" },
      { i: 3, kind: "user", text: "go" },
      { i: 4, kind: "tool", text: write("in_progress") },
      { i: 5, kind: "echo", text: "ok" },
      { i: 6, kind: "user", text: "and also this (steered)" },
      { i: 7, kind: "tool", text: write("in_progress") },
      { i: 8, kind: "echo", text: "ok" },
    ]);
    expect(Object.fromEntries(planStates(rows, 3))).toEqual({ e1: "turn", e4: "turn", e7: "live" });
    expect(Object.fromEntries(planStates(rows, null))).toEqual({ e1: "turn", e4: "turn", e7: "newest" });
    expect(Object.fromEntries(planStates(rows, 9))).toEqual({ e1: "turn", e4: "turn", e7: "newest" });
  });
});

describe("a plan and a turn's sources, from the log line to the row", () => {
  const date = "2026-10-05T10:00:00.000Z";
  const todos = JSON.stringify({ todos: [{ activeForm: "Searching", content: "Search", status: "in_progress" }, { content: "Answer", status: "pending" }] });
  const results = `Web search results for query: "q"\n\nLinks: ${JSON.stringify([{ title: "A", url: "https://a.example/" }])}`;
  const entries = [
    { date, i: 0, kind: "user" as const, size: 4, text: "look" },
    { date, i: 1, kind: "tool" as const, size: 10, text: `TodoWrite ${todos}` },
    { date, i: 2, kind: "echo" as const, size: 10, text: "Todos have been modified successfully." },
    { date, i: 3, kind: "tool" as const, size: 10, text: 'WebSearch {"query":"q"}' },
    { date, i: 4, kind: "echo" as const, size: 10, text: results },
    { date, i: 5, kind: "talk" as const, size: 10, text: "found it" },
  ];
  const expected = { plans: ["Search", "Answer"], sources: { e5: [{ title: "A", url: "https://a.example/" }] } };
  test("a snapshot", () => {
    const { first } = openStream({ entries, live: null, state: IDLE, thread: "mini", window: 50 });
    expect(readPatterns(play(emptyLog, ...decoded(first)))).toEqual(expected);
  });
  test("live events", () => {
    const { first, translate } = openStream({ entries: entries.slice(0, 1), live: null, state: IDLE, thread: "mini", window: 50 });
    const live = entries.slice(1).flatMap((e) => translate({ entry: e, runId: "1", type: "logged" }));
    expect(readPatterns(play(emptyLog, ...decoded(first), ...decoded(live)))).toEqual(expected);
  });
});
