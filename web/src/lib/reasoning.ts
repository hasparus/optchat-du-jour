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
  // its text could not be read
  readonly failed: boolean;
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
      return set(thoughts, { cut: 0, failed: false, i, live: true, ms: null, since: now, text: "" });
    }
    case EventType.REASONING_MESSAGE_CONTENT: {
      const i = reasoningIndex(e.messageId);
      if (i === null) return thoughts;
      const t = thoughts.get(i);
      // content without its start (a page that joined mid-thought): a piece from here on
      if (t?.live !== true) return set(thoughts, { cut: 0, failed: false, i, live: true, ms: null, since: now, text: e.delta });
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
  for (const h of fresh) next.set(h.i, { cut: h.cut ?? 0, failed: false, i: h.i, live: false, ms: h.ms, since: null, text: null });
  return next;
}

// One piece's text, read when the reader opened it; null: it couldn't be read
export function withText(thoughts: Thoughts, i: number, piece: ReasoningPiece | null): Thoughts {
  const t = thoughts.get(i);
  if (t === undefined || t.text !== null) return thoughts;
  return set(thoughts, piece === null ? { ...t, failed: true } : { ...t, cut: piece.cut ?? 0, failed: false, ms: piece.ms, text: piece.text });
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
