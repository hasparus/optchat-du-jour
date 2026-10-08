// What one WebSocket connection is told (server/agui.ts): a reply cut off by a cancel never shares
// its id with the entry logged next, and a client that joins mid-reply or mid-tool gets all of it.
import { expect, test } from "bun:test";
import { type AGUIEvent, EventType } from "@ag-ui/core";
import { openStream } from "../server/agui.ts";
import type { LiveRun, SessionEvent, SessionState } from "../src/session.ts";
import { newMsg } from "../src/store.ts";
import type { Entry } from "../src/tree.ts";

const STATE: SessionState = { budget: 128_000, device: "mini", down: [], engine: null, engines: [{ down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" }], followUp: "steer", messages: 1, phase: "running", pending: [], stopped: null, viewBytes: 100, waiting: 0 };

function connect(entries: Entry[], live: LiveRun | null = null) {
  const { first, translate } = openStream({ entries, live, state: STATE, thread: "mini", window: 50 });
  const out: AGUIEvent[] = [...first];
  const feed = (...events: SessionEvent[]) => {
    for (const e of events) out.push(...translate(e));
  };
  return { feed, out };
}
const text = (at: number, offset: number, delta: string): SessionEvent => ({ at, delta, offset, runId: "0", type: "text" });
const contentOf = (out: readonly AGUIEvent[], id: string) =>
  out.flatMap((e) => (e.type === EventType.TEXT_MESSAGE_CONTENT && e.messageId === id ? [e.delta] : [])).join("");
// the first event from `after` on that passes `ok`
const where = (out: readonly AGUIEvent[], ok: (e: AGUIEvent) => boolean, after = 0) => out.findIndex((e, k) => k >= after && ok(e));

test("a reply cut off by a cancel is closed and dropped by a snapshot before its index goes to the next message", () => {
  const entries = [newMsg(0, "user", "hello")];
  const c = connect(entries);
  c.feed({ runId: "0", type: "run-started" }, text(1, 0, "half a"), text(1, 6, " reply"));
  c.feed({ error: "cancelled", logged: 1, runId: "0", type: "run-finished" });
  const next = newMsg(1, "user", "never mind, next question");
  entries.push(next);
  c.feed({ entry: next, runId: null, type: "logged" });

  const end = where(c.out, (e) => e.type === EventType.TEXT_MESSAGE_END && e.messageId === "1");
  const error = where(c.out, (e) => e.type === EventType.RUN_ERROR);
  const resync = where(c.out, (e) => e.type === EventType.MESSAGES_SNAPSHOT, error);
  const user = where(c.out, (e) => e.type === EventType.TEXT_MESSAGE_START && e.messageId === "1" && e.role === "user");
  expect(end).toBeGreaterThan(-1);
  expect(error).toBeGreaterThan(end);
  expect(resync).toBeGreaterThan(error); // the log has no reply at 1: the client drops the partial
  expect(user).toBeGreaterThan(resync); // and only then is 1 the new message
  const snap = c.out[resync];
  expect(snap?.type === EventType.MESSAGES_SNAPSHOT ? snap.messages.map((m) => m.id) : []).toEqual(["0"]);
});

test("a client that joins mid-reply gets the reply so far, then the rest without a repeat", () => {
  const entries = [newMsg(0, "user", "hello")];
  const c = connect(entries, { reply: { at: 1, text: "Hello wo" }, runId: "0" });
  expect(c.out.map((e) => e.type)).toEqual([
    EventType.MESSAGES_SNAPSHOT,
    EventType.STATE_SNAPSHOT,
    EventType.RUN_STARTED,
    EventType.TEXT_MESSAGE_START,
    EventType.TEXT_MESSAGE_CONTENT,
  ]);
  // events published while it connected overlap what it was seeded with
  c.feed({ runId: "0", type: "run-started" }, text(1, 6, "wo"), text(1, 8, "rld"));
  const talk = newMsg(1, "talk", "Hello world");
  entries.push(talk);
  c.feed({ entry: talk, runId: "0", type: "logged" }, { error: null, logged: 2, runId: "0", type: "run-finished" });
  expect(contentOf(c.out, "1")).toBe("Hello world");
  expect(c.out.filter((e) => e.type === EventType.RUN_STARTED)).toHaveLength(1);
  expect(c.out.filter((e) => e.type === EventType.TEXT_MESSAGE_START)).toHaveLength(1);
  expect(c.out.filter((e) => e.type === EventType.TEXT_MESSAGE_END)).toHaveLength(1);
});

test("a take-back is a CUSTOM event every client gets: the message with its attachments, or why not", () => {
  const c = connect([]);
  const photo = { bytes: 2048, height: 600, kind: "image", mime: "image/jpeg", sha: "a".repeat(64), width: 800 } as const;
  c.feed({ clientId: "c1", error: null, message: { media: [photo], text: "never mind" }, type: "taken-back" });
  c.feed({ clientId: "c2", error: "too late: the model has it", message: null, type: "taken-back" });
  expect(c.out.filter((e) => e.type === EventType.CUSTOM)).toEqual([
    { name: "taken-back", type: EventType.CUSTOM, value: { clientId: "c1", error: null, media: [photo], text: "never mind" } },
    { name: "taken-back", type: EventType.CUSTOM, value: { clientId: "c2", error: "too late: the model has it", media: [], text: null } },
  ]);
});

test("a client that joins while a tool runs gets its result under the call's id", () => {
  const entries = [newMsg(0, "user", "list it"), newMsg(1, "tool", 'Glob {"pattern":"*"}')];
  const c = connect(entries, { reply: null, runId: "0" });
  const snap = c.out.find((e) => e.type === EventType.MESSAGES_SNAPSHOT);
  const call = snap?.type === EventType.MESSAGES_SNAPSHOT ? snap.messages.at(-1) : undefined;
  const id = call?.role === "assistant" ? call.toolCalls?.[0]?.id : undefined;
  expect(id).toBeDefined();
  const echo = newMsg(2, "echo", "a.txt");
  entries.push(echo);
  c.feed({ entry: echo, runId: "0", type: "logged" });
  const result = c.out.find((e) => e.type === EventType.TOOL_CALL_RESULT);
  expect(result?.type === EventType.TOOL_CALL_RESULT ? result.toolCallId : undefined).toBe(id);
});
