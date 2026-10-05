// The REPL's screen: what reaches the terminal when the server's events and the user's keys interleave.
import { describe, expect, test } from "bun:test";
import { Option } from "effect";
import { type Inbound, makeScreen, parseInbound } from "../cli/repl.ts";

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
const said = (id: string, role: string, text: string): Inbound[] => [
  { messageId: id, role, type: "TEXT_MESSAGE_START" },
  { delta: text, messageId: id, type: "TEXT_MESSAGE_CONTENT" },
  { messageId: id, type: "TEXT_MESSAGE_END" },
];

describe("repl screen", () => {
  test("a message typed here is not shown twice; one from another client is", () => {
    const t = screen();
    t.feed({ snapshot: IDLE, type: "STATE_SNAPSHOT" });
    for (const ch of "hello") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toEqual({ text: "hello", type: "send" });
    const before = t.out();
    t.feed(...said("3", "user", "hello"), ...said("4", "user", "from the phone"), ...said("5", "assistant", "hi"));
    const after = t.out().slice(before.length);
    expect(after).not.toContain("hello");
    expect(after).toContain("> from the phone\n");
    expect(after).toContain("hi\n");
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
    expect(t.s.submit("  first ")).toEqual({ text: "first", type: "send" });
    expect(t.s.submit("")).toBeNull();
    expect(t.out()).toContain("> first\n");
    expect(t.out()).not.toContain("> \n");
    expect(t.s.busy).toBe(true);
  });

  test("piped: a message is answered when the run that logged it ends, not when the server says idle", () => {
    const t = screen(false);
    t.s.submit("slow one");
    t.feed({ snapshot: IDLE, type: "STATE_SNAPSHOT" }); // the server has not read it yet
    expect(t.s.unanswered).toBe(1);
    t.feed(...said("3", "user", "slow one"), { type: "RUN_STARTED" });
    expect(t.s.unanswered).toBe(1);
    t.feed(...said("4", "assistant", "done"), { type: "RUN_FINISHED" });
    expect(t.s.unanswered).toBe(0);

    // cancelled from another client: logged unanswered, no run end, then the session goes idle
    t.s.submit("never answered");
    t.feed({ delta: [{ op: "replace", path: "/phase", value: "priming" }], type: "STATE_DELTA" });
    t.feed(...said("5", "user", "never answered"));
    expect(t.s.unanswered).toBe(1);
    t.feed({ delta: [{ op: "replace", path: "/phase", value: "idle" }], type: "STATE_DELTA" });
    expect(t.s.unanswered).toBe(0);
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
