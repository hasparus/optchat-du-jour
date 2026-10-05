// The /ws link (SPEC "Protocol", E15). It connects at once, reconnects for ever, and hands every
// decoded AG-UI event to its listeners (the session store). The server opens each connection with a
// snapshot of the log, so a reconnect needs no replay. TanStack AI's webSocket() adapter opens its
// socket only when this client sends, and gives up when it closes, so a phone that only watches
// would never see a turn the laptop started (SPEC M2 open question).
import { Option } from "effect";
import { ABORT, type Inbound, parseFrame, runInput } from "./protocol.ts";

export type LinkStatus = "connecting" | "open" | "closed";

export type Link = {
  // a message: it starts a turn, or joins the running one (device picks where a new turn runs).
  // Sent while the link is down, it goes out on the next open: what the user wrote isn't lost.
  // `id` names the message in the server's ack.
  readonly send: (text: string, device: string | null, id: string) => void;
  // the user's cancel, for whichever turn runs. Only while the link is open: kept for later, it
  // would cancel whatever turn runs after the reconnect. False when it wasn't sent.
  readonly abort: () => boolean;
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

export function openLink(url: string, options: LinkOptions = {}): Link {
  const open = options.socket ?? ((target: string): SocketLike => new WebSocket(target));
  const firstRetry = options.retryMs ?? 1000;
  const listeners = new Set<(event: Inbound) => void>();
  const statusListeners = new Set<(status: LinkStatus) => void>();
  const outbox: string[] = []; // messages sent while disconnected: delivered on the next open
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
      if (Option.isNone(event)) {
        // not an event this client knows: say so, and keep the link (the next snapshot resyncs)
        // oxlint-disable-next-line no-console -- the only place a malformed frame shows up
        console.warn("optchat: dropped a frame it can't read", message.data.slice(0, 200));
        return;
      }
      for (const l of listeners) l(event.value);
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

  connect();

  return {
    abort: () => {
      if (!socket || status !== "open") return false;
      socket.send(ABORT);
      return true;
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
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
    send: (text, device, id) => {
      const frame = runInput(text, device, id);
      if (socket && status === "open") socket.send(frame);
      else outbox.push(frame);
    },
    status: () => status,
  };
}
