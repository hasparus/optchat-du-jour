// How long the /ws link takes to come back, at the shipped timings (SILENT_MS 10 s, a 1 s first
// retry), on fake timers: a dead network, a half-open socket and a slow link (SPEC "Protocol",
// the heartbeat). After the review's simulation of #41.
import { EventType } from "@ag-ui/core";
import { expect, jest, test } from "bun:test";
import { openLink, type SocketLike } from "./connection";

type Net = "hang" | "ok" | { readonly firstFrameMs: number };

// The link over a network that is `net(now)` when each socket starts, for `untilMs`: a socket
// that isn't hung opens after 20 ms, delivers its opening snapshot (after 50 ms, or firstFrameMs),
// then the server's beat every 5 s while the network stays up. When each socket opened and each
// snapshot came, in ms.
const run = (net: (now: number) => Net, untilMs: number) => {
  jest.useFakeTimers();
  let now = 0;
  const opened: number[] = [], snapshots: number[] = [];
  const link = openLink("ws://x/ws", {
    socket: () => {
      opened.push(now);
      const opens: (() => void)[] = [];
      const messages: ((e: { readonly data: string }) => void)[] = [];
      let gone = false;
      const say = (data: string) => {
        for (const l of messages) l({ data });
      };
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
      const mode = net(now);
      if (mode === "hang") return ws;
      setTimeout(() => {
        if (!gone) for (const l of opens) l();
      }, 20);
      setTimeout(
        () => {
          if (gone) return;
          snapshots.push(now);
          say(JSON.stringify({ messages: [], type: EventType.MESSAGES_SNAPSHOT }));
          const beat = () => {
            if (gone || net(now) === "hang") return;
            say(JSON.stringify({ delta: [], type: EventType.STATE_DELTA }));
            setTimeout(beat, 5000);
          };
          setTimeout(beat, 5000);
        },
        mode === "ok" ? 50 : mode.firstFrameMs,
      );
      return ws;
    },
  });
  try {
    for (; now < untilMs; now += 100) jest.advanceTimersByTime(100);
  } finally {
    link.close();
    jest.useRealTimers();
  }
  return { opened, snapshots };
};

test("a dead network (every handshake hangs) for 5 minutes: back within 20 s of the network", () => {
  const { opened, snapshots } = run((t) => (t < 300_000 ? "hang" : "ok"), 400_000);
  const back = snapshots.find((t) => t >= 300_000);
  expect(back).toBeDefined();
  expect((back ?? Number.POSITIVE_INFINITY) - 300_000).toBeLessThanOrEqual(20_000);
  // a hung handshake never widens the window: tries come every ~10 s plus the backoff (at most 10 s)
  const gaps = opened.slice(1).map((t, k) => t - (opened[k] ?? 0));
  expect(Math.max(...gaps)).toBeLessThanOrEqual(20_100);
});

test("an open socket that had delivered frames goes half-open: reopened at once, its snapshot within ~10 s", () => {
  // the beat due at 60.05 s never comes (the connection went half-open: no close, no frame); the
  // last frame was the beat at 55.05 s, so the link lets go at 65.05 s and reconnects at once
  const { opened, snapshots } = run((t) => (t >= 60_000 && t < 60_100 ? "hang" : "ok"), 120_000);
  expect(opened).toHaveLength(2);
  expect(opened[1]).toBeGreaterThanOrEqual(65_000);
  expect(opened[1]).toBeLessThanOrEqual(65_200);
  expect((snapshots[1] ?? 0) - (opened[1] ?? 0)).toBeLessThanOrEqual(100);
});

test("a slow link whose first frame takes 25 s each time gets its snapshot, and keeps the socket", () => {
  const { opened, snapshots } = run(() => ({ firstFrameMs: 25_000 }), 300_000);
  expect(snapshots).toHaveLength(1);
  // let go at 10 s and 20 s windows, then a 40 s window is long enough, and it stays
  expect(opened.length).toBeLessThanOrEqual(3);
});
