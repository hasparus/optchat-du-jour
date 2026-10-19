// What the data dir holds (docs/optchat.md §1): one message per line of chat/main, one node per line of
// chat/tree. The reference reads and writes the same records, so either can open the other's
// data dir.
import { Schema } from "effect";

export const Kind = Schema.Literals(["user", "talk", "tool", "echo", "note"]);
export type Kind = typeof Kind.Type;

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

// `size` is written but never trusted: the loader recomputes it from the text. `device` says
// where the turn that logged the entry ran (E7); `error`, on an echo only, that the tool reported
// it failed (E28: Claude Code's `is_error`, or our own tool loop's), written only when true, so a
// line without it reads as before. Both are for clients: no model is shown either, and readers that
// don't know them ignore them.
export const Msg = Schema.Struct({
  date: Schema.String,
  device: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Boolean),
  i: Index,
  kind: Kind,
  size: Schema.optional(Schema.Number),
  text: Schema.String,
});
export type Msg = typeof Msg.Type;

// `clipped`: the node is its source cut to fit, not a summary, because the model refused it or
// gave no line (E31); written only when true, so every other line is the reference's, and a later
// pass can find and rebuild these.
export const Node = Schema.Struct({ clipped: Schema.optional(Schema.Boolean), i: Index, l: Index, size: Schema.optional(Schema.Number), text: Schema.String });
export type Node = typeof Node.Type;
