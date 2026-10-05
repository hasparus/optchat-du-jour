// The log as this client holds it (SPEC "Protocol": the log is the source of truth, a client's
// state only a view of it). Entries are kept by log index, which is also their message id on the
// wire, plus at most one draft: the reply text or tool call streaming in now. Snapshots, live
// events and /api/messages pages all land in the same map, so an entry keeps its index (and its
// row its key) however it arrived. Pure: the session store (session.ts) does the fetching.
import { type Kind, joinTool, logIndex } from "@wire";
import { EventType } from "@ag-ui/core";
import type { Inbound, Message } from "./protocol.ts";

export type Item = {
  readonly i: number;
  readonly kind: Kind;
  readonly text: string;
  // told by a live event rather than read from a snapshot or a page. Trusted while the snapshot
  // window holds it; once a newer snapshot starts above it, it is read again from the log
  readonly live: boolean;
};

export type Draft =
  | { readonly kind: "user" | "talk"; readonly i: number; readonly text: string }
  | { readonly kind: "tool"; readonly i: number; readonly call: string; readonly name: string; readonly args: string };

export type Log = {
  readonly items: ReadonlyMap<number, Item>;
  // the first index of the last snapshot's window: from here up, the snapshot and the live events
  // after it; below it, older pages, shown only as far down as they reach without a hole
  readonly base: number;
  readonly draft: Draft | null;
};

export const emptyLog: Log = { base: 0, draft: null, items: new Map() };

// a snapshot message as a log entry (server/agui.ts toMessages, read backwards)
function fromMessage(m: Message): Item | null {
  const i = logIndex(m.id);
  if (i === null) return null;
  switch (m.role) {
    case "user":
      return { i, kind: m.name === "note" ? "note" : "user", live: false, text: m.content };
    case "assistant": {
      const call = m.toolCalls?.[0];
      return call
        ? { i, kind: "tool", live: false, text: joinTool(call.function.name, call.function.arguments) }
        : { i, kind: "talk", live: false, text: m.content ?? "" };
    }
    case "tool":
      return { i, kind: "echo", live: false, text: m.content };
  }
}

// A snapshot is the log's last window: it replaces everything from its first index up, and the
// draft (a reconnect or the end of a run; what was streaming is in the log now, or never will be).
// Older pages below it stay, except entries only live events told of: those are read again.
export function applySnapshot(log: Log, messages: readonly Message[]): Log {
  const fresh = messages.flatMap((m) => fromMessage(m) ?? []);
  const base = fresh[0]?.i ?? 0;
  const items = new Map<number, Item>();
  if (fresh.length > 0) for (const [i, item] of log.items) if (i < base && !item.live) items.set(i, item);
  for (const item of fresh) items.set(item.i, item);
  return { base, draft: null, items };
}

// A page of /api/messages is a stretch of the log as it is: it replaces what this client held for
// that stretch, and a draft the page already holds as an entry.
export function applyPage(log: Log, entries: readonly { readonly i: number; readonly kind: Kind; readonly text: string }[]): Log {
  const first = entries[0]?.i;
  const last = entries.at(-1)?.i;
  if (first === undefined || last === undefined) return log;
  const items = new Map<number, Item>();
  for (const [i, item] of log.items) if (i < first || i > last) items.set(i, item);
  for (const e of entries) items.set(e.i, { i: e.i, kind: e.kind, live: false, text: e.text });
  return { ...log, draft: log.draft && log.draft.i <= last ? null : log.draft, items };
}

const put = (log: Log, item: Item, draft: Draft | null = log.draft): Log => ({ ...log, draft, items: new Map(log.items).set(item.i, item) });

const draftItem = (d: Draft): Item =>
  d.kind === "tool" ? { i: d.i, kind: "tool", live: true, text: joinTool(d.name, d.args) } : { i: d.i, kind: d.kind, live: true, text: d.text };

// A live event. The server closes a reply's text before anything else is logged and before the run
// ends, so a draft still open when another message starts, or when the run ends, was never logged
// (an older server cancelled without closing it): it is dropped, not kept as an entry the log lacks.
export function applyEvent(log: Log, e: Inbound): Log {
  switch (e.type) {
    case EventType.MESSAGES_SNAPSHOT:
      return applySnapshot(log, e.messages);
    case EventType.TEXT_MESSAGE_START: {
      const i = logIndex(e.messageId);
      if (i === null) return log;
      return { ...log, draft: { i, kind: e.role === "user" ? "user" : "talk", text: "" } };
    }
    case EventType.TEXT_MESSAGE_CONTENT: {
      const i = logIndex(e.messageId);
      if (i === null) return log;
      const d = log.draft;
      // content without its start (a page that joined mid-reply): a reply from here on
      if (d?.i !== i || d.kind === "tool") return { ...log, draft: { i, kind: "talk", text: e.delta } };
      return { ...log, draft: { ...d, text: d.text + e.delta } };
    }
    case EventType.TEXT_MESSAGE_END: {
      const d = log.draft;
      if (d?.i !== logIndex(e.messageId) || d.kind === "tool") return log;
      return put(log, draftItem(d), null);
    }
    case EventType.TOOL_CALL_START: {
      const i = logIndex(e.parentMessageId ?? e.toolCallId);
      if (i === null) return log;
      return { ...log, draft: { args: "", call: e.toolCallId, i, kind: "tool", name: e.toolCallName } };
    }
    case EventType.TOOL_CALL_ARGS: {
      const d = log.draft;
      if (d?.kind !== "tool" || d.call !== e.toolCallId) return log;
      return { ...log, draft: { ...d, args: d.args + e.delta } };
    }
    case EventType.TOOL_CALL_END: {
      const d = log.draft;
      if (d?.kind !== "tool" || d.call !== e.toolCallId) return log;
      return put(log, draftItem(d), null);
    }
    case EventType.TOOL_CALL_RESULT: {
      const i = logIndex(e.messageId);
      if (i === null) return log;
      return put(log, { i, kind: "echo", live: true, text: e.content }, null);
    }
    case EventType.RUN_FINISHED:
    case EventType.RUN_ERROR:
      return log.draft ? { ...log, draft: null } : log;
    case EventType.STATE_SNAPSHOT:
    case EventType.STATE_DELTA:
    case EventType.RUN_STARTED:
    case EventType.CUSTOM:
      return log;
  }
}

// the lowest index shown: the window's start, or lower while older entries reach it without a hole
export function lowest(log: Pick<Log, "base" | "items">): number {
  let low = log.base;
  while (low > 0 && log.items.has(low - 1)) low--;
  return low;
}

// the entries shown, oldest first: from lowest(log) up
export const visible = (log: Pick<Log, "base" | "items">): Item[] => {
  const low = lowest(log);
  return [...log.items.values()].filter((item) => item.i >= low).toSorted((a, b) => a.i - b.i);
};

// the draft as an entry, for showing it after the entries (or in place of the one it rewrites)
export const withDraft = (items: readonly Item[], draft: Draft | null): Item[] => {
  if (!draft) return [...items];
  const d = draftItem(draft);
  return [...items.filter((item) => item.i !== d.i), d].toSorted((a, b) => a.i - b.i);
};

// Older entries this client holds but can't show, because a hole lies between them and the window
// (the window moved up while this page slept): the page that fills the hole, or null.
export function hole(log: Log): { readonly before: number; readonly limit: number } | null {
  const low = lowest(log);
  let below = -1;
  for (const i of log.items.keys()) if (i < low && i > below) below = i;
  return below === -1 ? null : { before: low, limit: low - below - 1 };
}

// forget the older entries a hole cuts off (one too wide to fetch)
export function dropBelow(log: Log, index: number): Log {
  return { ...log, items: new Map([...log.items].filter(([i]) => i >= index)) };
}
