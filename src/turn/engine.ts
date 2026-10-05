// What a turn engine is given and what it reports (SPEC "Engines"): the view and the new texts in,
// log entries and live events out. Mid-run messages stay the session's until a call takes one:
// they are offered to the running call on `mid`, the call reports each one it passed to the model
// with `took` (the session logs it then), and whatever it was offered and never took goes back to
// the session when the call ends. When a usage limit stopped a turn and it goes on on the engine
// the user picked (E4), that engine gets the same view and texts, what the turn has logged so far
// as `earlier`, and on `mid` the messages the engine before never took, then any new ones.
import type { Effect } from "effect";
import type { EngineError } from "../engines/errors.ts";
import type { Part } from "../media/part.ts";
import type { Kind } from "../records.ts";
import type { StoreError } from "../store.ts";
import type { UsageRecord } from "../usage.ts";

// a message sent while the turn runs, as offered to one call; `seq` is the session's name for it.
// `media`: its attachments' pictures (SPEC "Media"), sent with it and never again
export type Mid = { readonly seq: number; readonly text: string; readonly media: readonly Part[] };
export type Logged = { readonly kind: Kind; readonly text: string };

export type TurnInput = {
  readonly view: string;
  readonly texts: readonly string[];
  // the new messages' attachments as pictures, sent after the view and before the texts; only this
  // turn sees them, later ones only the marker lines in the texts (SPEC "Media")
  readonly media: readonly Part[];
  readonly device: string;
  // the mid-run messages offered to this call, oldest first, each with the captions of its
  // attachments waited for: `next` waits for one, `ready` takes every one there now without
  // waiting for another to arrive
  readonly mid: { readonly next: Effect.Effect<Mid>; readonly ready: Effect.Effect<readonly Mid[]> };
  // what this turn's engines logged before this call, in order (read from the log)
  readonly earlier: readonly Logged[];
  // the call before in this turn, which a usage limit or an offline device stopped, ran on this
  // same engine: the user picked it again (a retry), so the opening's note doesn't say another one
  readonly again?: boolean;
};

// The opening message's own text: the new texts, and after a stop mid-turn what was logged
// before it, so the engine carries on from there instead of starting again; the note says whether
// another engine began the turn or this one did (a retry).
export const openingText = (input: Pick<TurnInput, "again" | "earlier" | "texts">) => {
  const asked = input.texts.join("\n\n");
  if (input.earlier.length === 0) return asked;
  const done = input.earlier.map((e) => `${e.kind}: ${e.text}`).join("\n");
  const who = input.again ? "This turn began earlier and" : "Another engine began this turn and";
  return `${asked}\n\n[optchat: ${who} stopped before it finished (usage limit or device offline). What was done is below and is already in the log; continue from there and do not repeat it.]\n${done}`;
};

export type TurnEvents = {
  readonly log: (kind: Exclude<Kind, "user">, body: string) => Effect.Effect<void, StoreError>;
  // the call passed this mid-run message to the model: it is logged as `user` now, once
  readonly took: (message: Mid) => Effect.Effect<void, StoreError>;
  readonly text: (delta: string) => Effect.Effect<void>; // live reply text, never logged as such
  readonly thinking: (tokens: number) => Effect.Effect<void>; // the size of a thought; its text is never kept
  readonly info: (message: string) => Effect.Effect<void>;
  readonly usage: (record: UsageRecord) => Effect.Effect<void>;
};

export type TurnEngine = {
  readonly ref: string;
  // resolves when the turn has its result; fails if it never got one
  readonly run: (input: TurnInput, out: TurnEvents, failoverFrom: string | null) => Effect.Effect<void, EngineError | StoreError>;
  // writes the view to the prompt cache ahead of a turn on `device`; never fails
  readonly prime?: (view: string, device: string) => Effect.Effect<void>;
  // the session is idle: get ready for the next turn and priming on `device` (E18); never fails.
  // Only claude-code has anything to get ready; the others return at once.
  readonly warm: (device: string) => Effect.Effect<void>;
  // whether it is sent images (SPEC "Media"); one that isn't gets the marker lines and a note
  readonly vision: boolean;
};

// what an engine that is not sent images is told when a message had attachments
export const BLIND =
  "[optchat: this engine is not sent images or video frames; each attachment is known here only by its marker line.]";
