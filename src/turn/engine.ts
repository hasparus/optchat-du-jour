// What a turn engine is given and what it reports (SPEC "Engines"): the view and the new texts in,
// log entries and live events out. Mid-run messages arrive on `steer`; the engine says which it
// took, and the session decides what becomes of the rest. When the chain fails over in the
// middle of a turn, the next engine gets the same input: what the first one logged is in
// `earlier`, and the mid-run messages it never took are still untaken in `sent` or the queue.
import type { Effect, Queue } from "effect";
import type { EngineError } from "../engines/errors.ts";
import type { Kind } from "../records.ts";
import type { StoreError } from "../store.ts";
import type { UsageRecord } from "../usage.ts";

export type Sent = { readonly text: string; taken: boolean };
export type Logged = { readonly kind: Kind; readonly text: string };

export type TurnInput = {
  readonly view: string;
  readonly texts: readonly string[];
  readonly device: string;
  // messages the user sends while the turn runs; the engine appends each to `sent` as it passes it on
  readonly steer: Queue.Queue<string>;
  readonly sent: Sent[];
  // what this turn's engines logged so far, in order; the session appends, an engine reads
  readonly earlier: Logged[];
};

// The opening message's own text: the new texts, and after a failover mid-turn what the engine
// before logged, so the next one carries on from there instead of starting again.
export const opening = (input: Pick<TurnInput, "earlier" | "texts">) => {
  const asked = input.texts.join("\n\n");
  if (input.earlier.length === 0) return asked;
  const done = input.earlier.map((e) => `${e.kind}: ${e.text}`).join("\n");
  return `${asked}\n\n[optchat: another engine began this turn and stopped before it finished (usage limit or device offline). What it did is below and is already in the log; continue from there and do not repeat it.]\n${done}`;
};

export type TurnEvents = {
  readonly log: (kind: Kind, text: string) => Effect.Effect<void, StoreError>;
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
};
