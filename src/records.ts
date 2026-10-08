// What the data dir holds (docs/optchat.md §1): one message per line of chat/main, one node per line of
// chat/tree. The reference reads and writes the same records, so either can open the other's
// data dir.
import { Schema } from "effect";

export const Kind = Schema.Literals(["user", "talk", "tool", "echo", "note"]);
export type Kind = typeof Kind.Type;

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

// `size` is written but never trusted: the loader recomputes it from the text. `device` says
// where the turn that logged the entry ran (E7); readers that don't know it ignore it.
export const Msg = Schema.Struct({
  date: Schema.String,
  device: Schema.optional(Schema.String),
  i: Index,
  kind: Kind,
  size: Schema.optional(Schema.Number),
  text: Schema.String,
});
export type Msg = typeof Msg.Type;

export const Node = Schema.Struct({ i: Index, l: Index, size: Schema.optional(Schema.Number), text: Schema.String });
export type Node = typeof Node.Type;
