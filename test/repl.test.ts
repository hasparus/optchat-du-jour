// The REPL's screen: what reaches the terminal when the server's events and the user's keys interleave.
import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { ABORT, type Action, type Inbound, makeLink, makeScreen, parseInbound } from "../cli/repl.ts";

const IDLE = { budget: 128_000, device: "mini", messages: 3, phase: "idle", viewBytes: 1000, waiting: 0 } satisfies Record<string, string | number>;

function screen(tty = true) {
  let out = "";
  const s = makeScreen({ color: false, columns: () => 80, tty, write: (x) => {
      out += x;
    },
  });
  const feed = (...events: Inbound[]) => {
    for (const e of events) s.event(Option.getOrThrow(parseInbound(JSON.stringify(e))));
  };
  return { feed, out: () => out, s };
}
// the server's word that a message sent from here (its client id) is log entry `id`, or was not logged
const ack = (clientId: string, id: string | null, error: string | null = null): Inbound => ({
  name: "ack",
  type: "CUSTOM",
  value: { clientId, error, messageId: id },
});
const idOf = (a: Action | null) => (a?.type === "send" ? a.id : "");
const said = (id: string, role: string, text: string): Inbound[] => [
  { messageId: id, role, type: "TEXT_MESSAGE_START" },
  { delta: text, messageId: id, type: "TEXT_MESSAGE_CONTENT" },
  { messageId: id, type: "TEXT_MESSAGE_END" },
];

describe("repl screen", () => {
  test("a message typed here is not shown twice; one from another client is, even with the same text", () => {
    const t = screen();
    t.feed({ snapshot: IDLE, type: "STATE_SNAPSHOT" });
    for (const ch of "hello") t.s.key({ text: ch, type: "text" });
    const sent = t.s.key({ type: "enter" });
    expect(sent).toMatchObject({ text: "hello", type: "send" });
    const before = t.out();
    t.feed(...said("3", "user", "hello"), ack(idOf(sent), "4"), ...said("4", "user", "hello"), ...said("5", "user", "from the phone"), ...said("6", "assistant", "hi"));
    const after = t.out().slice(before.length);
    expect(after.match(/> hello\n/g)).toHaveLength(1); // the phone's "hello" at 3; ours at 4 is on screen already
    expect(after).toContain("> from the phone\n");
    expect(after).toContain("hi\n");
  });

  test("a photo sent from the phone shows as its text and marker line, as the log holds it", () => {
    const t = screen(false);
    t.feed({ snapshot: { ...IDLE, pending: [{ attachments: 1, clientId: "p1", text: "look" }] }, type: "STATE_SNAPSHOT" });
    t.feed(...said("3", "user", "look\n[image 9d0c38e7aafe 1568x1176 212KB: a whiteboard with three arrows]"));
    expect(t.out()).toContain("[image 9d0c38e7aafe 1568x1176 212KB: a whiteboard with three arrows]");
  });

  test("follow-ups: /queue and /steer set the server's setting; ours held for the next turn, or taken back, are said once", () => {
    const t = screen();
    t.feed({ snapshot: { ...IDLE, followUp: "steer", phase: "running" }, type: "STATE_SNAPSHOT" });
    expect(t.out()).toContain("follow-ups steer");
    for (const ch of "/queue") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toEqual({ followUp: "queue", type: "follow-up" });
    t.feed({ delta: [{ op: "replace", path: "/followUp", value: "queue" }], type: "STATE_DELTA" });
    expect(t.out()).toContain("follow-ups: queued for the next turn\n");
    for (const ch of "later") t.s.key({ text: ch, type: "text" });
    const sent = t.s.key({ type: "enter" });
    const pending = [{ clientId: idOf(sent), queued: true, text: "later" }];
    t.feed({ delta: [{ op: "replace", path: "/pending", value: pending }], type: "STATE_DELTA" });
    t.feed({ delta: [{ op: "replace", path: "/pending", value: pending }], type: "STATE_DELTA" });
    expect(t.out().match(/queued for the next turn: later\n/g)).toHaveLength(1);
    // the phone took it back: it is not answered, and nothing waits for it
    t.feed({ name: "taken-back", type: "CUSTOM", value: { clientId: idOf(sent), error: null, text: "later" } });
    expect(t.out()).toContain("taken back, not sent: later\n");
    expect([t.s.unanswered, t.s.failed]).toEqual([0, 1]);
  });

  test("a turn waiting for a model: the REPL lists the engines, and /model picks one by number or ref", () => {
    const t = screen();
    const engines = [
      { down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
      { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
    ];
    t.feed({ snapshot: { ...IDLE, engines, lead: "claude-code:opus", phase: "running", stopped: null }, type: "STATE_SNAPSHOT" });
    const down = [
      { down: "Claude AI usage limit reached", label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
      { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
    ];
    const stopped = { label: "Claude Opus (Claude Code)", ref: "claude-code:opus", why: "usage limit: Claude AI usage limit reached" };
    t.feed({ delta: [{ op: "replace", path: "/engines", value: down }, { op: "replace", path: "/phase", value: "needs-model" }, { op: "replace", path: "/stopped", value: stopped }], type: "STATE_DELTA" });
    t.feed({ message: "usage limit: Claude AI usage limit reached", type: "RUN_ERROR" });
    expect(t.out()).toContain("Claude Opus (Claude Code) stopped: usage limit: Claude AI usage limit reached. /model <n> picks one to go on");
    expect(t.out()).not.toContain("error: usage limit"); // said once
    expect(t.out()).toContain("  1. Claude Opus (Claude Code) (in use) (unavailable: Claude AI usage limit reached)\n");
    expect(t.out()).toContain("  2. GPT-6.1 Sol (ChatGPT plan)\n");
    expect(t.s.stuck).toBe(true);
    for (const ch of "/model 2") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toEqual({ lead: "openai-plan:gpt-6.1-sol", type: "pick" });
    for (const ch of "/model claude-code:opus") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toEqual({ lead: "claude-code:opus", type: "pick" });
    for (const ch of "/model 9") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toBeNull();
    expect(t.out()).toContain("no model 9: /model lists them\n");
    t.feed({ delta: [{ op: "replace", path: "/lead", value: "openai-plan:gpt-6.1-sol" }, { op: "replace", path: "/phase", value: "running" }], type: "STATE_DELTA" });
    expect(t.out()).toContain("model: GPT-6.1 Sol (ChatGPT plan)\n");
    expect(t.s.stuck).toBe(false);
  });

  test("output that arrives while typing keeps the typed text below it", () => {
    const t = screen();
    t.feed({ snapshot: { ...IDLE, phase: "running" }, type: "STATE_SNAPSHOT" });
    for (const ch of "next") t.s.key({ text: ch, type: "text" });
    t.feed({ name: "info", type: "CUSTOM", value: "compactor: 1+2 failed" });
    expect(t.out().endsWith("\r\u001B[2Kcompactor: 1+2 failed\n> next")).toBe(true);
  });

  test("Ctrl-C cancels a turn, and exits only when pressed twice with nothing between", () => {
    const t = screen();
    t.feed({ snapshot: { ...IDLE, phase: "running" }, type: "STATE_SNAPSHOT" });
    expect(t.s.key({ type: "interrupt" })).toEqual({ type: "abort" });
    t.feed({ delta: [{ op: "replace", path: "/phase", value: "idle" }], type: "STATE_DELTA" });
    t.s.key({ text: "x", type: "text" });
    expect(t.s.key({ type: "interrupt" })).toBeNull(); // a key came between: the line is dropped
    expect(t.s.key({ type: "interrupt" })).toEqual({ type: "exit" });
  });

  test("model text can't drive the terminal", () => {
    const t = screen();
    t.feed(...said("7", "assistant", "a\u001B]52;c;Zm9v\u0007b\u009Bc"));
    expect(t.out()).toContain("a]52;c;Zm9vbc\n");
    expect(t.out()).not.toContain("\u001B]");
  });

  test("piped: each line is a message, echoed", () => {
    const t = screen(false);
    t.feed({ snapshot: IDLE, type: "STATE_SNAPSHOT" });
    expect(t.s.submit("  first ")).toMatchObject({ text: "first", type: "send" });
    expect(t.s.submit("")).toBeNull();
    expect(t.out()).toContain("> first\n");
    expect(t.out()).not.toContain("> \n");
    expect(t.s.busy).toBe(true);
  });

  test("piped: a message is answered when the run that logged it ends, not when the server says idle", () => {
    const t = screen(false);
    const slow = idOf(t.s.submit("slow one"));
    t.feed({ snapshot: IDLE, type: "STATE_SNAPSHOT" }); // the server has not read it yet
    expect(t.s.unanswered).toBe(1);
    t.feed(ack(slow, "3"), ...said("3", "user", "slow one"), { type: "RUN_STARTED" });
    expect(t.s.unanswered).toBe(1);
    t.feed(...said("4", "assistant", "done"), { type: "RUN_FINISHED" });
    expect(t.s.unanswered).toBe(0);

    // cancelled from another client before its run began: logged unanswered, no run end, then idle
    const never = idOf(t.s.submit("never answered"));
    t.feed({ delta: [{ op: "replace", path: "/phase", value: "waiting" }], type: "STATE_DELTA" });
    t.feed(ack(never, "5"), ...said("5", "user", "never answered"));
    expect(t.s.unanswered).toBe(1);
    t.feed({ delta: [{ op: "replace", path: "/phase", value: "idle" }], type: "STATE_DELTA" });
    expect(t.s.unanswered).toBe(0);
    expect(t.s.failed).toBe(0);
  });

  test("piped: a message whose run ends in an error counts as answered, with an error", () => {
    const t = screen(false);
    const asked = idOf(t.s.submit("refused one"));
    t.feed({ snapshot: IDLE, type: "STATE_SNAPSHOT" }, ack(asked, "3"), ...said("3", "user", "refused one"), { type: "RUN_STARTED" });
    t.feed({ message: "declined", type: "RUN_ERROR" });
    expect(t.s.unanswered).toBe(0);
    expect(t.s.failed).toBe(1);
  });

  test("piped: a message the server could not log counts as answered, with an error", () => {
    const t = screen(false);
    const lost = idOf(t.s.submit("lost"));
    t.feed({ snapshot: IDLE, type: "STATE_SNAPSHOT" });
    t.feed({ name: "info", type: "CUSTOM", value: "error: disk full" }, ack(lost, null, "disk full"));
    expect(t.s.unanswered).toBe(0);
    expect(t.s.failed).toBe(1);
    expect(t.out()).toContain("not logged: disk full\n");
    // a later turn logs it after all, acked again: still not shown as another client's
    t.feed(ack(lost, "7"), ...said("7", "user", "lost"));
    expect(t.out().match(/> lost/g)).toHaveLength(1); // its echo as it was sent
  });

  test("a cancel the socket could not send is said, not claimed", () => {
    const t = screen();
    t.s.cancel(true);
    t.s.cancel(false);
    expect(t.out()).toContain("cancel sent; a second Ctrl-C exits\n");
    expect(t.out()).toContain("not connected: the cancel was not sent\n");
  });

  test("a lost connection is told once, and so is its return", () => {
    const t = screen();
    t.s.disconnected(true);
    t.s.disconnected(true);
    t.s.disconnected(true);
    t.s.connected();
    t.s.connected();
    expect(t.out().match(/no connection to the server/g)).toHaveLength(1);
    expect(t.out().match(/connected to the server again/g)).toHaveLength(1);
  });
});

// SPEC "Server, WebSocket API and CLI": a client sends an abort only while connected, so a stale
// one never cancels the next turn; messages wait for the socket and go out in order
describe("repl link", () => {
  test("while closed a message waits and an abort is dropped; once open both go straight out", () => {
    const wire: string[] = [];
    const ws = { send: (f: string) => void wire.push(f) };
    const link = makeLink();
    link.send("first");
    expect(link.abort()).toBe(false);
    link.send("second");
    expect(wire).toEqual([]);
    link.opened(ws);
    expect(wire).toEqual(["first", "second"]); // no abort: the turn "first" starts is not cancelled
    expect(link.abort()).toBe(true);
    link.send("third");
    expect(wire).toEqual(["first", "second", ABORT, "third"]);
    link.closed();
    expect(link.abort()).toBe(false);
    link.send("fourth");
    expect(wire).toHaveLength(4);
    link.opened(ws);
    expect(wire.at(-1)).toBe("fourth");
    expect(wire.filter((f) => f === ABORT)).toHaveLength(1);
  });

  // a pick kept for later would settle whatever turn waits after the reconnect, maybe retrying
  // the engine that just hit its limit: the user never chose that
  test("a model pick goes out only while connected, and the screen says when it didn't", () => {
    const wire: string[] = [];
    const link = makeLink();
    const pick = JSON.stringify({ lead: "openai-plan:gpt-6.1-sol", type: "settings" });
    expect(link.now(pick)).toBe(false);
    link.opened({ send: (f: string) => void wire.push(f) });
    expect(wire).toEqual([]);
    expect(link.now(pick)).toBe(true);
    expect(wire).toEqual([pick]);
    const t = screen();
    t.s.picked(false);
    expect(t.out()).toContain("not connected: the model was not changed; /model again once connected\n");
  });
});
