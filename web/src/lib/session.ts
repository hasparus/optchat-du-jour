// The session as this client sees it (SPEC "Web UI", Chat; "Protocol"): the log (log.ts: entries
// by log index and the reply streaming in), the server's state (phase, device, view size, queued
// mid-run messages), status markers from CUSTOM info and RUN_ERROR, whether the model is thinking,
// and the messages sent from here that the log doesn't hold yet. Every AG-UI event and every page of
// /api/messages comes through here; the screens only draw it.
import { type Kind, logIndex, SessionState } from "@wire";
import { EventType } from "@ag-ui/core";
import { Option, Schema } from "effect";
import { api } from "./api.ts";
import type { Link, LinkStatus } from "./connection.ts";
import { applyEvent, applyPage, dropBelow, emptyLog, hole, type Log, lowest, tip, trimHeld } from "./log.ts";
import type { Inbound, Patch } from "./protocol.ts";

export type Marker = {
  readonly key: number;
  readonly after: number; // shown after the log entry with this index (-1: before all)
  readonly text: string;
  readonly tone: "info" | "error";
};

// Sent from here and not in the log yet. The server's ack (CUSTOM "ack", matched on `id`, the id the
// message went out with) says it is logged, and then it is no longer pending, or that it could not
// be: `error`. `from` is the log's length then, so its entry has an index at least that, and `conn`
// the connection it went out on: an ack told to an earlier one is lost, see `logged` below.
export type Pending = {
  readonly id: string;
  readonly text: string;
  readonly from: number;
  readonly conn: number;
  readonly error: string | null;
};

export type Session = {
  readonly status: LinkStatus;
  readonly state: SessionState | null;
  readonly log: Log;
  readonly markers: readonly Marker[];
  readonly thinking: boolean;
  readonly pending: readonly Pending[];
};

const MAX_MARKERS = 100;
const MAX_ACKED = 1000; // log indexes of acked messages remembered
// what a message sent on a connection that dropped is marked with when the server shows no sign of it
export const UNSENT = "it may not have reached the server: send it again";
const PAGE = 100; // older entries per page
const MAX_FILL = 500; // a wider hole under the window is dropped, not fetched

const initial: Session = { log: emptyLog, markers: [], pending: [], state: null, status: "connecting", thinking: false };

export type Queued = { readonly text: string; readonly error: string | null };

// What waits for the model: the server's untaken mid-run messages, then ours it hasn't logged. A
// mid-run message of ours is in both lists until its ack: the server's copy stands for it.
export function queued(s: Session): Queued[] {
  const out: Queued[] = (s.state?.queued ?? []).map((text) => ({ error: null, text }));
  const left = [...(s.state?.queued ?? [])];
  for (const p of s.pending) {
    const at = left.indexOf(p.text);
    if (at === -1) out.push({ error: p.error, text: p.text });
    else {
      left.splice(at, 1);
      if (p.error !== null) out[at] = { error: p.error, text: p.text };
    }
  }
  return out;
}

const parseState = Schema.decodeUnknownOption(SessionState);

// JSON Patch over the state object. The server sends only top-level "replace" ops; "add" and
// "remove" are applied too. Any other op, or a nested path, is logged and skipped: the rest of the
// frame still applies, and the next STATE_SNAPSHOT (every reconnect) sets the whole state again.
function patch(state: Record<string, Schema.Json>, ops: readonly Patch[]) {
  const next = new Map(Object.entries(state));
  for (const op of ops) {
    const key = op.path.slice(1);
    const top = op.path.startsWith("/") && !key.includes("/");
    if (top && (op.op === "replace" || op.op === "add") && op.value !== undefined) next.set(key, op.value);
    else if (top && op.op === "remove") next.delete(key);
    // oxlint-disable-next-line no-console -- the only place a patch the client can't apply shows up
    else console.warn("optchat: skipped a state patch it can't apply", op);
  }
  return Object.fromEntries(next);
}

export type SessionOptions = {
  // /api/messages; tests replace it
  readonly messages?: (before: number, limit: number) => Promise<{ readonly entries: readonly { readonly i: number; readonly kind: Kind; readonly text: string }[] }>;
};

export function makeSession(link: Pick<Link, "listen" | "onStatus" | "send" | "status">, options: SessionOptions = {}) {
  const messages = options.messages ?? api.messages;
  let s: Session = { ...initial, status: link.status() };
  let raw: Record<string, Schema.Json> = {};
  let conns = s.status === "open" ? 1 : 0; // the connections opened so far
  let keys = 0;
  let filling = false;
  let atEnd = true; // the reader is at the chat's newest end: what scrolled out of sight may be dropped
  // the log indexes the server acked to any client: those entries are that client's message, so
  // never one of ours matched by its text
  const ackedAt = new Set<number>();
  const subscribers = new Set<() => void>();

  const set = (next: Partial<Session>) => {
    s = { ...s, ...next };
    for (const f of subscribers) f();
  };
  const mark = (text: string, tone: Marker["tone"]) => {
    set({ markers: [...s.markers, { after: tip(s.log), key: keys++, text, tone }].slice(-MAX_MARKERS) });
  };
  const applyState = (next: Record<string, Schema.Json>) => {
    raw = next;
    const state = parseState(raw);
    if (Option.isSome(state)) set({ state: state.value });
  };
  // The server's word on one of our messages: it is logged, and the user entry follows at once, or
  // it could not be (it stays queued there, and is logged with the next message, unannounced).
  const acked = (id: string, error: string | null, index: number | null) => {
    if (index !== null) {
      ackedAt.add(index);
      for (const old of ackedAt) {
        if (ackedAt.size <= MAX_ACKED) break;
        ackedAt.delete(old); // the oldest first
      }
    }
    const at = s.pending.findIndex((p) => p.id === id);
    const p = s.pending[at];
    if (p === undefined) return; // another client's message
    set({ pending: index === null ? s.pending.toSpliced(at, 1, { ...p, error: error ?? "not logged" }) : s.pending.toSpliced(at, 1) });
  };
  // A user entry was logged without an ack for us: one a failed ack told of earlier, or one sent on
  // a connection that has dropped since (its ack, told to nobody, is lost). Only these are matched
  // by their text, on the entry's index, as the oldest of them it can be, and never on an index
  // whose ack named another message.
  const logged = (i: number, text: string) => {
    if (ackedAt.has(i)) return;
    const at = s.pending.findIndex((p) => (p.error !== null || p.conn < conns) && p.text === text && i >= p.from);
    if (at !== -1) set({ pending: s.pending.toSpliced(at, 1) });
  };
  // After a reconnect: a message sent on a connection that dropped, which the log doesn't hold and
  // the server doesn't hold either (not among its queued), may have been lost with the socket. It
  // is marked so, and stays in the queue; the log taking it later clears it as above.
  const unsent = () => {
    const queuedThere = [...(s.state?.queued ?? [])];
    const marked = s.pending.map((p) => {
      if (p.conn >= conns || p.error !== null) return p;
      const k = queuedThere.indexOf(p.text);
      if (k !== -1) {
        queuedThere.splice(k, 1);
        return p;
      }
      return { ...p, error: UNSENT };
    });
    if (marked.some((p, k) => p !== s.pending[k])) set({ pending: marked });
  };
  const setLog = (log: Log) => {
    if (log !== s.log) set({ log });
  };

  // older entries a hole cuts off from the window (it moved up while this page slept): fetch the
  // hole, or forget them when it is too wide, until what is held below the window is shown
  const fill = async () => {
    if (filling) return;
    filling = true;
    try {
      for (let gap = hole(s.log); gap !== null; gap = hole(s.log)) {
        if (gap.limit > MAX_FILL) {
          setLog(dropBelow(s.log, gap.before));
          break;
        }
        const page = await messages(gap.before, gap.limit);
        // a page that doesn't reach the window (the log is shorter than this client thought)
        // can't close the hole: what lies below it is forgotten instead
        if (page.entries.at(-1)?.i !== gap.before - 1) {
          setLog(dropBelow(s.log, gap.before));
          break;
        }
        setLog(applyPage(s.log, page.entries));
      }
    } catch {
      // offline again: the hole stays hidden, and the next snapshot tries again
    } finally {
      filling = false;
    }
  };

  const event = (e: Inbound) => {
    const before = s.log;
    setLog(applyEvent(s.log, e, { trim: atEnd }));
    switch (e.type) {
      case EventType.MESSAGES_SNAPSHOT: {
        // the snapshot is the log: a marker placed after what it doesn't hold (a reply cut off by a
        // cancel, whose index goes to the next entry) goes after its last entry instead
        const { newest } = s.log;
        if (s.pending.length > 0) for (const item of s.log.items.values()) if (item.kind === "user" && item.i >= s.log.base) logged(item.i, item.text);
        set({ markers: s.markers.some((m) => m.after > newest) ? s.markers.map((m) => (m.after > newest ? { ...m, after: newest } : m)) : s.markers, thinking: false });
        if (hole(s.log)) void fill();
        return;
      }
      // a connection's first word, after the log's snapshot
      case EventType.STATE_SNAPSHOT:
        applyState({ ...e.snapshot });
        unsent();
        return;
      case EventType.STATE_DELTA:
        applyState(patch(raw, e.delta));
        return;
      case EventType.TEXT_MESSAGE_END: {
        // a user entry, now whole: it may be one sent from here
        const d = before.draft;
        if (d?.kind === "user" && String(d.i) === e.messageId) logged(d.i, d.text);
        return;
      }
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TOOL_CALL_START:
        if (s.thinking && s.log.draft?.kind !== "user") set({ thinking: false });
        return;
      case EventType.RUN_FINISHED:
        set({ thinking: false });
        return;
      case EventType.RUN_ERROR:
        set({ thinking: false });
        mark(e.message, "error");
        return;
      case EventType.CUSTOM:
        if (e.name === "info") mark(e.value, "info");
        else if (e.name === "thinking") set({ thinking: true });
        else if (e.name === "ack") acked(e.value.clientId, e.value.error, e.value.messageId === null ? null : logIndex(e.value.messageId));
        return;
      case EventType.RUN_STARTED:
      case EventType.TEXT_MESSAGE_START:
      case EventType.TOOL_CALL_ARGS:
      case EventType.TOOL_CALL_END:
      case EventType.TOOL_CALL_RESULT:
        return;
    }
  };

  const unlisten = link.listen(event);
  const unstatus = link.onStatus((status) => {
    if (status === "open") conns++;
    set(status === "open" ? { status } : { status, thinking: false });
  });

  return {
    get: () => s,
    subscribe: (f: () => void) => {
      subscribers.add(f);
      return () => {
        subscribers.delete(f);
      };
    },
    // a message from the composer: shown as queued until its ack. Sent while the link is down, it
    // goes out on the next connection.
    send: (text: string, device: string | null) => {
      const id = crypto.randomUUID();
      const conn = s.status === "open" ? conns : conns + 1;
      set({ pending: [...s.pending, { conn, error: null, from: s.state?.messages ?? 0, id, text }] });
      link.send(text, device, id);
    },
    // the reader reached the chat's newest end, or left it: only there are the oldest entries dropped
    scrolled: (end: boolean) => {
      atEnd = end;
      if (end) setLog(trimHeld(s.log));
    },
    // one older page under what is shown; true while there may be more
    loadOlder: async () => {
      const low = lowest(s.log);
      if (low <= 0) return false;
      const page = await messages(low, PAGE);
      setLog(applyPage(s.log, page.entries));
      return (page.entries[0]?.i ?? 0) > 0;
    },
    dispose: () => {
      unlisten();
      unstatus();
    },
  };
}
export type SessionStore = ReturnType<typeof makeSession>;
