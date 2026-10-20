import { EventType } from "@ag-ui/core";
import { type Kind, type UsageRecord } from "@wire";
import { Option } from "effect";
import { openStream } from "../../../server/agui.ts";
import type { SessionEvent } from "../../../src/session.ts";
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ack, actionsOf, type Entry, fakeServer, IDLE, idsOf, parseSent, received, said, snapshot, state } from "../test/fixture";
import { openLink, SILENT_MS, type SocketLike, STALE_MS, wakeOnReturn } from "./connection";
import { sentKey } from "./draft";
import { applyEvent, applyPage, emptyLog, hole, type Log, MAX_HELD, tip, trimHeld, visible, withDraft } from "./log";
import { type Inbound, parseFrame } from "./protocol";
import { applyThought, noThoughts, thoughtLabel, toggled } from "./reasoning";
import { chatRows, entryRows, rowIndexFor } from "./rows";
import { makeSession, queued, type Session, UNSENT } from "./session";
import { buckets, byModel, periodOf, totals } from "./stats";

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
  entryRows(withDraft(visible(log), log.draft)).map((r) => `${r.key} ${r.kind} ${r.kind === "tool" ? `${r.name} ${r.args} -> ${r.output}` : r.kind === "thinking" ? "" : r.text}`);
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
  test("reconnects after a drop and sends a message written while it was down, but not a cancel; a cancel made while open names its loop", async () => {
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
    expect(link.abort(2)).toBe(false); // made while down, it would cancel whatever turn runs after the reconnect
    expect(server.sent).toHaveLength(0);
    await tick();
    expect(server.sockets).toHaveLength(2);
    expect(statuses).toEqual(["open", "closed", "connecting", "open"]);
    expect(server.sent).toHaveLength(1);
    const frame = parseSent(server.sent[0] ?? "{}");
    expect(frame.messages?.at(-1)).toMatchObject({ content: "while down", id: "id-1", role: "user" });
    expect(frame.forwardedProps?.device).toBe("macbook");
    expect(link.abort(2)).toBe(true);
    expect(parseSent(server.sent[1] ?? "{}")).toMatchObject({ loop: 2, type: "abort" });
    link.close();
  });

  test("every action is kept until the server's receipt for its id, and goes out again, in the order made, on each socket that opens; once received, never again", async () => {
    const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
    server.mode.receipts = "drop"; // the socket dies before any answer comes back
    const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
    await tick();
    link.send("first", "m1");
    expect(link.abort(4)).toBe(true);
    link.configure({ followUp: "queue" });
    expect(link.takeBack("q1")).toBe(true);
    link.send("second", "m2");
    link.send("first", "m1"); // kept already: not twice
    expect(link.subagent({ name: "scout", text: "go on", type: "tell" })).toBe(true);
    const made = [...server.sent];
    expect(made).toHaveLength(6);
    const ids = made.map((f) => idsOf(f)[0]);
    expect(new Set(ids).size).toBe(6); // each action its own id
    server.drop();
    await tick(20);
    expect(server.sent.slice(made.length)).toEqual(made); // the same frames, ids and all, in order
    // the server answers some of them (a repeat or not, it is received): those go no more
    server.play(...[ids[0], ids[2], ids[3]].map((id) => received(id ?? "")));
    server.drop();
    await tick(20);
    expect(server.sent.slice(2 * made.length)).toEqual([1, 4, 5].map((k) => made[k] ?? ""));
    server.mode.receipts = "answer";
    server.drop();
    await tick(20);
    const answered = server.sent.length;
    server.drop();
    await tick(20);
    expect(server.sent).toHaveLength(answered); // all received: nothing goes out again
    link.close();
  });

  test("heartbeat: a socket the server says nothing on for silentMs is dead: closed, and opened again at once; any frame keeps it", async () => {
    expect(SILENT_MS).toBe(10_000); // two of the server's 5 s heartbeats missed (HEARTBEAT)
    const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { retryMs: 60_000, silentMs: 60, socket: server.socket });
    const statuses: string[] = [];
    link.onStatus((s) => {
      statuses.push(s);
    });
    await tick();
    // the server's heartbeat (an empty STATE_DELTA when nothing changed) keeps it open
    for (let k = 0; k < 8; k++) {
      await tick(20);
      server.play({ delta: [], type: EventType.STATE_DELTA });
    }
    expect(server.sockets).toHaveLength(1);
    expect(link.status()).toBe("open");
    // then nothing: a half-open socket gets no close event, so the link lets it go by itself, and
    // opens another at once, not after the minute's backoff
    await tick(100);
    expect(server.sockets.length).toBeGreaterThanOrEqual(2);
    expect(server.sockets[0]?.readyState).toBe(3);
    expect(statuses.slice(0, 4)).toEqual(["open", "closed", "connecting", "open"]);
    link.close();
    const after = server.sockets.length;
    await tick(150);
    expect(server.sockets).toHaveLength(after); // closed for good: no watchdog left behind
  });

  test("heartbeat: a socket that never opens is let go after silentMs too, and tried again on the backoff", async () => {
    const opened: string[] = [];
    // a handshake that hangs: no open, no close, no frame
    const link = openLink("ws://x/ws", {
      retryMs: 30,
      silentMs: 40,
      socket: (url) => {
        opened.push(url);
        const hung: SocketLike = {
          addEventListener: () => {
            // never opens, never closes, never says anything
          },
          close: () => {
            // nothing to close
          },
          send: () => {
            // nobody listens
          },
        };
        return hung;
      },
    });
    await tick(60);
    expect(opened).toHaveLength(1);
    expect(link.status()).toBe("closed");
    await tick(60);
    expect(opened.length).toBeGreaterThanOrEqual(2);
    link.close();
  });

  test("heartbeat: a first frame slower than the window, on a slow link, is waited for on the next socket, not lost in a reconnect loop", async () => {
    let opened = 0, delivered = 0;
    const slow = () => {
      opened++;
      const opens: (() => void)[] = [];
      const messages: ((e: { readonly data: string }) => void)[] = [];
      let gone = false;
      const ws: SocketLike = {
        addEventListener: (type: "open" | "close" | "message", l: never) => {
          if (type === "open") opens.push(l);
          if (type === "message") messages.push(l);
        },
        close: () => {
          gone = true;
        },
        send: () => {
          // nobody listens
        },
      };
      setTimeout(() => {
        if (!gone) for (const l of opens) l();
      }, 1);
      // the opening snapshot takes 90 ms to arrive, one and a half windows; then a beat every 20 ms
      const say = (data: string) => {
        for (const l of messages) l({ data });
      };
      setTimeout(() => {
        if (gone) return;
        delivered++;
        say(JSON.stringify({ messages: [], type: EventType.MESSAGES_SNAPSHOT }));
        const beats = setInterval(() => {
          if (gone) clearInterval(beats);
          else say(JSON.stringify({ delta: [], type: EventType.STATE_DELTA }));
        }, 20);
      }, 90);
      return ws;
    };
    const link = openLink("ws://x/ws", { retryMs: 50, silentMs: 60, socket: slow });
    await tick(800);
    // the first socket is let go at 60 ms having said nothing: the backoff, then a socket with a
    // window twice as long, which gets the snapshot and stays
    expect(opened).toBe(2);
    expect(delivered).toBe(1);
    expect(link.status()).toBe("open");
    link.close();
  });

  test("heartbeat: back from the background, a kept socket's overdue silence timer starts again rather than dropping it", async () => {
    const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { retryMs: 60_000, silentMs: 80, socket: server.socket });
    await tick(50);
    link.wake(STALE_MS - 1); // away a little while: the socket is kept
    await tick(60); // 110 ms since the last frame, 60 since the wake
    expect(server.sockets).toHaveLength(1);
    expect(link.status()).toBe("open");
    link.close();
  });

  test("heartbeat: back from the background, a socket still connecting keeps its silence timer: a hung handshake is let go on time", async () => {
    const opened: string[] = [];
    const link = openLink("ws://x/ws", {
      retryMs: 60_000,
      silentMs: 200,
      socket: (url) => {
        opened.push(url);
        const hung: SocketLike = {
          addEventListener: () => {
            // never opens, never closes, never says anything
          },
          close: () => {
            // nothing to close
          },
          send: () => {
            // nobody listens
          },
        };
        return hung;
      },
    });
    await tick(100);
    link.wake(0); // a short absence, mid-handshake
    expect(link.status()).toBe("connecting");
    await tick(150); // 250 ms since it started, 150 since the wake: past its window, not past a new one
    expect(link.status()).toBe("closed");
    expect(opened).toHaveLength(1);
    link.close();
  });

  test("heartbeat: the server's beat is the state now, as a STATE_DELTA, which any client decodes; it moves only what drifted", () => {
    const told = { ...IDLE, elapsed: 1000, phase: "running" as const };
    const stream = openStream({ entries: [], live: null, state: told, thread: "mini", window: 10 });
    // nothing changed: an empty delta, which every client decodes and applies as a no-op
    const quiet = stream.beat(told);
    expect(quiet).toEqual([{ delta: [], type: EventType.STATE_DELTA }]);
    expect(Option.isSome(parseFrame(JSON.stringify(quiet[0])))).toBe(true);
    // while a turn runs, the phase's elapsed time moves on: the beat carries it, so a client that
    // counts from when it got the state counts right
    const later = stream.beat({ ...told, elapsed: 6000 });
    expect(later).toEqual([{ delta: [{ op: "replace", path: "/elapsed", value: 6000 }], type: EventType.STATE_DELTA }]);
    expect(Option.isSome(parseFrame(JSON.stringify(later[0])))).toBe(true);
  });

  test("wake: a link that is down connects again at once, not after its backoff; closed for good, it stays closed", async () => {
    const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { retryMs: 60_000, socket: server.socket });
    await tick();
    server.drop();
    await tick();
    expect(link.status()).toBe("closed"); // the next try is a minute away
    link.wake(0);
    await tick();
    expect(server.sockets).toHaveLength(2);
    expect(link.status()).toBe("open");
    link.close();
    link.wake(Number.POSITIVE_INFINITY);
    expect(server.sockets).toHaveLength(2);
  });

  test("wake: an open link away STALE_MS or more is opened afresh (iOS may have killed it silently); a short absence, or one still connecting, is left alone", async () => {
    const server = fakeServer(() => [snapshot([{ kind: "user", text: "old" }]), { snapshot: { ...IDLE, messages: 1 }, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { socket: server.socket });
    link.wake(Number.POSITIVE_INFINITY); // still connecting: no second socket
    expect(server.sockets).toHaveLength(1);
    const statuses: string[] = [];
    link.onStatus((s) => {
      statuses.push(s);
    });
    const snapshots: Inbound[] = [];
    link.listen((e) => {
      if (e.type === EventType.MESSAGES_SNAPSHOT) snapshots.push(e);
    });
    await tick();
    link.wake(STALE_MS - 1);
    expect(server.sockets).toHaveLength(1);
    link.wake(STALE_MS);
    await tick();
    expect(server.sockets).toHaveLength(2);
    expect(server.sockets[0]?.readyState).toBe(3); // the suspect socket is closed, not left open
    expect(statuses).toEqual(["open", "connecting", "open"]); // its close is not this link's
    expect(snapshots).toHaveLength(2); // the new connection's greeting resyncs the log
    link.send("after the wake", "id-w");
    expect(parseSent(server.sent.at(-1) ?? "{}").messages?.at(-1)).toMatchObject({ content: "after the wake" });
    link.close();
  });

  test("wakeOnReturn: wakes with how long the page was hidden, and as if away for ever when the network comes back", () => {
    const woken: number[] = [];
    let state: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
    let clock = 1000;
    const stop = wakeOnReturn(
      {
        wake: (ms) => {
          woken.push(ms);
        },
      },
      document,
      () => clock,
    );
    try {
      state = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
      clock += 45_000;
      state = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      globalThis.dispatchEvent(new Event("online"));
      expect(woken).toEqual([45_000, Number.POSITIVE_INFINITY]);
      stop();
      document.dispatchEvent(new Event("visibilitychange"));
      expect(woken).toHaveLength(2);
    } finally {
      stop();
      Reflect.deleteProperty(document, "visibilityState"); // the prototype's getter again
    }
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
const waiting = (session: { readonly get: () => Session }) => queued(session.get()).map((q) => (q.error === null ? q.text : `${q.text} (${q.error})`));
const idOf = (server: { readonly sent: readonly string[] }, k: number) => parseSent(server.sent[k] ?? "{}").messages?.at(-1)?.id ?? "";
// the ids of the messages the app sent, in order, each time it went out
const messageIds = (server: { readonly sent: readonly string[] }) => server.sent.flatMap((f) => parseSent(f).messages?.map((m) => m.id) ?? []);
const actions = (server: { readonly sent: readonly string[] }) => actionsOf(server.sent);

describe("session", () => {
  // a resume made while down would settle whatever turn waits after the reconnect, maybe retrying
  // the engine that just hit its limit: the user never chose that
  test("a resume is made only while connected and says when it wasn't, and names the run of the turn loop it saw; the follow-up setting and a message wait for the connection", async () => {
    const server = fakeServer(() => [snapshot([]), { snapshot: { ...IDLE, loop: 3, phase: "needs-model" }, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { socket: server.socket }); // it opens once this test yields
    const session = makeSession(link);
    expect(session.resume("openai-plan:gpt-6.1-sol")).toBe(false);
    expect(session.get().markers.map((m) => m.text)).toEqual(["not connected: the resume was not sent"]);
    link.configure({ followUp: "queue" });
    session.send("for sol", { engine: "openai-plan:gpt-6.1-sol" });
    await tick();
    // no resume replayed; the message names its engine
    expect(actions(server)).toMatchObject([{ followUp: "queue", type: "settings" }, { forwardedProps: { engine: "openai-plan:gpt-6.1-sol" } }]);
    expect(session.resume("openai-plan:gpt-6.1-sol")).toBe(true);
    expect(actions(server).at(-1)).toEqual({ engine: "openai-plan:gpt-6.1-sol", loop: 3, type: "resume" });
  });

  test("messages kept from before a reload go out again under their ids once the state says the server doesn't hold them; one a page from before E41 kept is marked instead", async () => {
    const sent = [
      { engine: "openai-plan:gpt-6.1-sol", id: "a", media: [], text: "logged while away" },
      { id: "b", media: [], text: "held there" },
      { from: 20, id: "c", media: [], text: "from an older page" },
    ];
    localStorage.setItem(sentKey, JSON.stringify({ at: Date.now(), sent }));
    const server = fakeServer(() => [snapshot([]), { snapshot: { ...IDLE, pending: [{ clientId: "b", engine: "claude-code:opus", queued: true, text: "held there" }] }, type: EventType.STATE_SNAPSHOT }]);
    server.mode.receipts = "drop";
    const session = makeSession(openLink("ws://x/ws", { retryMs: 1, socket: server.socket }));
    await tick();
    expect(messageIds(server)).toEqual(["a"]);
    expect(actions(server)[0]).toMatchObject({ forwardedProps: { engine: "openai-plan:gpt-6.1-sol" } });
    expect(waiting(session)).toEqual(["held there", "logged while away", `from an older page (${UNSENT})`]);
    // the server logged it while the page was away: its receipt says where, and settles it
    server.play(received("a", "logged", 7));
    expect(waiting(session)).toEqual(["held there", `from an older page (${UNSENT})`]);
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

  test("a message the log refused shows as not logged with the error, until its ack says the log holds it; an entry with its text is not that", async () => {
    const { server, session } = await setup();
    session.send("lost?");
    server.play(ack(idOf(server, 0), null, "disk full"));
    expect(waiting(session)).toEqual(["lost? (disk full)"]);
    // another client's message with the same text, then ours, logged with the next message's run
    server.play(ack("someone else's", 1), ...said(1, "user", "lost?"));
    expect(waiting(session)).toEqual(["lost? (disk full)"]);
    server.play(ack(idOf(server, 0), 2), ...said(2, "user", "lost?"));
    expect(waiting(session)).toEqual([]);
  });

  test("an ack lost to a dropped connection: after the reconnect the message goes out again under its id, and the server's receipt settles it; one the server holds is not sent again", async () => {
    let heldThere: readonly { readonly clientId: string | null; readonly engine: string; readonly queued: boolean; readonly text: string }[] = [];
    const server = fakeServer(() => [snapshot([{ kind: "user", text: "old" }]), { snapshot: { ...IDLE, messages: 1, pending: heldThere }, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
    const session = makeSession(link);
    await tick();
    session.send("same");
    session.send("same");
    session.send("logged while away");
    await tick();
    const [first = "", second = "", third = ""] = messageIds(server);
    // the server holds the second; the third it logged, and its ack went to the socket that dropped
    heldThere = [{ clientId: second, engine: "claude-code:opus", queued: false, text: "same" }];
    server.drop();
    await tick(20);
    expect(messageIds(server).slice(3)).toEqual([first, third]); // in the order they were sent
    expect(waiting(session)).toEqual(["same", "same", "logged while away"]);
    server.play(received(third, "logged", 1));
    expect(waiting(session)).toEqual(["same", "same"]);
    expect(session.get().pending.every((p) => p.error === null)).toBe(true); // nothing for the user to send again
  });

  test("a message another client took back while this page was away is dropped once the server says so", async () => {
    const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
    server.mode.receipts = "drop";
    const session = makeSession(openLink("ws://x/ws", { retryMs: 1, socket: server.socket }));
    await tick();
    session.send("for later");
    server.drop();
    await tick(20);
    const id = idOf(server, 0);
    expect(messageIds(server)).toEqual([id, id]);
    server.play(received(id, "taken-back"));
    expect(waiting(session)).toEqual([]);
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

  test("per model and effort: one model at two efforts is two rows, a record without an effort a third", () => {
    const usage = { cacheRead: 50, cacheWrite: 0, input: 50, output: 10 };
    const opus = [
      rec("2026-10-05T10:00:00", { effort: "xhigh", model: "claude-opus-5-5", usage }),
      rec("2026-10-05T11:00:00", { effort: "xhigh", model: "claude-opus-5-5", usage }),
      rec("2026-10-05T12:00:00", { effort: "high", model: "claude-opus-5-5", usage }),
      rec("2026-10-05T13:00:00", { model: "claude-opus-5-5", usage }),
    ];
    expect(byModel(opus).map((m) => [m.name, m.calls, m.tokens, m.hitRate])).toEqual([
      ["claude-code:claude-opus-5-5@xhigh", 2, 220, 0.5],
      ["claude-code:claude-opus-5-5", 1, 110, 0.5],
      ["claude-code:claude-opus-5-5@high", 1, 110, 0.5],
    ]);
  });
});

// Session.run, which says which plan is live: the run RUN_STARTED names, until it ends or the link drops
describe("the running turn's start (Session.run)", () => {
  test("RUN_STARTED sets it (a resumed run keeps its start); RUN_FINISHED, RUN_ERROR and a drop clear it; after a reconnect only RUN_STARTED sets it again", async () => {
    const server = fakeServer(() => [snapshot([{ kind: "user", text: "old" }]), { snapshot: { ...IDLE, messages: 1 }, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
    const session = makeSession(link);
    await tick();
    const at = () => session.get().run;
    expect(at()).toBeNull();
    server.play({ runId: "3", threadId: "mini", type: EventType.RUN_STARTED });
    expect(at()).toBe(3);
    // resumed after a stop for a model: the same turn, from the same entry
    server.play({ runId: "3+1", threadId: "mini", type: EventType.RUN_STARTED });
    expect(at()).toBe(3);
    server.play({ runId: "3+1", threadId: "mini", type: EventType.RUN_FINISHED });
    expect(at()).toBeNull();
    server.play({ runId: "5", threadId: "mini", type: EventType.RUN_STARTED });
    expect(at()).toBe(5);
    server.play({ message: "boom", type: EventType.RUN_ERROR });
    expect(at()).toBeNull();
    server.play({ runId: "7", threadId: "mini", type: EventType.RUN_STARTED });
    expect(at()).toBe(7);
    // the link drops mid-run: nothing is known to run until the server says so again
    server.drop();
    expect(at()).toBeNull();
    await tick();
    expect(session.get().status).toBe("open");
    expect(at()).toBeNull();
    // the server tells a page that joins mid-run the run it is in
    server.play({ runId: "7", threadId: "mini", type: EventType.RUN_STARTED });
    expect(at()).toBe(7);
    link.close();
  });
});

// the server's translator (server/agui.ts) and the client's decoder, end to end: session events
// in, what this page holds out
const relay = () => {
  const { translate } = openStream({ entries: [], live: null, state: IDLE, thread: "mini", window: 50 });
  return (...es: SessionEvent[]): Inbound[] => es.flatMap((e) => translate(e)).flatMap((e) => Option.toArray(parseFrame(JSON.stringify(e))));
};
const think = (at: number, offset: number, delta: string): SessionEvent => ({ at, delta, offset, runId: "0", type: "reasoning" });
const kept = (at: number, i: number, ms: number, cut = 0): SessionEvent => ({ at, cut, i, ms, runId: "0", type: "reasoning-kept" });
const thoughtsOf = (session: { readonly get: () => Session }) =>
  [...session.get().thoughts.values()].map((t) => [t.i, t.text, t.live, t.ms, t.cut]);

describe("reasoning: what the model thought, beside the log", () => {
  test("live: a thought streams under the index its entry is expected at, a row of its own until that entry comes; kept, it says how long it took", async () => {
    const { server, session } = await setup();
    const wire = relay();
    server.play({ runId: "1", threadId: "mini", type: EventType.RUN_STARTED }, ...wire(think(1, 0, "Let me "), think(1, 7, "think.")));
    expect(thoughtsOf(session)).toEqual([[1, "Let me think.", true, null, 0]]);
    const { items, draft } = session.get().log;
    const shownItems = visible({ base: 0, items });
    // past every row: a thinking row keyed as its entry's row will be
    expect(chatRows(shownItems, entryRows(shownItems), draft, 1).at(-1)).toEqual({ id: 1, key: "e1", kind: "thinking" });
    expect(thoughtLabel(session.get().thoughts.get(1)!)).toBe("Thinking");
    server.play(...said(1, "assistant", "Hello."), ...wire(kept(1, 1, 12_400)));
    expect(thoughtsOf(session)).toEqual([[1, "Let me think.", false, 12_400, 0]]);
    expect(thoughtLabel(session.get().thoughts.get(1)!)).toBe("Thought for 12 s");
  });

  test("live: one kept before another entry than expected moves there; one dropped, or left open at the run's end or a dropped link, goes", async () => {
    const { server, session } = await setup();
    const wire = relay();
    server.play(...wire(think(2, 0, "moves")));
    session.toggleThought(2, true); // opened while it streams: it stays open where it is kept
    server.play(...wire(kept(2, 3, 500, 40)));
    expect(thoughtsOf(session)).toEqual([[3, "moves", false, 500, 40]]);
    expect(session.get().thoughts.get(3)?.open).toBe(true);
    expect(thoughtLabel(session.get().thoughts.get(3)!)).toBe("Reasoning"); // under a second
    server.play(...wire(think(4, 0, "never said"), { at: 4, runId: "0", type: "reasoning-dropped" }));
    expect(session.get().thoughts.has(4)).toBe(false);
    server.play(...wire(think(5, 0, "cut off")), { runId: "1", threadId: "mini", type: EventType.RUN_FINISHED });
    expect(session.get().thoughts.has(5)).toBe(false);
    server.play(...wire(think(6, 0, "the link drops")));
    server.drop();
    await tick();
    expect([...session.get().thoughts.keys()]).toEqual([3]);
  });

  test("after a reload: the rows held get their thoughts without text, read when one is opened; an older page asks for its own; a server without the route shows none", async () => {
    const asked: string[] = [];
    let flaky = 0;
    const server = fakeServer(() => [snapshot(all(150).slice(-50), 100), { snapshot: { ...IDLE, messages: 150 }, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { socket: server.socket });
    const session = makeSession(link, {
      messages: async (before, limit) => ({ entries: all(150).slice(Math.max(0, before - limit), before).map((e, k) => entry(Math.max(0, before - limit) + k, e.kind, e.text)) }),
      reasoning: async (from, to) => {
        asked.push(`${from}-${to}`);
        return [{ chars: 9, engine: "claude-code:opus", i: 120, ms: 3000 }, { chars: 9, engine: "claude-code:opus", i: 130, ms: 2000 }, { chars: 9, engine: "claude-code:opus", i: 60, ms: 1000, cut: 7 }].filter((h) => h.i >= from && h.i < to);
      },
      reasoningText: async (i) => {
        if (i === 130 && flaky++ === 0) throw new Error("offline");
        return i === 60 ? null : { date: "2026-10-15T10:00:00Z", engine: "claude-code:opus", i, ms: 3000, text: `kept text ${i}` };
      },
    });
    await tick();
    expect(asked).toEqual(["100-150"]);
    expect(thoughtsOf(session)).toEqual([
      [120, null, false, 3000, 0],
      [130, null, false, 2000, 0],
    ]);
    session.toggleThought(120, true);
    expect(session.get().thoughts.get(120)?.open).toBe(true);
    await tick();
    expect(session.get().thoughts.get(120)?.text).toBe("kept text 120");
    // a read that failed says so, and opening the line again tries again
    session.toggleThought(130, true);
    await tick();
    expect(session.get().thoughts.get(130)?.failed).toBe("error");
    session.toggleThought(130, false);
    session.toggleThought(130, true);
    await tick();
    expect(session.get().thoughts.get(130)).toMatchObject({ failed: null, open: true, text: "kept text 130" });
    await session.loadOlder();
    await tick();
    expect(asked).toEqual(["100-150", "0-100"]);
    expect(session.get().thoughts.get(60)).toMatchObject({ cut: 7, text: null });
    session.toggleThought(60, true); // the server has none: said for good, not asked again
    await tick();
    expect(session.get().thoughts.get(60)?.failed).toBe("missing");
    session.toggleThought(60, false);
    expect(toggled(session.get().thoughts, 60, true).read).toBe(false);

    const old = makeSession(openLink("ws://x/ws", { socket: fakeServer(() => [snapshot([{ kind: "talk", text: "hi" }])]).socket }), {
      reasoning: async () => {
        throw new Error("/api/reasoning: 404 Not Found");
      },
    });
    await tick();
    expect(old.get().thoughts).toEqual(noThoughts);
    expect(old.get().log.items.size).toBe(1);
  });

  test("the pure store: content without its start starts a piece; an end that names no entry drops it", () => {
    const content: Inbound = { delta: "joined late", messageId: "r7", type: EventType.REASONING_MESSAGE_CONTENT };
    const started = applyThought(noThoughts, content, 0);
    expect(started.get(7)).toMatchObject({ live: true, text: "joined late" });
    expect(applyThought(started, { messageId: "r7", type: EventType.REASONING_END }, 0).has(7)).toBe(false);
    // an id that isn't a reasoning message's, or another event, changes nothing
    expect(applyThought(started, { delta: "x", messageId: "7", type: EventType.REASONING_MESSAGE_CONTENT }, 0)).toBe(started);
  });
});
