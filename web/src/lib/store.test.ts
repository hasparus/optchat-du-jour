// Invariants of the log and the session store under the orders events really arrive in: a reply
// cut off at a cancel, a reconnect mid-reply, a window that jumps while a page is loading.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { applyEvent, applyPage, emptyLog, hole, type Log, visible, withDraft } from "./log.ts";
import type { Inbound, Message } from "./protocol.ts";
import { openLink } from "./connection.ts";
import { makeSession } from "./session.ts";
import { type Entry, fakeServer, snapshot } from "../test/fixture.ts";

const u = (i: number, t = `m${i}`): Message => ({ content: t, id: String(i), role: "user" });
const a = (i: number, t: string): Message => ({ content: t, id: String(i), role: "assistant" });
const snap = (...messages: Message[]): Inbound => ({ messages, type: EventType.MESSAGES_SNAPSHOT });
const msg = (type: "START" | "CONTENT" | "END", id: number, role: "user" | "assistant", delta = ""): Inbound =>
  type === "START"
    ? { messageId: String(id), role, type: EventType.TEXT_MESSAGE_START }
    : type === "CONTENT"
      ? { delta, messageId: String(id), type: EventType.TEXT_MESSAGE_CONTENT }
      : { messageId: String(id), type: EventType.TEXT_MESSAGE_END };
const run = (log: Log, ...es: Inbound[]) => {
  let out = log;
  for (const e of es) out = applyEvent(out, e);
  return out;
};
const shown = (l: Log) => withDraft(visible(l), l.draft).map((x) => `${x.i}:${x.kind}:${x.text}`);

test("a reply whose end was missed, but is logged: once, from the snapshot", () => {
  let l = run(emptyLog, snap(u(0)), msg("START", 1, "assistant"), msg("CONTENT", 1, "assistant", "ab"));
  l = run(l, snap(u(0), a(1, "abcd")));
  expect(shown(l)).toEqual(["0:user:m0", "1:talk:abcd"]);
});

test("a reconnect mid-reply seeds the reply again, once", () => {
  let l = run(emptyLog, snap(u(0)), msg("START", 1, "assistant"), msg("CONTENT", 1, "assistant", "ab"));
  l = run(l, snap(u(0)), { runId: "r", threadId: "t", type: EventType.RUN_STARTED }, msg("START", 1, "assistant"), msg("CONTENT", 1, "assistant", "abcd"));
  expect(shown(l)).toEqual(["0:user:m0", "1:talk:abcd"]);
});

test("a cut-off reply is closed, then removed by the snapshot, and its index goes to the next message", () => {
  let l = run(emptyLog, snap(u(0)), msg("START", 1, "assistant"), msg("CONTENT", 1, "assistant", "partial"), msg("END", 1, "assistant"));
  expect(shown(l)).toEqual(["0:user:m0", "1:talk:partial"]);
  l = run(l, { message: "cancelled", type: EventType.RUN_ERROR }, snap(u(0)));
  expect(shown(l)).toEqual(["0:user:m0"]);
  l = run(l, msg("START", 1, "user"), msg("CONTENT", 1, "user", "NEXT"), msg("END", 1, "user"));
  expect(shown(l)).toEqual(["0:user:m0", "1:user:NEXT"]);
});

test("a page overlapping the window replaces it, with no duplicates", () => {
  let l = run(emptyLog, snap(u(100), u(101), u(102)));
  l = applyPage(l, [98, 99, 100, 101].map((i) => ({ i, kind: "user" as const, text: `m${i}` })));
  expect(shown(l)).toEqual(["98:user:m98", "99:user:m99", "100:user:m100", "101:user:m101", "102:user:m102"]);
});

test("a window that jumps up drops what only live events told, and leaves a hole to fill", () => {
  let l = run(emptyLog, snap(u(0), u(1)), msg("START", 2, "user"), msg("CONTENT", 2, "user", "m2"), msg("END", 2, "user"));
  l = run(l, snap(u(5), u(6)));
  expect(shown(l)).toEqual(["5:user:m5", "6:user:m6"]);
  expect(hole(l)).toEqual({ before: 5, limit: 3 });
});

test("an empty snapshot empties the log", () => {
  const l = run(emptyLog, snap(u(0), u(1)), snap());
  expect([shown(l), l.base, l.newest]).toEqual([[], 0, -1]);
});

const tick = async () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 5);
  });
const windowAt = (from: number) => snapshot(Array.from({ length: 200 }, (_, k): Entry => ({ kind: "user", text: `m${from + k}` })), from);

test("a page loading while the window jumps: the hole it leaves is filled, nothing is shown across it", async () => {
  const server = fakeServer(() => []);
  const resolvers: (() => void)[] = [];
  const messages = async (before: number, limit: number) =>
    new Promise<{ entries: { i: number; kind: "user"; text: string }[] }>((resolve) => {
      const from = before - Math.min(limit, before);
      resolvers.push(() => {
        resolve({ entries: Array.from({ length: before - from }, (_, k) => ({ i: from + k, kind: "user", text: `m${from + k}` })) });
      });
    });
  const session = makeSession(openLink("ws://x/ws", { socket: server.socket }), { messages });
  await tick();
  server.play(windowAt(300));
  const loading = session.loadOlder();
  server.play(windowAt(800));
  for (let n = 0; n < 10; n++) {
    for (const r of resolvers.splice(0)) r();
    await tick();
  }
  await loading;
  const { log } = session.get();
  expect(hole(log)).toBeNull();
  expect(visible(log).map((x) => x.i)).toEqual(Array.from({ length: 800 }, (_, k) => 200 + k));
  session.dispose();
});
