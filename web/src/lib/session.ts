// The session as this client sees it (SPEC "Web UI", Chat; "Protocol"): the log (log.ts: entries
// by log index and the reply streaming in), the server's state (phase, device, view size, the
// messages it holds unlogged), status markers from CUSTOM info and RUN_ERROR, whether the model is thinking,
// and the messages sent from here that the log doesn't hold yet (kept across a reload, ./draft.ts).
// Every AG-UI event and every page of /api/messages comes through here; the screens only draw it.
import { type Asset, type FollowUp, type Kind, logIndex, SessionState, splitMarkers } from "@wire";
import { EventType } from "@ag-ui/core";
import { Option, Schema } from "effect";
import { api } from "./api.ts";
import { refOf } from "./attach.ts";
import type { Link, LinkStatus } from "./connection.ts";
import { loadSent, saveSent } from "./draft.ts";
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
// the connection it went out on: an ack told to an earlier one is lost, see `logged` below (one
// sent before a reload has conn 0, older than any connection of this page).
export type Pending = {
  readonly id: string;
  readonly text: string;
  readonly media: readonly Asset[]; // its attachments; the log adds a marker line for each
  readonly from: number;
  readonly conn: number;
  readonly error: string | null;
};

// a message this client took back, for the composer to hold again; `key` tells one from the next
export type Restored = { readonly key: number; readonly text: string; readonly media: readonly Asset[] };

export type Session = {
  readonly status: LinkStatus;
  readonly state: SessionState | null;
  readonly log: Log;
  readonly markers: readonly Marker[];
  readonly thinking: boolean;
  readonly pending: readonly Pending[];
  readonly restored: Restored | null;
  // the client ids this page asked the server to take back and has no answer for yet; a reconnect
  // forgets them (an answer told to the old socket is lost), so the take-back can be asked again
  readonly asking: readonly string[];
};

const MAX_MARKERS = 100;
const MAX_ACKED = 1000; // log indexes of acked messages remembered
// what a message sent on a connection that dropped is marked with when the server shows no sign of it
export const UNSENT = "it may not have reached the server: send it again";
const PAGE = 100; // older entries per page
const MAX_FILL = 500; // a wider hole under the window is dropped, not fetched

const initial: Session = { asking: [], log: emptyLog, markers: [], pending: [], restored: null, state: null, status: "connecting", thinking: false };

// One message that waits for the model, and where it stands: "queued", the server holds it for a
// later turn; "sent", a turn has it (offered to the running call, or being logged); "sending", the
// server hasn't shown it yet; "failed", the log refused it or it may never have arrived (`error`).
// `back`: how it can be taken back into the composer: from the server (it is queued there), from
// here (the server doesn't hold it), or not at all (a turn has it).
export type Queued = {
  readonly key: string;
  readonly clientId: string | null;
  readonly text: string;
  readonly media: readonly Asset[];
  readonly error: string | null;
  readonly where: "queued" | "sent" | "sending" | "failed";
  readonly back: "server" | "local" | null;
};

// Is this user entry's text the message sent as `p`? The same text, or with attachments the typed
// text followed by their marker lines (the log adds those, SPEC "Media").
const sameMessage = (entry: string, p: Pending) => {
  if (p.media.length === 0) return entry === p.text;
  const { body, markers } = splitMarkers(entry);
  return markers.length === p.media.length && body === (p.text.trim() === "" ? "" : p.text);
};

// What waits for the model: every message the server holds unlogged, then ours it doesn't hold
// yet. A message of ours the server holds is one entry, told by its client id, not its text: the
// server's copy stands for it, with its error if the log refused it.
export function queued(s: Session): Queued[] {
  const ours = new Map(s.pending.map((p) => [p.id, p]));
  const held = new Set<string>();
  const out: Queued[] = [];
  for (const [k, m] of (s.state?.pending ?? []).entries()) {
    const mine = m.clientId === null ? undefined : ours.get(m.clientId);
    if (mine) held.add(mine.id);
    const error = mine?.error ?? null;
    out.push({
      back: m.queued && m.clientId !== null ? "server" : null,
      clientId: m.clientId,
      error,
      key: m.clientId ?? `server ${k}`,
      media: m.media ?? [],
      text: m.text,
      where: error === null ? (m.queued ? "queued" : "sent") : "failed",
    });
  }
  for (const p of s.pending)
    if (!held.has(p.id))
      out.push({ back: p.error === null ? null : "local", clientId: p.id, error: p.error, key: p.id, media: p.media, text: p.text, where: p.error === null ? "sending" : "failed" });
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

export function makeSession(link: Pick<Link, "listen" | "onStatus" | "pick" | "send" | "status" | "takeBack">, options: SessionOptions = {}) {
  const messages = options.messages ?? api.messages;
  // what was sent before a reload and never acked: the snapshots tell below whether it got there
  const kept = loadSent().map((m): Pending => ({ ...m, conn: 0, error: null }));
  let s: Session = { ...initial, pending: kept, status: link.status() };
  let raw: Record<string, Schema.Json> = {};
  let conns = s.status === "open" ? 1 : 0; // the connections opened so far
  let keys = 0;
  let filling = false;
  let atEnd = true; // the reader is at the chat's newest end: what scrolled out of sight may be dropped
  // the log indexes the server acked to any client: those entries are that client's message, so
  // never one of ours matched by its text
  const ackedAt = new Set<number>();
  const subscribers = new Set<() => void>();
  let restores = 0;

  const set = (next: Partial<Session>) => {
    if (next.pending && next.pending !== s.pending) saveSent(next.pending.map(({ from, id, media, text }) => ({ from, id, media, text })));
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
  // A held message left the server's inbox for a client's composer, or could not: ours is no longer
  // pending either way it went to a composer, and the page that asked gets it back.
  const takenBack = (id: string, error: string | null, text: string | null, media: readonly Asset[]) => {
    const mine = s.asking.includes(id);
    const asking = mine ? s.asking.filter((x) => x !== id) : s.asking;
    if (error !== null || text === null) {
      set({ asking });
      if (mine) mark(`couldn't take it back: ${error ?? "no such message"}`, "info");
      return;
    }
    const pending = s.pending.filter((p) => p.id !== id);
    set(mine ? { asking, pending, restored: { key: ++restores, media, text } } : { pending });
  };
  // A user entry was logged without an ack for us: one a failed ack told of earlier, or one sent on
  // a connection that has dropped since (its ack, told to nobody, is lost). Only these are matched
  // by their text, on the entry's index, as the oldest of them it can be, and never on an index
  // whose ack named another message.
  const logged = (i: number, text: string) => {
    if (ackedAt.has(i)) return;
    const at = s.pending.findIndex((p) => (p.error !== null || p.conn < conns) && sameMessage(text, p) && i >= p.from);
    if (at !== -1) set({ pending: s.pending.toSpliced(at, 1) });
  };
  // After a reconnect: a message sent on a connection that dropped, which the log doesn't hold and
  // the server doesn't hold either (its id is not among the state's pending), may have been lost
  // with the socket. It is marked so, and stays in the queue; the log taking it later clears it as
  // above.
  // One sent before the window this page holds (the log grew past it meanwhile) can't be told
  // from the entries it doesn't see: it is dropped, neither marked nor offered to send again.
  const unsent = () => {
    const there = new Set((s.state?.pending ?? []).map((m) => m.clientId));
    const known = s.pending.filter((p) => p.conn >= conns || p.error !== null || there.has(p.id) || p.from >= lowest(s.log));
    const marked = known.map((p) => (p.conn >= conns || p.error !== null || there.has(p.id) ? p : { ...p, error: UNSENT }));
    if (marked.length !== s.pending.length || marked.some((p, k) => p !== s.pending[k])) set({ pending: marked });
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
        // a turn that stopped for a pick says why in its own prompt, not here as well
        if (s.state?.phase !== "needs-model") mark(e.message, "error");
        return;
      case EventType.CUSTOM:
        if (e.name === "info") mark(e.value, "info");
        else if (e.name === "thinking") set({ thinking: true });
        else if (e.name === "ack") acked(e.value.clientId, e.value.error, e.value.messageId === null ? null : logIndex(e.value.messageId));
        else if (e.name === "taken-back") takenBack(e.value.clientId, e.value.error, e.value.text, e.value.media);
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
    set(status === "open" ? { asking: [], status } : { status, thinking: false });
  });

  return {
    get: () => s,
    subscribe: (f: () => void) => {
      subscribers.add(f);
      return () => {
        subscribers.delete(f);
      };
    },
    // a message from the composer, with the attachments it uploaded: shown as queued until its
    // ack. Sent while the link is down, it goes out on the next connection. `followUp`: when it
    // asks for the other behavior than the session's ("send now" or "queue")
    send: (text: string, device: string | null, media: readonly Asset[] = [], followUp?: FollowUp) => {
      const id = crypto.randomUUID();
      const conn = s.status === "open" ? conns : conns + 1;
      set({ pending: [...s.pending, { conn, error: null, from: s.state?.messages ?? 0, id, media, text }] });
      link.send(text, device, id, media.map(refOf), followUp);
    },
    // A waiting message back into the composer: one the server holds is asked for (it answers
    // with "taken-back"); one it doesn't hold is ours alone, and comes back at once. False when it
    // can't be taken back now (a turn has it, or the link is down).
    takeBack: (q: Queued) => {
      if (q.back === "local" && q.clientId !== null) {
        set({ pending: s.pending.filter((p) => p.id !== q.clientId), restored: { key: ++restores, media: q.media, text: q.text } });
        return true;
      }
      if (q.back !== "server" || q.clientId === null || !link.takeBack(q.clientId)) return false;
      set({ asking: [...s.asking, q.clientId] });
      return true;
    },
    // A model pick: only while connected (a pick kept for later would settle whatever turn waits
    // after the reconnect, which the user never chose); said when it wasn't sent.
    pick: (lead: string) => {
      if (link.pick(lead)) return true;
      mark("not connected: the model was not changed", "error");
      return false;
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
