// Every client action is done once (E41, SPEC "Protocol"). A client gives each action an id of its
// own and keeps it until the server says it got it (CUSTOM `received`), sending what it still keeps
// again, in order, on every socket that opens; the server answers an id it has seen again without
// doing it again. Which ids it has seen: for a message, what the session holds (its inbox, the log's
// `client` keys, the ids taken back), so a message is never logged twice, also after a restart; for
// any other action, the newest ACTS ids in memory.
import type { Incoming } from "./inbox.ts";
import type { Received } from "./wire.ts";

// What a message's id names. `new`: never seen, taken now. A repeat: still `held` in the inbox,
// `logged` as entry `at`, or `taken-back` by a client and never logged. `refused`: never seen,
// and not taken, since it has nothing to send (`why`); not remembered, so one sent again is
// looked at again.
export type Receipt =
  | { readonly type: "new" }
  | { readonly type: "refused"; readonly why: string }
  | { readonly type: "held" }
  | { readonly type: "logged"; readonly at: number }
  | { readonly type: "taken-back" };

// The newest `max` ids seen, in the order they came; past `max` the oldest is forgotten
export const makeSeen = (max: number) => {
  const ids = new Set<string>();
  return {
    has: (id: string) => ids.has(id),
    // false when it was seen already: then it is kept where it was
    add: (id: string) => {
      if (ids.has(id)) return false;
      ids.add(id);
      for (const old of ids) {
        if (ids.size <= max) break;
        ids.delete(old);
      }
      return true;
    },
    size: () => ids.size,
  };
};
export type Seen = ReturnType<typeof makeSeen>;

// A message id the session has seen, or null. The inbox comes first: a message leaves it only once
// it is in the log, so one being logged now is in one or the other. `logged` is the log's own index
// of its `client` keys (src/tree.ts Mem.clients), rebuilt from the log at every load.
export const receiptOf = (id: string, o: { readonly inbox: readonly Incoming[]; readonly logged: ReadonlyMap<string, number>; readonly taken: Seen }): Receipt | null => {
  if (o.inbox.some((m) => m.clientId === id)) return { type: "held" };
  const at = o.logged.get(id);
  if (at !== undefined) return { at, type: "logged" };
  return o.taken.has(id) ? { type: "taken-back" } : null;
};

// a message's receipt as its client is told it (src/wire.ts Received)
export const receivedOf = (id: string, r: Receipt): Received => {
  switch (r.type) {
    case "new":
      return { id, messageId: null, outcome: "taken" };
    case "refused":
      return { error: r.why, id, messageId: null, outcome: "refused" };
    case "logged":
      return { id, messageId: String(r.at), outcome: "logged" };
    case "held":
    case "taken-back":
      return { id, messageId: null, outcome: r.type };
  }
};
