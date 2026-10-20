// Paged snapshots (E42), from the server's frames to what this client holds: the opening and the
// run-end MESSAGES_SNAPSHOT carry only the newest entries of their window that fit in the cap, and
// the session store reads the rest from /api/messages. The frames are server/agui.ts's own, decoded
// as the link decodes them; /api/messages answers from the same log. Whatever the sizes, the store
// ends with every entry of the window once, in order, as logged.
import { EventType } from "@ag-ui/core";
import { expect, test } from "bun:test";
import { Option } from "effect";
import { type AgUiEvent, openStream } from "../../../server/agui.ts";
import { newMsg } from "../../../src/store.ts";
import type { Entry } from "../../../src/tree.ts";
import { fakeServer, IDLE } from "../test/fixture";
import { openLink } from "./connection";
import { visible } from "./log";
import { type Inbound, parseFrame } from "./protocol";
import { makeSession } from "./session";

const CAP = 2048;
const WINDOW = 60;

const tick = async (ms = 20) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// entries of every kind, some past the cap (a long paste, a long reply)
const entryAt = (i: number) => {
  const body = `${i}:`.padEnd([10, 300, 900, 2500][i % 4] ?? 10, "z");
  switch (i % 4) {
    case 0:
      return newMsg(i, "user", body);
    case 1:
      return newMsg(i, "tool", `Read ${JSON.stringify({ file_path: body })}`);
    case 2:
      return newMsg(i, "echo", body);
    default:
      return newMsg(i, "talk", body);
  }
};

// a server whose log is `log`: each socket greeted as server/agui.ts greets it, frames over the cap
// counted; /api/messages pages read from the same log
const serve = (log: Entry[]) => {
  const over: number[] = [];
  const decode = (events: readonly AgUiEvent[]): Inbound[] =>
    events.flatMap((e) => {
      const frame = JSON.stringify(e);
      if (e.type === EventType.MESSAGES_SNAPSHOT && Buffer.byteLength(frame) > CAP) over.push(Buffer.byteLength(frame));
      return Option.toArray(parseFrame(frame));
    });
  let stream = openStream({ cap: CAP, entries: log, live: null, state: { ...IDLE, messages: log.length }, thread: "mini", window: WINDOW });
  const server = fakeServer(() => {
    stream = openStream({ cap: CAP, entries: log, live: null, state: { ...IDLE, messages: log.length }, thread: "mini", window: WINDOW });
    return decode(stream.first);
  });
  const asked: string[] = [];
  const messages = async (before: number, limit: number) => {
    asked.push(`${before}/${limit}`);
    return { entries: log.slice(Math.max(0, before - limit), before) };
  };
  const link = openLink("ws://x/ws", { retryMs: 1, socket: server.socket });
  const session = makeSession(link, { messages });
  // the run that logs `more` ends: its entries live, then its end and snapshot
  const run = (more: readonly Entry[]) => {
    const events: AgUiEvent[] = [];
    for (const entry of more) {
      log.push(entry);
      events.push(...stream.translate({ entry, runId: "r", type: "logged" }));
    }
    events.push(...stream.translate({ error: null, logged: log.length, runId: "r", type: "run-finished" }));
    server.play(...decode(events));
  };
  return { asked, over, run, server, session };
};

// what the store shows: each entry's index and text, oldest first
const held = (s: ReturnType<typeof serve>["session"]) => visible(s.get().log).map((x) => [x.i, x.text] as const);
const logged = (log: readonly Entry[], from: number) => log.slice(from).map((e) => [e.i, e.text] as const);
// The store shows the log from some index to its end, as logged, each entry once, down to the
// window's start at least (older entries it held before stay, without a gap)
const whole = (s: ReturnType<typeof serve>["session"], log: readonly Entry[]) => {
  const shown = held(s);
  const first = shown[0]?.[0] ?? log.length;
  expect(first).toBeLessThanOrEqual(Math.max(0, log.length - WINDOW));
  expect(shown).toEqual(logged(log, first));
};

test("the opening snapshot's frame holds what fits; the rest of its window comes from /api/messages, every entry once", async () => {
  const log = Array.from({ length: 150 }, (_, i) => entryAt(i));
  const { asked, over, session } = serve(log);
  await tick();
  expect(over).toEqual([]);
  expect(held(session)).toEqual(logged(log, 150 - WINDOW));
  expect(asked.length).toBeGreaterThan(0); // the frame alone couldn't hold the window
  expect(asked.every((a) => Number(a.split("/")[1]) <= 100)).toBe(true); // a page at a time
});

test("a run's end resyncs with a frame under the cap, its own entries told live re-read; a newest entry past the cap alone comes over HTTP", async () => {
  const log = Array.from({ length: 80 }, (_, i) => entryAt(i));
  const { over, run, session } = serve(log);
  await tick();
  run([entryAt(80), entryAt(81), entryAt(82), entryAt(83)]);
  await tick();
  expect(over).toEqual([]);
  whole(session, log);
  // the frame after this run holds no message at all: its one entry is past the cap
  run([newMsg(84, "talk", "w".repeat(3 * CAP))]);
  await tick();
  expect(over).toEqual([]);
  whole(session, log);
});

test("a reconnect after the window moved on: the new frame, the rest of its window, and what was held below it, with no gap and nothing twice", async () => {
  const log = Array.from({ length: 70 }, (_, i) => entryAt(i));
  const { server, session } = serve(log);
  await tick();
  for (let i = 70; i < 100; i++) log.push(entryAt(i)); // logged while the page slept
  server.drop();
  await tick(40);
  const shown = held(session);
  expect(shown).toEqual(logged(log, 70 - WINDOW)); // what it held from before, and all that came after
  expect(new Set(shown.map(([i]) => i)).size).toBe(shown.length);
});
