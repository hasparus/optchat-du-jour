// The client's own logic: the link, the log, the session store, rows and stats. No DOM needed.
import { EventType } from "@ag-ui/core";
import type { Kind, UsageRecord } from "@wire";
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ack, type Entry, fakeServer, IDLE, parseSent, said, snapshot, state } from "../test/fixture";
import { openLink } from "./connection";
import { sentKey } from "./draft";
import { applyEvent, applyPage, emptyLog, hole, type Log, MAX_HELD, tip, trimHeld, visible, withDraft } from "./log";
import type { Inbound } from "./protocol";
import { chatRows, entryRows, rowFor, rowIndexFor } from "./rows";
import { makeSession, queued, type Session, UNSENT } from "./session";
import { buckets, periodOf, totals } from "./stats";

const tick = async (ms = 5) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// what the link and the store warn about, kept out of the test output
const warn = spyOn(console, "warn").mockImplementation(() => {
  // silent
});
beforeEach(() => {
  warn.mockClear();
});
afterAll(() => {
  warn.mockRestore();
});

// a session over a server whose log holds one message
const setup = async () => {
  const server = fakeServer(() => [snapshot([{ kind: "user", text: "old" }]), { snapshot: { ...IDLE, messages: 1 }, type: EventType.STATE_SNAPSHOT }]);
  const link = openLink("ws://x/ws", { socket: server.socket });
  const session = makeSession(link);
  await tick();
  return { link, server, session };
};

const entry = (i: number, kind: Kind, text: string) => ({ date: "2026-10-05T10:00:00Z", i, kind, text });

// the log's rows as `key kind text` lines, the draft included
const rowsOf = (log: Log) =>
  entryRows(withDraft(visible(log), log.draft)).map((r) => `${r.key} ${r.kind} ${r.kind === "tool" ? `${r.name} ${r.args} -> ${r.output}` : r.text}`);
const play = (log: Log, ...events: readonly Inbound[]) => {
  let out = log;
  for (const e of events) out = applyEvent(out, e);
  return out;
};

const run = (i: number): Inbound => ({ runId: String(i), threadId: "mini", type: EventType.RUN_STARTED });
const finished = (i: number): Inbound => ({ runId: String(i), threadId: "mini", type: EventType.RUN_FINISHED });
const text = (i: number, delta: string): Inbound => ({ delta, messageId: String(i), type: EventType.TEXT_MESSAGE_CONTENT });
const start = (i: number): Inbound => ({ messageId: String(i), role: "assistant", type: EventType.TEXT_MESSAGE_START });
const end = (i: number): Inbound => ({ messageId: String(i), type: EventType.TEXT_MESSAGE_END });
const tool = (i: number, name: string, args: string): Inbound[] => [
  { parentMessageId: String(i), toolCallId: `t${i}`, toolCallName: name, type: EventType.TOOL_CALL_START },
  { delta: args, toolCallId: `t${i}`, type: EventType.TOOL_CALL_ARGS },
  { toolCallId: `t${i}`, type: EventType.TOOL_CALL_END },
];
const echo = (i: number, call: number, content: string): Inbound => ({ content, messageId: String(i), role: "tool", toolCallId: `t${call}`, type: EventType.TOOL_CALL_RESULT });

// a log of `total` user messages m0, m1, …; the server's window is its last 200 entries
const all = (n: number) => Array.from({ length: n }, (_, i): Entry => ({ kind: "user", text: `m${i}` }));
const longLog = (total: { n: number }) => {
  const server = fakeServer(() => [snapshot(all(total.n).slice(-200), Math.max(0, total.n - 200)), { snapshot: { ...IDLE, messages: total.n }, type: EventType.STATE_SNAPSHOT }]);
  const asked: string[] = [];
  const messages = async (before: number, limit: number) => {
    asked.push(`${before}/${limit}`);
    const from = Math.max(0, before - limit);
    return { entries: all(total.n).slice(from, before).map((e, k) => entry(from + k, e.kind, e.text)) };
  };
  const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
  return { asked, link, server, session: makeSession(link, { messages }) };
};
const shown = (log: Log) => visible(log).map((x) => x.i);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => from + k);

const rec = (date: string, o: Partial<UsageRecord>): UsageRecord => ({
  attempt: 1,
  auth: "claude-max",
  cold: false,
  date,
  device: "mini",
  engine: "claude-code",
  failoverFrom: null,
  level: null,
  model: "opus",
  ms: 1,
  role: "turn",
  usage: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
  ...o,
});

describe("link", () => {
  test("reconnects after a drop and sends a message written while it was down, but not a cancel", async () => {
    const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
    const statuses: string[] = [];
    link.onStatus((s) => {
      statuses.push(s);
    });
    await tick();
    expect(link.status()).toBe("open");
    server.drop();
    link.send("while down", "id-1", { device: "macbook" });
    expect(link.abort()).toBe(false); // kept, it would cancel whatever turn runs after the reconnect
    expect(server.sent).toHaveLength(0);
    await tick();
    expect(server.sockets).toHaveLength(2);
    expect(statuses).toEqual(["open", "closed", "connecting", "open"]);
    expect(server.sent).toHaveLength(1);
    const frame = parseSent(server.sent[0] ?? "{}");
    expect(frame.messages?.at(-1)).toMatchObject({ content: "while down", id: "id-1", role: "user" });
    expect(frame.forwardedProps?.device).toBe("macbook");
    expect(link.abort()).toBe(true);
    expect(server.sent[1]).toBe('{"type":"abort"}');
    link.close();
  });

  test("a frame that isn't one of ours is dropped with a warning, not passed on", async () => {
    const server = fakeServer(() => []);
    const link = openLink("ws://x/ws", { socket: server.socket });
    const seen: Inbound[] = [];
    link.listen((e) => {
      seen.push(e);
    });
    await tick();
    server.sockets[0]?.fire("message", { data: '{"type":"TEXT_MESSAGE_CONTENT"}' });
    server.sockets[0]?.fire("message", { data: "not json" });
    server.play(...said(0, "user", "hi"));
    expect(seen.map((e) => e.type)).toEqual([EventType.TEXT_MESSAGE_START, EventType.TEXT_MESSAGE_CONTENT, EventType.TEXT_MESSAGE_END]);
    expect(warn).toHaveBeenCalledTimes(2);
    link.close();
  });
});

describe("log", () => {
  const LOG: Entry[] = [
    { kind: "user", text: "u0" },
    { kind: "talk", text: "t1" },
  ];

  test("a live turn's rows keep their log index as key from the first event to the snapshot after it", () => {
    let log = play(emptyLog, snapshot(LOG), ...said(2, "user", "go"), run(2));
    log = play(log, start(3), text(3, "before "));
    expect(rowsOf(log).at(-1)).toBe("e3 talk before ");
    log = play(log, text(3, "tool"), end(3), ...tool(4, "Bash", '{"command":"ls"}'));
    expect(rowsOf(log).slice(2)).toEqual(["e2 user go", "e3 talk before tool", 'e4 tool Bash {"command":"ls"} -> null']);
    log = play(log, echo(5, 4, "OUT"), start(6), text(6, "after"));
    const live = ["e2 user go", "e3 talk before tool", 'e4 tool Bash {"command":"ls"} -> OUT', "e6 talk after"];
    expect(rowsOf(log).slice(2)).toEqual(live);
    log = play(log, end(6), finished(2));
    const logged: Entry[] = [...LOG, { kind: "user", text: "go" }, { kind: "talk", text: "before tool" }, { kind: "tool", text: 'Bash {"command":"ls"}' }, { kind: "echo", text: "OUT" }, { kind: "talk", text: "after" }];
    log = play(log, snapshot(logged));
    expect(rowsOf(log).slice(2)).toEqual(live);
    expect(log.draft).toBeNull();
  });

  test("a run that starts with a tool call: each call is its own row", () => {
    const log = play(emptyLog, snapshot(LOG), ...said(2, "user", "go"), run(2), ...tool(3, "Bash", "{}"), echo(4, 3, "OUT"), ...tool(5, "Read", '{"f":"x"}'), echo(6, 5, "OUT2"));
    expect(rowsOf(log).slice(2)).toEqual(["e2 user go", "e3 tool Bash {} -> OUT", 'e5 tool Read {"f":"x"} -> OUT2']);
  });

  test("a reply cut off by a cancel is gone after the run's snapshot; the next message gets its own row", () => {
    let log = play(emptyLog, snapshot(LOG), ...said(2, "user", "cancel me"), run(2), start(3), text(3, "Streamed "));
    // the server closes the reply, ends the run, and sends the log as it is: nothing logged at 3
    log = play(log, end(3), { message: "cancelled", type: EventType.RUN_ERROR }, snapshot([...LOG, { kind: "user", text: "cancel me" }]));
    log = play(log, ...said(3, "user", "AFTER CANCEL"), run(3));
    expect(rowsOf(log).slice(2)).toEqual(["e2 user cancel me", "e3 user AFTER CANCEL"]);
  });

  test("the log keeps its newest index as entries arrive, and only a recent window of them", () => {
    let log = play(emptyLog, snapshot(LOG), ...said(2, "user", "go"), start(3), text(3, "draft"));
    expect([log.newest, tip(log)]).toEqual([2, 3]); // the draft is not an entry yet
    log = play(log, end(3));
    expect([log.newest, tip(log)]).toEqual([3, 3]);
    log = applyPage(log, [entry(0, "user", "u0")]);
    expect(log.newest).toBe(3);
    // a snapshot after a deep scroll up keeps all of it while the reader is still up there…
    const many = Array.from({ length: MAX_HELD + 300 }, (_, i) => ({ i, kind: "user" as const, live: false, text: `m${i}` }));
    const deep: Log = { base: 0, draft: null, items: new Map(many.map((m) => [m.i, m])), newest: many.length - 1 };
    const tail = snapshot([{ kind: "user", text: "tail" }], many.length);
    const reading = applyEvent(deep, tail, { trim: false });
    expect(reading.items.size).toBe(many.length + 1);
    expect(trimHeld(reading).items.size).toBe(MAX_HELD); // …and back at the newest end, only the newest MAX_HELD
    const next = play(deep, tail);
    expect(next.items.size).toBe(MAX_HELD);
    expect(next.items.has(many.length)).toBe(true);
    expect(visible(next).at(0)?.i).toBe(many.length + 1 - MAX_HELD);
    expect(hole(next)).toBeNull();
  });

  test("the draft is one row after the settled ones, which keep their objects; one that rewrites an entry replaces it", () => {
    const tools: Entry[] = [...LOG, { kind: "tool", text: "Bash {}" }, { kind: "echo", text: "out" }, { kind: "talk", text: "done" }];
    const log = play(emptyLog, snapshot(tools), start(5), text(5, "a"));
    const items = visible(log);
    const settled = entryRows(items);
    const live = chatRows(items, settled, log.draft);
    expect(live.slice(0, -1).every((r, k) => r === settled[k])).toBe(true);
    expect(live.map((r) => r.id)).toEqual([0, 1, 2, 4, 5]); // the echo at 3 is the tool row's
    const same = play(log, text(5, "b"));
    expect(chatRows(items, settled, same.draft).at(-1)).toMatchObject({ id: 5, text: "ab" });
    // a draft at an index already held (a late joiner's seed) replaces that entry's row
    const rewrite = chatRows(items, settled, { i: 4, kind: "talk", text: "again" });
    expect(rewrite.map((r) => r.id)).toEqual([0, 1, 2, 4]);
    expect(rewrite.at(-1)).toMatchObject({ text: "again" });
    expect([-1, 0, 1, 2, 3, 4, 9].map((i) => rowIndexFor(settled, i))).toEqual([-1, 0, 1, 2, 2, 3, 3]);
  });

  test("an older page overlapping the window replaces what it covers, without duplicates", () => {
    let log = play(emptyLog, snapshot([{ kind: "user", text: "m100" }, { kind: "user", text: "m101" }, { kind: "user", text: "m102" }], 100));
    log = applyPage(log, [98, 99, 100, 101].map((i) => entry(i, "user", `m${i}`)));
    expect(rowsOf(log)).toEqual(["e98 user m98", "e99 user m99", "e100 user m100", "e101 user m101", "e102 user m102"]);
  });

  test("a page that joins mid-reply streams the rest; a snapshot puts the logged text in its place", () => {
    let log = play(emptyLog, snapshot([...LOG, { kind: "user", text: "go" }]), text(3, "half"));
    expect(rowsOf(log).at(-1)).toBe("e3 talk half");
    log = play(log, end(3), finished(2), snapshot([...LOG, { kind: "user", text: "go" }, { kind: "talk", text: "the whole reply" }]));
    expect(rowsOf(log).at(-1)).toBe("e3 talk the whole reply");
  });

  test("a snapshot keeps older pages under its window, and reads again what only live events told", () => {
    let log = play(emptyLog, snapshot([{ kind: "user", text: "m2" }], 2), ...said(3, "user", "live"));
    log = { ...log, items: new Map(log.items).set(0, { i: 0, kind: "user", live: false, text: "m0" }).set(1, { i: 1, kind: "user", live: false, text: "m1" }) };
    expect(visible(log).map((x) => x.i)).toEqual([0, 1, 2, 3]);
    log = play(log, snapshot([{ kind: "user", text: "m5" }], 5));
    // 0..2 came from pages and the snapshot, 3 only live: a hole from 3 to 4, which hides 0..2
    expect(visible(log).map((x) => x.i)).toEqual([5]);
    expect(hole(log)).toEqual({ before: 5, limit: 2 });
  });
});

// user entries from..to-1: m<i>, except "same" at 12 and 600
const twice = (from: number, to: number) => Array.from({ length: to - from }, (_, k): Entry => ({ kind: "user", text: from + k === 12 || from + k === 600 ? "same" : `m${from + k}` }));
// /api/messages over `twice`
const twicePages = async (before: number, limit: number) => {
  const from = Math.max(0, before - limit);
  return { entries: twice(from, before).map((e, k) => entry(from + k, e.kind, e.text)) };
};
const waiting = (session: { readonly get: () => Session }) => queued(session.get()).map((q) => (q.error === null ? q.text : `${q.text} (${q.error})`));
const idOf = (server: { readonly sent: readonly string[] }, k: number) => parseSent(server.sent[k] ?? "{}").messages?.at(-1)?.id ?? "";

describe("session", () => {
  // a resume kept for later would settle whatever turn waits after the reconnect, maybe retrying
  // the engine that just hit its limit: the user never chose that
  test("a resume goes out only while connected and says when it didn't; the follow-up setting and a message wait for the connection", async () => {
    const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { socket: server.socket }); // it opens once this test yields
    const session = makeSession(link);
    expect(session.resume("openai-plan:gpt-6.1-sol")).toBe(false);
    expect(session.get().markers.map((m) => m.text)).toEqual(["not connected: the resume was not sent"]);
    link.configure({ followUp: "queue" });
    session.send("for sol", { engine: "openai-plan:gpt-6.1-sol" });
    await tick();
    const { sent } = server;
    // no resume replayed; the message names its engine
    expect(sent.map((f) => parseSent(f))).toMatchObject([{ followUp: "queue", type: "settings" }, { forwardedProps: { engine: "openai-plan:gpt-6.1-sol" } }]);
    expect(session.resume("openai-plan:gpt-6.1-sol")).toBe(true);
    expect(parseSent(sent.at(-1) ?? "")).toEqual({ engine: "openai-plan:gpt-6.1-sol", type: "resume" });
  });

  test("messages sent before a reload from below the loaded window are looked for in /api/messages up to it; only the missing are offered to send again", async () => {
    const sent = [
      { from: 10, id: "a", media: [], text: "m12" },
      { from: 20, id: "b", media: [], text: "never logged" },
    ];
    localStorage.setItem(sentKey, JSON.stringify({ at: Date.now(), sent }));
    const { asked, session } = longLog({ n: 700 }); // the window holds 500..699
    await tick(20);
    expect(asked).toEqual(["500/490"]); // from the oldest one's `from` to the window, one page
    expect(waiting(session)).toEqual([`never logged (${UNSENT})`]);
  });

  test("two kept messages with the same text, one from below the window: each is matched once, in log order, and neither is marked", async () => {
    const sent = [
      { from: 10, id: "a", media: [], text: "same" },
      { from: 550, id: "b", media: [], text: "same" },
    ];
    localStorage.setItem(sentKey, JSON.stringify({ at: Date.now(), sent }));
    // the log has "same" at 12 (a's) and at 600 (b's); the window holds 500..699
    const server = fakeServer(() => [snapshot(twice(500, 700), 500), { snapshot: { ...IDLE, messages: 700 }, type: EventType.STATE_SNAPSHOT }]);
    const session = makeSession(openLink("ws://x/ws", { retryMs: 1, socket: server.socket }), { messages: twicePages });
    await tick(20);
    expect(waiting(session)).toEqual([]);
  });

  test("a take-back asked for and not answered is forgotten on a reconnect, so it can be asked again", async () => {
    const held = [{ clientId: "q1", engine: "claude-code:opus", queued: true, text: "for later" }];
    const server = fakeServer(() => [snapshot([]), { snapshot: { ...IDLE, pending: held, phase: "running" }, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
    const session = makeSession(link);
    await tick();
    const [q] = queued(session.get());
    if (!q) throw new Error("nothing queued");
    expect(session.takeBack(q)).toBe(true);
    expect(session.get().asking).toEqual(["q1"]);
    server.drop(); // the answer goes to the old socket
    await tick(20);
    expect(session.get().asking).toEqual([]);
  });

  test("a message sent here waits in the queue until the server's ack for its id, also mid-run", async () => {
    const { server, session } = await setup();
    session.send("old"); // the same text as an entry already logged: still pending, by id
    expect(waiting(session)).toEqual(["old"]);
    server.play(state({ phase: "running", pending: [{ clientId: idOf(server, 0), engine: "claude-code:opus", queued: false, text: "old" }] }));
    expect(waiting(session)).toEqual(["old"]); // the server's copy and ours are one message
    server.play(ack("someone else's", 1)); // another client's message: not ours
    expect(waiting(session)).toEqual(["old"]);
    server.play(ack(idOf(server, 0), 1), ...said(1, "user", "old"), state({ pending: [] }));
    expect(waiting(session)).toEqual([]);
  });

  test("two messages with the same text are told apart by their ids", async () => {
    const { server, session } = await setup();
    session.send("again");
    session.send("again");
    server.play(ack(idOf(server, 1), 1), ...said(1, "user", "again"));
    expect(session.get().pending.map((p) => p.id)).toEqual([idOf(server, 0)]);
    expect(waiting(session)).toEqual(["again"]);
  });

  test("a message the log refused shows as not logged with the error, until the log holds it", async () => {
    const { server, session } = await setup();
    session.send("lost?");
    server.play(ack(idOf(server, 0), null, "disk full"));
    expect(waiting(session)).toEqual(["lost? (disk full)"]);
    // it stayed queued there: the next message's run logs it, and its text is matched even
    // without the ack that comes with it
    server.play(...said(1, "user", "lost?"));
    expect(waiting(session)).toEqual([]);
  });

  test("an entry acked to another message is never claimed by text, also when the ack was another client's", async () => {
    const { server, session } = await setup();
    session.send("same");
    server.play(ack(idOf(server, 0), null, "disk full"));
    // this page's second "same" and another client's are logged, each with its own ack
    session.send("same");
    server.play(ack(idOf(server, 1), 1), ...said(1, "user", "same"), ack("someone else's", 2), ...said(2, "user", "same"));
    expect(waiting(session)).toEqual(["same (disk full)"]);
    server.play(ack(idOf(server, 0), 3), ...said(3, "user", "same"));
    expect(waiting(session)).toEqual([]);
  });

  test("an ack lost to a dropped connection is made up from the snapshot after it; one for the new connection is not", async () => {
    const log = { n: 1 };
    const server = fakeServer(() => [snapshot([{ kind: "user", text: "old" }, ...Array.from({ length: log.n - 1 }, (): Entry => ({ kind: "user", text: "lost ack" }))]), { snapshot: { ...IDLE, messages: log.n }, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
    const session = makeSession(link);
    await tick();
    session.send("lost ack");
    session.send("not yet");
    log.n = 2; // "lost ack" was logged while the page was away; its ack went to the old socket
    server.drop();
    await tick(20);
    // "not yet" went out on the old socket too, and neither the log nor the queue has it
    expect(waiting(session)).toEqual([`not yet (${UNSENT})`]);
    // sent on the new connection, its text in the log is not enough: its own ack decides
    session.send("lost ack");
    server.play(snapshot([{ kind: "user", text: "old" }, { kind: "user", text: "lost ack" }]));
    expect(waiting(session)).toEqual([`not yet (${UNSENT})`, "lost ack"]);
  });

  test("a message sent on a connection that dropped is kept, marked, unless the log or the server's queue has it", async () => {
    let heldThere: readonly { readonly clientId: string | null; readonly engine: string; readonly queued: boolean; readonly text: string }[] = [];
    const server = fakeServer(() => [snapshot([{ kind: "user", text: "old" }]), { snapshot: { ...IDLE, messages: 1, pending: heldThere }, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
    const session = makeSession(link);
    await tick();
    session.send("in flight");
    session.send("held there");
    heldThere = [{ clientId: idOf(server, 1), engine: "claude-code:opus", queued: false, text: "held there" }]; // the server had it, in any state of its inbox, when the socket dropped
    server.drop();
    await tick(20);
    expect(waiting(session)).toEqual(["held there", `in flight (${UNSENT})`]);
    // the log takes it after all: it is gone from the queue
    server.play(...said(1, "user", "in flight"));
    expect(waiting(session)).toEqual(["held there"]);
  });

  test("after a reconnect the server's copy is told by the client id, not the text: of two equal texts only the lost one is marked", async () => {
    let heldThere: readonly { readonly clientId: string | null; readonly engine: string; readonly queued: boolean; readonly text: string }[] = [];
    const server = fakeServer(() => [snapshot([{ kind: "user", text: "old" }]), { snapshot: { ...IDLE, messages: 1, pending: heldThere }, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
    const session = makeSession(link);
    await tick();
    session.send("same");
    session.send("same");
    heldThere = [{ clientId: idOf(server, 1), engine: "claude-code:opus", queued: false, text: "same" }]; // held while it waited for summaries: the second one only
    server.drop();
    await tick(20);
    expect(session.get().pending.map((p) => p.error)).toEqual([UNSENT, null]);
    expect(waiting(session)).toEqual(["same", `same (${UNSENT})`]);
  });

  test("a status marker goes after the last entry the run's snapshot holds, not after a cut-off reply's index", async () => {
    const { server, session } = await setup();
    server.play(...said(1, "user", "cancel me"), run(1), start(2), text(2, "Streamed "));
    server.play(end(2), { name: "info", type: EventType.CUSTOM, value: "cancelled" }, { message: "cancelled", type: EventType.RUN_ERROR });
    expect(session.get().markers.map((m) => m.after)).toEqual([2, 2]);
    server.play(snapshot([{ kind: "user", text: "old" }, { kind: "user", text: "cancel me" }]));
    expect(session.get().markers.map((m) => m.after)).toEqual([1, 1]);
    server.play(...said(2, "user", "AFTER CANCEL"));
    const rows = entryRows(visible(session.get().log));
    expect(rows.map((r) => r.id)).toEqual([0, 1, 2]);
    expect(session.get().markers.every((m) => rowIndexFor(rows, m.after) === 1)).toBe(true); // before the row at 2
  });

  test("info and run errors become markers after the newest entry; thinking ends with text", async () => {
    const { server, session } = await setup();
    server.play({ name: "info", type: EventType.CUSTOM, value: "compactor: 0+1 failed" });
    server.play({ name: "thinking", type: EventType.CUSTOM, value: { tokens: 9 } });
    expect(session.get().thinking).toBe(true);
    server.play(...said(1, "assistant", "hello"), { message: "usage limit", type: EventType.RUN_ERROR });
    expect(session.get().thinking).toBe(false);
    expect(session.get().markers.map((m) => [m.after, m.tone, m.text])).toEqual([
      [0, "info", "compactor: 0+1 failed"],
      [1, "error", "usage limit"],
    ]);
  });

  test("a state patch it can't apply is logged and skipped; the rest of the frame applies", async () => {
    const { server, session } = await setup();
    server.play({
      delta: [
        { op: "move", path: "/device" },
        { op: "replace", path: "/phase", value: "running" },
        { op: "replace", path: "/pending/0", value: "x" },
      ],
      type: EventType.STATE_DELTA,
    });
    expect(session.get().state?.phase).toBe("running");
    expect(session.get().state?.pending).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("a reconnect with older pages loaded leaves no gap, however much was logged meanwhile", async () => {
    const total = { n: 300 };
    const { asked, server, session } = longLog(total);
    await tick();
    expect(shown(session.get().log)).toEqual(range(100, 300));
    expect(await session.loadOlder()).toBe(false);
    expect(shown(session.get().log)).toEqual(range(0, 300));
    total.n = 320; // the phone sleeps; 20 more are logged
    server.drop();
    await tick(20);
    expect(shown(session.get().log)).toEqual(range(0, 320));
    total.n = 700; // a long sleep: the window moves past everything held, and the hole is fetched
    server.drop();
    await tick(20);
    expect(shown(session.get().log)).toEqual(range(0, 700));
    expect(asked).toEqual(["100/100", "500/180"]);
    total.n = 1500; // a hole too wide to fetch: what lies under it is dropped
    server.drop();
    await tick(20);
    expect(shown(session.get().log)).toEqual(range(1300, 1500));
    expect(hole(session.get().log)).toBeNull();
  });
});

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
    // not across a hole in the log
    expect(entryRows([entry(1, "tool", "Bash"), entry(5, "echo", "x")]).map((r) => r.id)).toEqual([1, 5]);
  });
});

describe("stats", () => {
  const records = [
    rec("2026-10-05T10:00:00", { cold: true, usage: { cacheRead: 0, cacheWrite: 900, input: 100, output: 10 } }),
    rec("2026-10-05T11:00:00", { usage: { cacheRead: 900, cacheWrite: 0, input: 100, output: 10 } }),
    rec("2026-10-07T09:00:00", { engine: "openai-plan", failoverFrom: "claude-code:opus", role: "compact" }),
  ];

  test("per day and per week, split by role or engine, with the cache hit rate and cold turns", () => {
    expect(periodOf("2026-10-07T09:00:00", "week")).toBe("2026-10-05"); // a Wednesday, in the week of Monday the 5th
    const days = buckets(records, "day", "role");
    expect(days.map((b) => [b.period, b.calls, b.cold, b.warm])).toEqual([
      ["2026-10-05", { turn: 2 }, 1, 1],
      ["2026-10-07", { compact: 1 }, 0, 0],
    ]);
    expect(days[0]?.hitRate).toBeCloseTo(900 / 2000);
    expect(days[1]?.hitRate).toBeNull();
    const weeks = buckets(records, "week", "engine");
    expect(weeks.map((b) => b.calls)).toEqual([{ "claude-code": 2, "openai-plan": 1 }]);
    const all = totals(records);
    expect([all.calls, all.tokens, all.coldTurns, all.turns, all.failovers.length]).toEqual([3, 2020, 1, 2, 1]);
  });
});
