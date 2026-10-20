// The /ws link (SPEC "Protocol", E15). It connects at once, reconnects for ever, and hands every
// decoded AG-UI event to its listeners (the session store). The server opens each connection with a
// snapshot of the log, so a reconnect needs no replay. The server says something at least every
// 5 s (its heartbeat, a STATE_DELTA); a socket silent for SILENT_MS is dead, whatever it says, and
// is opened afresh (after UniiChat's link, docs/uniichat.md). TanStack AI's webSocket() adapter opens its
// socket only when this client sends, and gives up when it closes, so a phone that only watches
// would never see a turn the laptop started (SPEC M2 open question).
// Every message and action goes out with an id and is kept until the server says it got it (E41,
// CUSTOM `received`); what is kept goes out again, in the order it was made, on every socket that
// opens, and the server answers a repeat without doing it again. So nothing the user did is lost
// with a socket that drops, nor done twice (after UniiChat's link, docs/uniichat.md).
import { EventType } from "@ag-ui/core";
import { WIRE_STALE } from "@wire";
import { Option } from "effect";
import { type Action, actionFrame, type AttachmentRef, type Forwarded, type Inbound, parseFrame, runInput, type Settings, type SubagentAction } from "./protocol.ts";

// "outdated": the server runs another build and closed the socket with WIRE_STALE (E44); the link
// stays down until the page reloads
export type LinkStatus = "connecting" | "open" | "closed" | "outdated";

export type Link = {
  // a message: it starts a turn, or joins the running one. Sent while the link is down, it goes out
  // on the next open: what the user wrote isn't lost. `id` names it to the server, which answers it
  // once (sent again with an id the link still keeps, it goes out once); `attachments` were uploaded
  // first (PUT /api/assets); the rest is its forwardedProps (protocol.ts).
  readonly send: (text: string, id: string, o?: Forwarded & { readonly attachments?: readonly AttachmentRef[] }) => void;
  // The user's cancel of the run of the turn loop this page saw (the state's `loop`; a page with no
  // state to name one sends none). Like every action below but the setting, made only while the
  // link is open: what the user sees then is what they act on; once made it is kept, and sent again
  // if its socket drops first. False when the link was down.
  readonly abort: (loop: number) => boolean;
  // a held message back, by the id it was sent with
  readonly takeBack: (clientId: string) => boolean;
  // the follow-up setting; made while the link is down, it goes out on the next open
  readonly configure: (change: Pick<Settings, "followUp">) => void;
  // a turn waiting for a model goes on, on this engine
  readonly resume: (engine: string, loop: number) => boolean;
  // a subagent card's tell, stop or model (SPEC M7a)
  readonly subagent: (action: SubagentAction) => boolean;
  // Background work's Stop all: the turn and every running subagent
  readonly stopAll: (loop: number) => boolean;
  readonly listen: (listener: (event: Inbound) => void) => () => void;
  readonly onStatus: (listener: (status: LinkStatus) => void) => () => void;
  readonly status: () => LinkStatus;
  // the page is back in front after `awayMs` hidden (wakeOnReturn). A link that is down tries again
  // now, not after a backoff that grew while nothing could connect. One that says it is open but
  // was away STALE_MS or more is opened afresh: iOS suspends a hidden page and may kill its socket
  // without a close event, and a socket like that would sit "open" and dead. The server greets every
  // connection with a snapshot, so nothing is lost. A link still connecting is left to finish.
  readonly wake: (awayMs: number) => void;
  readonly close: () => void;
};

// the part of a WebSocket the link uses; the server sends text frames only
export type SocketLike = {
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "close", listener: (event: { readonly code?: number }) => void): void;
  addEventListener(type: "message", listener: (event: { readonly data: string }) => void): void;
  send(frame: string): void;
  close(): void;
};

export type LinkOptions = {
  readonly socket?: (url: string) => SocketLike; // tests replace the WebSocket
  readonly retryMs?: number; // the first reconnect delay; it doubles up to 10 s
  readonly silentMs?: number; // SILENT_MS
};

const MAX_RETRY_MS = 10_000;
export const STALE_MS = 30_000; // hidden this long, an open socket is no longer trusted
// Heard nothing for this long, a socket is dead: two of the server's 5 s heartbeats (HEARTBEAT,
// src/config.ts) missed. A half-open connection (a laptop on a new Wi-Fi, a NAT that forgot it)
// never gets a close event, and would otherwise sit "open" until the page is hidden and shown.
export const SILENT_MS = 10_000;
// A frame takes as long as it takes to arrive, and the heartbeat can't cut into one: the opening
// MESSAGES_SNAPSHOT can be megabytes, which on a slow link takes longer than SILENT_MS. So each
// socket in a row let go after it opened but before it delivered a frame doubles the window the
// next open socket gets, up to this many times SILENT_MS; the first frame a socket delivers brings
// it back to SILENT_MS. A handshake that hangs downloads nothing: it gets SILENT_MS, and the
// backoff, so a dead link is back within ~20 s of the network.
const MAX_SILENT_GROWTH = 16;

export function openLink(url: string, options: LinkOptions = {}): Link {
  const open = options.socket ?? ((target: string): SocketLike => new WebSocket(target));
  const firstRetry = options.retryMs ?? 1000;
  const silentMs = options.silentMs ?? SILENT_MS;
  const listeners = new Set<(event: Inbound) => void>();
  const statusListeners = new Set<(status: LinkStatus) => void>();
  // what the server hasn't said it got yet (E41), in the order it was made: sent on every open
  const unacked: { readonly id: string; readonly frame: string }[] = [];
  let socket: SocketLike | null = null;
  let status: LinkStatus = "connecting";
  let retry = firstRetry;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let silence: ReturnType<typeof setTimeout> | undefined; // armed while a socket is ours; any frame resets it
  let mute = 0; // sockets in a row let go before they said anything
  let rearm: (() => void) | null = null; // the current socket's silence timer, started again (by wake)
  let closed = false;

  const setStatus = (next: LinkStatus) => {
    status = next;
    for (const l of statusListeners) l(next);
  };

  const deliver = (id: string, frame: string) => {
    if (unacked.some((a) => a.id === id)) return; // kept already: it goes out on each open
    unacked.push({ id, frame });
    if (socket && status === "open") socket.send(frame);
  };
  // an action made only while the link is open (Link.abort)
  const now = (action: Action) => {
    if (!socket || status !== "open") return false;
    const id = crypto.randomUUID();
    deliver(id, actionFrame(action, id));
    return true;
  };

  // A socket that has said nothing for its window is let go. One that had delivered a frame is
  // opened afresh at once: the server was there, the path to it was lost. One that never said
  // anything goes the way of a refused connection, the backoff; and if it had opened (it was
  // receiving its first frame, on a slow link), the next open socket gets twice the window, so a
  // link that is only slow gets its snapshot in the end instead of starting the same download every
  // 10 s. A socket still connecting always gets SILENT_MS. Its close event, if one ever comes, is
  // then not ours.
  const hush = (ws: SocketLike, heard: () => boolean) => {
    clearTimeout(silence);
    const opened = status === "open";
    silence = setTimeout(
      () => {
        if (ws !== socket || closed) return;
        socket = null;
        ws.close();
        setStatus("closed");
        if (heard()) {
          retry = firstRetry;
          timer = setTimeout(connect, 0);
          return;
        }
        if (opened) mute = Math.min(mute + 1, Math.log2(MAX_SILENT_GROWTH));
        timer = setTimeout(connect, retry);
        retry = Math.min(retry * 2, MAX_RETRY_MS);
      },
      opened ? silentMs * 2 ** mute : silentMs,
    );
  };

  const connect = () => {
    if (closed) return;
    setStatus("connecting");
    const ws = open(url);
    socket = ws;
    let heard = false; // whether this socket has delivered a frame: only then has it worked
    const arm = () => {
      hush(ws, () => heard);
    };
    arm();
    rearm = arm;
    ws.addEventListener("open", () => {
      if (ws !== socket) return;
      setStatus("open");
      arm(); // open now: the window a first frame may take
      for (const { frame } of unacked) ws.send(frame);
    });
    ws.addEventListener("message", (message) => {
      if (ws !== socket) return;
      if (!heard) {
        heard = true;
        retry = firstRetry; // a socket that delivers has worked: the next drop reconnects at once
        mute = 0;
      }
      arm(); // anything the server says, a heartbeat or a frame this client can't read, says it is there
      const event = parseFrame(message.data);
      if (Option.isNone(event)) {
        // not an event this client knows: say so, and keep the link (the next snapshot resyncs)
        // oxlint-disable-next-line no-console -- the only place a malformed frame shows up
        console.warn("optchat: dropped a frame it can't read", message.data.slice(0, 200));
        return;
      }
      const e = event.value;
      if (e.type === EventType.CUSTOM && e.name === "received") {
        const at = unacked.findIndex((a) => a.id === e.value.id);
        if (at !== -1) unacked.splice(at, 1);
      }
      for (const l of listeners) l(e);
    });
    ws.addEventListener("close", (event) => {
      if (ws !== socket) return;
      clearTimeout(silence);
      socket = null;
      // a server of another build: reconnecting would get the same answer, so the page reloads instead
      if (event.code === WIRE_STALE) {
        closed = true;
        setStatus("outdated");
        return;
      }
      setStatus("closed");
      if (closed) return;
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, MAX_RETRY_MS);
    });
  };

  connect();

  return {
    abort: (loop) => now({ loop, type: "abort" }),
    close: () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(silence);
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
    send: (text, id, o) => {
      deliver(id, runInput(text, id, o));
    },
    takeBack: (clientId) => now({ clientId, type: "take-back" }),
    configure: (change) => {
      const id = crypto.randomUUID();
      deliver(id, actionFrame({ ...change, type: "settings" }, id));
    },
    wake: (awayMs) => {
      if (closed) return;
      if (status === "closed") {
        clearTimeout(timer);
      } else if (status === "open" && awayMs >= STALE_MS) {
        const stale = socket;
        socket = null; // its close event, if one ever comes, is then not this link's
        clearTimeout(silence);
        stale?.close();
      } else {
        // kept: iOS held our timers while the page was away, so an open socket's silence timer is
        // overdue and could fire before the frames that came meanwhile are handed over; it starts
        // again now. One still connecting keeps its timer: a handshake that hangs isn't helped.
        if (status === "open") rearm?.();
        return;
      }
      retry = firstRetry;
      connect();
    },
    resume: (engine, loop) => now({ engine, loop, type: "resume" }),
    status: () => status,
    stopAll: (loop) => now({ loop, type: "stop-all" }),
    subagent: (action) => now(action),
  };
}

// The page's side of wake: how long it was hidden, from visibilitychange (Safari, the PWA and the
// iOS app's WKWebView all fire it when iOS sends them to the background), and `online` after the
// network was gone, when any socket is suspect. Returns the unsubscribe.
export function wakeOnReturn(link: Pick<Link, "wake">, doc: Document = document, now: () => number = Date.now): () => void {
  let hiddenAt = doc.visibilityState === "hidden" ? now() : null;
  const visibility = () => {
    if (doc.visibilityState === "hidden") {
      hiddenAt = now();
      return;
    }
    link.wake(hiddenAt === null ? 0 : now() - hiddenAt);
    hiddenAt = null;
  };
  const online = () => {
    link.wake(Number.POSITIVE_INFINITY);
  };
  const view = doc.defaultView;
  doc.addEventListener("visibilitychange", visibility);
  view?.addEventListener("online", online);
  return () => {
    doc.removeEventListener("visibilitychange", visibility);
    view?.removeEventListener("online", online);
  };
}
