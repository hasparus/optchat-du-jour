// The /ws link (SPEC "Protocol", E15) and our TanStack AI connection adapter over it. TanStack's own
// webSocket() opens its socket only when this client sends, and gives up when it closes, so a
// phone that only watches would never see a turn the laptop started (SPEC M2 open question). This
// one connects at once, reconnects for ever, and hands every decoded frame both to useChat (as
// AG-UI chunks) and to the session store. The server opens each connection with a snapshot of the
// log, so a reconnect needs no replay.
import type { SubscribeConnectionAdapter } from "@tanstack/ai-client";
import type { StreamChunk } from "@tanstack/ai";
import { Option } from "effect";
import { ABORT, type Inbound, parseFrame, runInput } from "./protocol.ts";

export type LinkStatus = "connecting" | "open" | "closed";

export type Link = {
  // for useChat({ connection, live: true }); its send() is never used: see `send` below
  readonly connection: SubscribeConnectionAdapter;
  // a message: it starts a turn, or joins the running one (forwardedProps.device picks the device)
  readonly send: (text: string, device: string | null) => void;
  // the user's cancel, for whichever turn runs
  readonly abort: () => void;
  readonly listen: (listener: (event: Inbound) => void) => () => void;
  readonly onStatus: (listener: (status: LinkStatus) => void) => () => void;
  readonly status: () => LinkStatus;
  readonly close: () => void;
};

// the part of a WebSocket the link uses; the server sends text frames only
export type SocketLike = {
  addEventListener(type: "open" | "close", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: string }) => void): void;
  send(frame: string): void;
  close(): void;
};

export type LinkOptions = {
  readonly socket?: (url: string) => SocketLike; // tests replace the WebSocket
  readonly retryMs?: number; // the first reconnect delay; it doubles up to 10 s
};

const MAX_RETRY_MS = 10_000;

// a decoded frame is an AG-UI event as TanStack AI types it (arrays are decoded mutable for this)
const toChunk = (e: Inbound): StreamChunk => e;

// a push-to-pull pipe: chunks queue until the chat client pulls them, until its signal aborts
function pipe(signal: AbortSignal | undefined, done: () => void) {
  const queue: StreamChunk[] = [];
  let wake: (() => void) | null = null;
  const push = (chunk: StreamChunk) => {
    queue.push(chunk);
    wake?.();
  };
  const onAbort = () => wake?.();
  signal?.addEventListener("abort", onAbort);
  async function* chunks() {
    try {
      while (!signal?.aborted) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      done();
    }
  }
  return { chunks: chunks(), push };
}

export function openLink(url: string, options: LinkOptions = {}): Link {
  const open = options.socket ?? ((target: string): SocketLike => new WebSocket(target));
  const firstRetry = options.retryMs ?? 1000;
  const listeners = new Set<(event: Inbound) => void>();
  const statusListeners = new Set<(status: LinkStatus) => void>();
  const sinks = new Set<(chunk: StreamChunk) => void>();
  const outbox: string[] = []; // sent while disconnected: delivered on the next open
  let socket: SocketLike | null = null;
  let status: LinkStatus = "connecting";
  let retry = firstRetry;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const setStatus = (next: LinkStatus) => {
    status = next;
    for (const l of statusListeners) l(next);
  };

  const connect = () => {
    if (closed) return;
    setStatus("connecting");
    const ws = open(url);
    socket = ws;
    ws.addEventListener("open", () => {
      if (ws !== socket) return;
      retry = firstRetry;
      setStatus("open");
      for (const frame of outbox.splice(0)) ws.send(frame);
    });
    ws.addEventListener("message", (message) => {
      if (ws !== socket) return;
      const event = parseFrame(message.data);
      if (Option.isNone(event)) return;
      for (const l of listeners) l(event.value);
      const chunk = toChunk(event.value);
      for (const sink of sinks) sink(chunk);
    });
    ws.addEventListener("close", () => {
      if (ws !== socket) return;
      socket = null;
      setStatus("closed");
      if (closed) return;
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, MAX_RETRY_MS);
    });
  };

  const write = (frame: string) => {
    if (socket && status === "open") socket.send(frame);
    else outbox.push(frame);
  };

  connect();

  return {
    abort: () => {
      write(ABORT);
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    },
    connection: {
      send: async () => {
        // useChat's sendMessage queues a message while a run streams and shows it under a client id;
        // ours goes out at once through Link.send, and comes back as the server logs it
      },
      subscribe: (signal) => {
        const p = pipe(signal, () => {
          sinks.delete(p.push);
        });
        sinks.add(p.push);
        return p.chunks;
      },
    },
    listen: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => {
        statusListeners.delete(listener);
      };
    },
    send: (text, device) => {
      write(runInput(text, device));
    },
    status: () => status,
  };
}
