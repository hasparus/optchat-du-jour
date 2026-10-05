// The client's own logic: the link, the session store, rows and stats. No DOM needed.
import { EventType } from "@ag-ui/core";
import { describe, expect, test } from "bun:test";
import { fakeServer, IDLE, parseSent, said, snapshot, state } from "../test/fixture";
import { openLink } from "./connection";
import type { Inbound, UsageRecord } from "./protocol";
import { entryRows, mergeRows, rowFor } from "./rows";
import { makeSession, queued } from "./session";
import { buckets, periodOf, totals } from "./stats";

const tick = async () =>
  new Promise((resolve) => {
    setTimeout(resolve, 5);
  });

// a session over a server whose log holds one message
const setup = async () => {
  const server = fakeServer(() => [snapshot([{ kind: "user", text: "old" }]), { snapshot: { ...IDLE, messages: 1 }, type: EventType.STATE_SNAPSHOT }]);
  const link = openLink("ws://x/ws", { socket: server.socket });
  const session = makeSession(link);
  await tick();
  return { link, server, session };
};

const entry = (i: number, kind: "user" | "talk" | "tool" | "echo", text: string) => ({ date: "2026-10-05T10:00:00Z", i, kind, text });

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
  test("reconnects after a drop, and sends what was sent while it was down", async () => {
    const server = fakeServer(() => [snapshot([]), { snapshot: IDLE, type: EventType.STATE_SNAPSHOT }]);
    const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
    const statuses: string[] = [];
    link.onStatus((s) => {
      statuses.push(s);
    });
    await tick();
    expect(link.status()).toBe("open");
    server.drop();
    link.send("while down", "macbook");
    expect(server.sent).toHaveLength(0);
    await tick();
    expect(server.sockets).toHaveLength(2);
    expect(statuses).toEqual(["open", "closed", "connecting", "open"]);
    const frame = parseSent(server.sent[0] ?? "{}");
    expect(frame.messages?.at(-1)).toMatchObject({ content: "while down", role: "user" });
    expect(frame.forwardedProps?.device).toBe("macbook");
    link.abort();
    expect(server.sent[1]).toBe('{"type":"abort"}');
    link.close();
  });

  test("a frame that isn't one of ours is dropped, not passed on", async () => {
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
    link.close();
  });
});

describe("session", () => {

  test("a message sent here waits in the queue until the log has it, also mid-run", async () => {
    const { server, session } = await setup();
    session.send("old", null); // the same text as an entry already logged: still pending
    expect(queued(session.get())).toEqual(["old"]);
    server.play(state({ phase: "running", queued: ["old"] }));
    expect(queued(session.get())).toEqual(["old"]); // the server's copy and ours are one message
    server.play(...said(1, "user", "old"), state({ queued: [] }));
    expect(queued(session.get())).toEqual([]);
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
});

describe("rows", () => {

  test("a tool entry and its echo are one row; an echo with no tool before it stands alone", () => {
    const rows = entryRows([entry(4, "echo", "orphan"), entry(5, "tool", 'Bash {"command":"ls"}'), entry(6, "echo", "a b"), entry(7, "talk", "done")]);
    expect(rows.map((r) => (r.kind === "tool" ? [r.id, r.name, r.args, r.output] : [r.id, r.kind]))).toEqual([
      [4, "output", "", "orphan"],
      [5, "Bash", '{"command":"ls"}', "a b"],
      [7, "talk"],
    ]);
    // an older page under the live window, and the row for a log index inside a tool row
    const merged = mergeRows(rows, entryRows([entry(7, "talk", "done"), entry(8, "user", "next")]));
    expect(merged.map((r) => r.id)).toEqual([4, 5, 7, 8]);
    expect(rowFor(merged, 6)?.id).toBe(5);
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
