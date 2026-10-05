// The REPL's screen: what reaches the terminal when the server's events and the user's keys interleave.
import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";
import { ABORT, type Action, type Inbound, makeLink, makeScreen, parseInbound, runRepl, type TermIn } from "../cli/repl.ts";
import { freePort } from "./ports.ts";

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

  test("/model is the REPL's own: it sends nothing, and the messages sent after it name its engine", () => {
    const t = screen();
    const engines = [
      { down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
      { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
    ];
    t.feed({ snapshot: { ...IDLE, engines, stopped: null }, type: "STATE_SNAPSHOT" });
    for (const ch of "first") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).not.toHaveProperty("engine"); // none named: the server's first
    for (const ch of "/model") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toBeNull();
    expect(t.out()).toContain("  1. Claude Opus (Claude Code) (in use)\n");
    for (const ch of "/model 2") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toBeNull();
    expect(t.out()).toContain("model: GPT-6.1 Sol (ChatGPT plan), for your next messages\n");
    for (const ch of "/model 9") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toBeNull();
    expect(t.out()).toContain("no model 9: /model lists them\n");
    for (const ch of "second") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toMatchObject({ engine: "openai-plan:gpt-6.1-sol", text: "second", type: "send" });
  });

  test("a turn waiting for a model: the REPL lists the engines, and /resume retries the stopped one or goes on with another", () => {
    const t = screen();
    const engines = [
      { down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
      { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
    ];
    t.feed({ snapshot: { ...IDLE, engines, phase: "running", stopped: null }, type: "STATE_SNAPSHOT" });
    for (const ch of "/resume") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toBeNull();
    expect(t.out()).toContain("no turn waits for a model\n");
    const down = [
      { down: "Claude AI usage limit reached", label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
      { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
    ];
    const stopped = { label: "Claude Opus (Claude Code)", ref: "claude-code:opus", why: "usage limit: Claude AI usage limit reached" };
    t.feed({ delta: [{ op: "replace", path: "/engines", value: down }, { op: "replace", path: "/phase", value: "needs-model" }, { op: "replace", path: "/stopped", value: stopped }], type: "STATE_DELTA" });
    t.feed({ message: "usage limit: Claude AI usage limit reached", type: "RUN_ERROR" });
    expect(t.out()).toContain("Claude Opus (Claude Code) stopped: usage limit: Claude AI usage limit reached. /resume tries it again, /resume <n> goes on with another");
    expect(t.out()).not.toContain("error: usage limit"); // said once
    expect(t.out()).toContain("  1. Claude Opus (Claude Code) (in use) (unavailable: Claude AI usage limit reached)\n");
    expect(t.out()).toContain("  2. GPT-6.1 Sol (ChatGPT plan)\n");
    expect(t.s.stuck).toBe(true);
    for (const ch of "/resume 2") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toEqual({ engine: "openai-plan:gpt-6.1-sol", type: "resume" });
    for (const ch of "/resume") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toEqual({ engine: "claude-code:opus", type: "resume" });
    for (const ch of "/resume 9") t.s.key({ text: ch, type: "text" });
    expect(t.s.key({ type: "enter" })).toBeNull();
    expect(t.out()).toContain("no model 9: /model lists them\n");
    t.feed({ delta: [{ op: "replace", path: "/phase", value: "running" }], type: "STATE_DELTA" });
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

  // a resume kept for later would settle whatever turn waits after the reconnect, maybe retrying
  // the engine that just hit its limit: the user never chose that
  test("a resume goes out only while connected, and the screen says when it didn't", () => {
    const wire: string[] = [];
    const link = makeLink();
    const resume = JSON.stringify({ engine: "openai-plan:gpt-6.1-sol", type: "resume" });
    expect(link.now(resume)).toBe(false);
    link.opened({ send: (f: string) => void wire.push(f) });
    expect(wire).toEqual([]);
    expect(link.now(resume)).toBe(true);
    expect(wire).toEqual([resume]);
    const t = screen();
    t.s.resumed(false);
    expect(t.out()).toContain("not connected: the resume was not sent; /resume again once connected\n");
  });
});

// The REPL wired to a terminal and a socket (runRepl): a fake terminal types, a /ws server records
// what reaches it. /model changes what the REPL's next messages name and sends nothing; a /resume
// typed while the socket is down is said, and never sent once it is back (a message is).
describe("runRepl", () => {
  test("/model sends nothing; messages name its engine; a resume while disconnected is not queued", async () => {
    const engines = [
      { down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
      { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
    ];
    const stopped = { label: "Claude Opus (Claude Code)", ref: "claude-code:opus", why: "usage limit: spent" };
    const greeting = JSON.stringify({ snapshot: { ...IDLE, engines, phase: "needs-model", stopped }, type: "STATE_SNAPSHOT" });
    const conns: string[][] = []; // the frames each connection got
    const open: { close: () => void }[] = [];
    const port = freePort();
    const server = Bun.serve({
      fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("no", { status: 404 })),
      hostname: "127.0.0.1",
      port,
      websocket: {
        message: (_ws, m) => {
          conns.at(-1)?.push(String(m));
        },
        open: (ws) => {
          conns.push([]);
          open.push(ws);
          ws.send(greeting);
        },
      },
    });
    // a terminal: raw mode is a no-op, keys are typed as data
    const typed = new Set<(chunk: Uint8Array) => void>();
    const modes: string[] = []; // raw mode and reading, as the REPL set them
    const stdin: TermIn = {
      isTTY: true,
      off: (_event: "data", f: (chunk: Uint8Array) => void) => {
        typed.delete(f);
      },
      on: (event: "data" | "end", f: (chunk: Uint8Array) => void) => {
        if (event === "data") typed.add(f);
      },
      pause: () => {
        modes.push("paused");
      },
      resume: () => {
        modes.push("reading");
      },
      setRawMode: (raw) => {
        modes.push(raw ? "raw" : "cooked");
      },
    };
    let out = "";
    const stdout = {
      columns: 80,
      isTTY: false,
      write: (x: string) => {
        out += x;
      },
    };
    const type = (text: string) => {
      for (const f of typed) f(new TextEncoder().encode(text));
    };
    const until = async (what: string, ok: () => boolean) => {
      const end = Date.now() + 8000;
      while (!ok()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${out}`);
        await Bun.sleep(10);
      }
    };
    const repl = Effect.runPromise(runRepl({ stdin, stdout, url: `http://127.0.0.1:${port}` }));
    try {
      await until("the stop", () => out.includes("Claude Opus (Claude Code) stopped: usage limit: spent."));
      type("/model 2\r");
      await until("the choice", () => out.includes("model: GPT-6.1 Sol (ChatGPT plan), for your next messages"));
      type("hello\r");
      await until("the message", () => conns[0]?.length === 1);
      const [hello] = conns[0] ?? [];
      expect(JSON.parse(hello ?? "{}")).toMatchObject({ forwardedProps: { engine: "openai-plan:gpt-6.1-sol" }, messages: [{ content: "hello" }] });
      type("/resume\r");
      await until("the resume", () => conns[0]?.length === 2);
      expect(conns[0]?.[1]).toBe(JSON.stringify({ engine: "claude-code:opus", type: "resume" }));
      // the server goes away: a resume is said and dropped, a message waits for the socket
      open[0]?.close();
      await until("the outage", () => out.includes("no connection to the server"));
      type("/resume 2\r");
      await until("the refusal", () => out.includes("not connected: the resume was not sent; /resume again once connected"));
      type("while down\r");
      await until("the reconnect and the message", () => conns[1]?.length === 1);
      await Bun.sleep(100);
      expect(conns[1]).toHaveLength(1); // the message, and no resume
      expect(conns[1]?.[0]).toContain('"content":"while down"');
      expect(conns.flat().filter((f) => f.includes('"resume"'))).toHaveLength(1);
      type("\u0004");
      await repl;
      expect(modes).toEqual(["raw", "reading", "paused", "cooked"]);
    } finally {
      await server.stop(true);
    }
  }, 15_000);
});
