// The session as this client sees it (SPEC "Web UI", Chat): the server's state (phase, device,
// view size, queued mid-run messages), status markers from CUSTOM info and RUN_ERROR, whether the
// model is thinking, and the messages sent from here that the log doesn't hold yet. The messages
// themselves are useChat's; this is everything else the AG-UI events carry.
import { EventType } from "@ag-ui/core";
import { Option, type Schema } from "effect";
import type { Link, LinkStatus } from "./connection.ts";
import { type Inbound, parseState, type SessionState } from "./protocol.ts";

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
  readonly markers: readonly Marker[];
  readonly thinking: boolean;
  readonly pending: readonly Pending[];
};

const MAX_MARKERS = 100;

export const initial: Session = { markers: [], pending: [], state: null, status: "connecting", thinking: false };

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

export function makeSession(link: Pick<Link, "listen" | "onStatus" | "send" | "status">) {
  let s: Session = { ...initial, status: link.status() };
  let raw: Record<string, Schema.Json> = {};
  let lastIndex = -1; // the newest log entry seen
  let keys = 0;
  const users = new Set<string>(); // ids of user messages being logged
  const subscribers = new Set<() => void>();

  const set = (next: Partial<Session>) => {
    s = { ...s, ...next };
    for (const f of subscribers) f();
  };
  const seen = (id: string) => {
    const i = Number(id);
    if (Number.isInteger(i)) lastIndex = Math.max(lastIndex, i);
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
  const logged = (id: string, text: string) => {
    const i = Number(id);
    const at = s.pending.findIndex((p) => p.text === text && i >= p.from);
    if (at !== -1) set({ pending: s.pending.toSpliced(at, 1) });
  };

  const event = (e: Inbound) => {
    switch (e.type) {
      case EventType.MESSAGES_SNAPSHOT: {
        users.clear();
        lastIndex = -1;
        for (const m of e.messages) seen(m.id);
        for (const m of e.messages) if (m.role === "user") logged(m.id, m.content);
        set({ thinking: false });
        return;
      }
      case EventType.STATE_SNAPSHOT:
        applyState({ ...e.snapshot });
        return;
      case EventType.STATE_DELTA: {
        const next = { ...raw };
        for (const op of e.delta) next[op.path.slice(1)] = op.value;
        applyState(next);
        return;
      }
      case EventType.TEXT_MESSAGE_START:
        seen(e.messageId);
        if (e.role === "user") users.add(e.messageId);
        return;
      case EventType.TEXT_MESSAGE_CONTENT:
        if (users.has(e.messageId)) logged(e.messageId, e.delta);
        else if (s.thinking) set({ thinking: false });
        return;
      case EventType.TEXT_MESSAGE_END:
        users.delete(e.messageId);
        return;
      case EventType.TOOL_CALL_START:
        if (e.parentMessageId !== undefined) seen(e.parentMessageId);
        if (s.thinking) set({ thinking: false });
        return;
      case EventType.TOOL_CALL_RESULT:
        seen(e.messageId);
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
      case EventType.TOOL_CALL_ARGS:
      case EventType.TOOL_CALL_END:
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
    dispose: () => {
      unlisten();
      unstatus();
    },
  };
}
export type SessionStore = ReturnType<typeof makeSession>;
