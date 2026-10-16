// A turn's thinking as this client holds it (SPEC "Reasoning"), by the log index of the reply or
// tool call it came before. Live, from the server's REASONING_* events: a piece streams under the
// index its entry is expected at, and REASONING_END says where it was kept (or that it was
// dropped, when nothing the turn logged came after it). After a reload, from /api/reasoning: the
// pieces of the rows a page holds, without their text, which is read when the reader opens one.
// Pure: the session store (session.ts) does the fetching. Never part of the log (./log.ts).
import { EventType } from "@ag-ui/core";
import { type ReasoningHead, type ReasoningPiece, reasoningIndex } from "@wire";
import type { Inbound } from "./protocol.ts";

export type Thought = {
  readonly i: number;
  // the text; null until it is read (a head from /api/reasoning carries none)
  readonly text: string | null;
  // how long it ran, as the server measured it; null while it streams
  readonly ms: number | null;
  // characters past the caps that were left out (never sent)
  readonly cut: number;
  // streaming now; `since` is when this page saw it begin (its own clock), for the live label
  readonly live: boolean;
  readonly since: number | null;
  // whether the reader has its line open (this page only); carried with it when it moves
  readonly open: boolean;
  // its text could not be read: the server has none for it ("missing", for good), or the read
  // failed ("error": opening it again tries again)
  readonly failed: "missing" | "error" | null;
};
export type Thoughts = ReadonlyMap<number, Thought>;
export const noThoughts: Thoughts = new Map();

const set = (thoughts: Thoughts, t: Thought): Thoughts => new Map(thoughts).set(t.i, t);
const without = (thoughts: Thoughts, i: number): Thoughts => {
  if (!thoughts.has(i)) return thoughts;
  const next = new Map(thoughts);
  next.delete(i);
  return next;
};

// A REASONING_* event; any other event leaves them as they are. `now`: this page's clock.
export function applyThought(thoughts: Thoughts, e: Inbound, now: number): Thoughts {
  switch (e.type) {
    case EventType.REASONING_START:
    case EventType.REASONING_MESSAGE_START: {
      const i = reasoningIndex(e.messageId);
      if (i === null || thoughts.get(i)?.live === true) return thoughts;
      return set(thoughts, { cut: 0, failed: null, i, live: true, ms: null, open: false, since: now, text: "" });
    }
    case EventType.REASONING_MESSAGE_CONTENT: {
      const i = reasoningIndex(e.messageId);
      if (i === null) return thoughts;
      const t = thoughts.get(i);
      // content without its start (a page that joined mid-thought): a piece from here on
      if (t?.live !== true) return set(thoughts, { cut: 0, failed: null, i, live: true, ms: null, open: false, since: now, text: e.delta });
      return set(thoughts, { ...t, text: (t.text ?? "") + e.delta });
    }
    case EventType.REASONING_END: {
      const at = reasoningIndex(e.messageId);
      if (at === null) return thoughts;
      const t = thoughts.get(at);
      const kept = e.metadata?.i;
      if (e.metadata?.dropped === true || kept === undefined || t === undefined) return t?.live === true ? without(thoughts, at) : thoughts;
      const done: Thought = { ...t, cut: e.metadata?.cut ?? 0, i: kept, live: false, ms: e.metadata?.ms ?? null, since: null };
      return set(kept === at ? thoughts : without(thoughts, at), done);
    }
    case EventType.REASONING_MESSAGE_END: // the END after it says where it went
    case EventType.TEXT_MESSAGE_START:
    case EventType.TEXT_MESSAGE_CONTENT:
    case EventType.TEXT_MESSAGE_END:
    case EventType.TOOL_CALL_START:
    case EventType.TOOL_CALL_ARGS:
    case EventType.TOOL_CALL_END:
    case EventType.TOOL_CALL_RESULT:
    case EventType.STATE_SNAPSHOT:
    case EventType.STATE_DELTA:
    case EventType.MESSAGES_SNAPSHOT:
    case EventType.CUSTOM:
    case EventType.RUN_STARTED:
    case EventType.RUN_FINISHED:
    case EventType.RUN_ERROR:
    case EventType.SUBAGENT_STARTED:
    case EventType.SUBAGENT_FINISHED:
    case EventType.SUBAGENT_ERROR:
      return thoughts;
  }
}

// The run ended, or the link dropped: a piece still streaming came before nothing logged
export function dropLive(thoughts: Thoughts): Thoughts {
  if (![...thoughts.values()].some((t) => t.live)) return thoughts;
  return new Map([...thoughts].filter(([, t]) => !t.live));
}

// What /api/reasoning says of a range: a piece this page holds already (live, or read) stays as it is
export function withHeads(thoughts: Thoughts, heads: readonly ReasoningHead[]): Thoughts {
  const fresh = heads.filter((h) => !thoughts.has(h.i));
  if (fresh.length === 0) return thoughts;
  const next = new Map(thoughts);
  for (const h of fresh) next.set(h.i, { cut: h.cut ?? 0, failed: null, i: h.i, live: false, ms: h.ms, open: false, since: null, text: null });
  return next;
}

// One piece's text, read when the reader opened it: the piece, or why there is none
export function withText(thoughts: Thoughts, i: number, piece: ReasoningPiece | "missing" | "error"): Thoughts {
  const t = thoughts.get(i);
  if (t === undefined || t.text !== null) return thoughts;
  return set(thoughts, piece === "missing" || piece === "error" ? { ...t, failed: piece } : { ...t, cut: piece.cut ?? 0, failed: null, ms: piece.ms, text: piece.text });
}

// The reader opened or closed the line of the piece before entry i. Whether its text is to be
// read now: opened, none held, and not known to be missing (a failed read is tried again).
export type Toggled = { readonly thoughts: Thoughts; readonly read: boolean };
export function toggled(thoughts: Thoughts, i: number, open: boolean): Toggled {
  const t = thoughts.get(i);
  if (t === undefined) return { read: false, thoughts };
  const read = open && t.text === null && t.failed !== "missing";
  return { read, thoughts: set(thoughts, { ...t, failed: read ? null : t.failed, open }) };
}

// only the pieces of the rows a page holds: those below `low` go with their rows
export function keepFrom(thoughts: Thoughts, low: number): Thoughts {
  if (![...thoughts.keys()].some((i) => i < low)) return thoughts;
  return new Map([...thoughts].filter(([i, t]) => i >= low || t.live));
}

// "Thought for 12 s", or "Reasoning" when it took less than a second or the time isn't known
export function thoughtLabel(t: Pick<Thought, "live" | "ms">): string {
  if (t.live) return "Thinking";
  if (t.ms === null || t.ms < 1000) return "Reasoning";
  const s = Math.round(t.ms / 1000);
  return s < 60 ? `Thought for ${s} s` : `Thought for ${Math.floor(s / 60)} min ${s % 60} s`;
}
