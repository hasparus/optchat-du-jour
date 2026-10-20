// Paged snapshots on /ws (E42): a MESSAGES_SNAPSHOT frame holds the newest entries of its window
// that fit in SNAPSHOT_BYTES, maybe none, and names the window, so the client reads the rest from
// /api/messages (web/src/lib/paging.test.ts follows a client to the end). Whatever the entries'
// sizes, no frame is over the cap, and what a frame holds is the window's tail, as the whole window
// would show it.
import { expect, test } from "bun:test";
import { EventType } from "@ag-ui/core";
import { openStream, snapshotFrame, toMessages } from "../server/agui.ts";
import { SNAPSHOT_BYTES } from "../src/config.ts";
import { newMsg } from "../src/store.ts";
import type { Entry } from "../src/tree.ts";
import type { SessionState } from "../src/wire.ts";
import type { AgUiEvent } from "../server/agui.ts";

// a log of n entries whose sizes run from a word to past the cap, in every kind, from a seeded
// generator: user messages (a long paste), replies, tool calls and their echoes, notes
const sized = (n: number, seed: number, most: number): Entry[] => {
  let x = seed;
  const next = () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return x / 2_147_483_648;
  };
  return Array.from({ length: n }, (_, i) => {
    const length = Math.floor(next() ** 3 * most) + 1; // mostly short, now and then huge
    const body = "é".repeat(length % 7) + "x".repeat(length); // two bytes a character, now and then
    switch (i % 5) {
      case 0:
        return newMsg(i, "user", body);
      case 1:
        return newMsg(i, "tool", `Bash ${JSON.stringify({ command: body })}`);
      case 2:
        return newMsg(i, "echo", body);
      case 3:
        return newMsg(i, "talk", body);
      default:
        return newMsg(i, "note", body);
    }
  });
};

const bytes = (frame: AgUiEvent) => Buffer.byteLength(JSON.stringify(frame));

test("a frame is never over the cap, holds the window's newest messages that fit, and names the window", () => {
  for (const seed of [1, 7, 42, 1234, 99_999]) {
    for (const cap of [512, 4096, 32_768]) {
      const log = sized(300, seed, cap * 2);
      for (const [from, to] of [
        [0, 0],
        [0, 1],
        [0, 300],
        [100, 300],
        [250, 251],
        [37, 199],
      ] as const) {
        const window = log.slice(from, to);
        const frame = snapshotFrame(window, from, cap);
        if (frame.type !== EventType.MESSAGES_SNAPSHOT) throw new Error("not a snapshot");
        expect(bytes(frame)).toBeLessThanOrEqual(cap);
        expect(frame.metadata).toEqual({ from, to });
        // the tail of the window as a whole (an echo first keeps its call), and as much of it as fits
        const whole = toMessages(window);
        expect(frame.messages).toEqual(whole.slice(whole.length - frame.messages.length));
        const one = whole[whole.length - frame.messages.length - 1];
        if (one !== undefined) expect(bytes({ ...frame, messages: [one, ...frame.messages] })).toBeGreaterThan(cap);
      }
    }
  }
});

const STATE: SessionState = { budget: 128_000, device: "mini", down: [], effort: null, engine: null, engines: [], followUp: "steer", messages: 0, phase: "idle", pending: [], stopped: null, viewBytes: 0, waiting: 0 };

test("the opening and the run-end snapshots of a window of 200 entries of 20 KB (4 MB) are each one frame under SNAPSHOT_BYTES", () => {
  expect(SNAPSHOT_BYTES).toBe(128 * 1024);
  const log = Array.from({ length: 200 }, (_, i) => newMsg(i, i % 2 === 0 ? "user" : "talk", `${i} `.padEnd(20_000, "x")));
  const unpaged = bytes({ messages: toMessages(log), type: EventType.MESSAGES_SNAPSHOT });
  expect(unpaged).toBeGreaterThan(4_000_000);
  const stream = openStream({ entries: log, live: null, state: { ...STATE, messages: 200 }, thread: "mini", window: 200 });
  const [opening] = stream.first;
  if (opening?.type !== EventType.MESSAGES_SNAPSHOT) throw new Error("not a snapshot");
  expect(bytes(opening)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
  expect(opening.messages.map((m) => m.id)).toEqual(["194", "195", "196", "197", "198", "199"]); // 6 of 20 KB fit
  expect(opening.metadata).toEqual({ from: 0, to: 200 });
  // a run logs two more; its end resyncs with the window that ends there
  log.push(newMsg(200, "user", "short"), newMsg(201, "talk", "y".repeat(300_000)));
  const end = stream.translate({ error: null, logged: 202, runId: "200", type: "run-finished" }).find((e) => e.type === EventType.MESSAGES_SNAPSHOT);
  if (end?.type !== EventType.MESSAGES_SNAPSHOT) throw new Error("no snapshot");
  expect(bytes(end)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
  expect(end.messages).toEqual([]); // the newest alone is past the cap: the client reads it over HTTP
  expect(end.metadata).toEqual({ from: 2, to: 202 });
});

test("a window of 200 short messages, 600 bytes of text each, is one frame whole: no page to read", () => {
  const log = Array.from({ length: 200 }, (_, i) => newMsg(i, i % 2 === 0 ? "user" : "talk", "x".repeat(600)));
  const [opening] = openStream({ entries: log, live: null, state: { ...STATE, messages: 200 }, thread: "mini", window: 200 }).first;
  if (opening?.type !== EventType.MESSAGES_SNAPSHOT) throw new Error("not a snapshot");
  expect(opening.messages).toHaveLength(200);
  expect(bytes(opening)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
});
