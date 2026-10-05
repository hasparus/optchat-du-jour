// The session as this client sees it (SPEC "Web UI", Chat; "Protocol"): the log (log.ts: entries
// by log index and the reply streaming in), the server's state (phase, device, view size, queued
// mid-run messages), status markers from CUSTOM info and RUN_ERROR, whether the model is thinking,
// and the messages sent from here that the log doesn't hold yet. Every AG-UI event and every page of
// /api/messages comes through here; the screens only draw it.
import { type Kind, SessionState } from "@wire";
import { EventType } from "@ag-ui/core";
import { Option, Schema } from "effect";
import { api } from "./api.ts";
import type { Link, LinkStatus } from "./connection.ts";
import { applyEvent, applyPage, dropBelow, emptyLog, hole, type Log, lowest } from "./log.ts";
import type { Inbound, Patch } from "./protocol.ts";

export type Marker = {
  readonly key: number;
  readonly after: number; // shown after the log entry with this index (-1: before all)
  readonly text: string;
  readonly tone: "info" | "error";
};

// sent from here; `from` is the log's length then, so its entry has an index at least that
export type Pending = { readonly key: number; readonly text: string; readonly from: number };

export type Session = {
  readonly status: LinkStatus;
  readonly state: SessionState | null;
  readonly log: Log;
  readonly markers: readonly Marker[];
  readonly thinking: boolean;
  readonly pending: readonly Pending[];
};

const MAX_MARKERS = 100;
export const PAGE = 100; // older entries per page
const MAX_FILL = 500; // a wider hole under the window is dropped, not fetched

export const initial: Session = { log: emptyLog, markers: [], pending: [], state: null, status: "connecting", thinking: false };

// what waits for the model: the server's untaken mid-run messages, then ours it hasn't logged
export function queued(s: Session): string[] {
  const out = [...(s.state?.queued ?? [])];
  const left = [...out];
  for (const p of s.pending) {
    const at = left.indexOf(p.text);
    if (at === -1) out.push(p.text);
    else left.splice(at, 1);
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
  let lastIndex = -1; // the newest log entry seen
  let keys = 0;
  let filling = false;
  const subscribers = new Set<() => void>();

  const set = (next: Partial<Session>) => {
    s = { ...s, ...next };
    for (const f of subscribers) f();
  };
  const mark = (text: string, tone: Marker["tone"]) => {
    set({ markers: [...s.markers, { after: lastIndex, key: keys++, text, tone }].slice(-MAX_MARKERS) });
  };
  const applyState = (next: Record<string, Schema.Json>) => {
    raw = next;
    const state = parseState(raw);
    if (Option.isSome(state)) set({ state: state.value });
  };
  // a user entry was logged: the oldest pending message it can be is no longer pending
  const logged = (i: number, text: string) => {
    const at = s.pending.findIndex((p) => p.text === text && i >= p.from);
    if (at !== -1) set({ pending: s.pending.toSpliced(at, 1) });
  };
  const setLog = (log: Log) => {
    if (log === s.log) return;
    let newest = log.draft?.i ?? -1;
    for (const i of log.items.keys()) newest = Math.max(newest, i);
    lastIndex = newest;
    set({ log });
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
    setLog(applyEvent(s.log, e));
    switch (e.type) {
      case EventType.MESSAGES_SNAPSHOT:
        for (const item of s.log.items.values()) if (item.kind === "user" && item.i >= s.log.base) logged(item.i, item.text);
        set({ thinking: false });
        if (hole(s.log)) void fill();
        return;
      case EventType.STATE_SNAPSHOT:
        applyState({ ...e.snapshot });
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
    // a message from the composer: shown as queued until the log has it
    send: (text: string, device: string | null) => {
      set({ pending: [...s.pending, { from: s.state?.messages ?? 0, key: keys++, text }] });
      link.send(text, device);
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
