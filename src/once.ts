// Every client action is done once (E41, SPEC "Protocol"). A client gives each action an id of its
// own and keeps it until the server says it got it (CUSTOM `received`), sending what it still keeps
// again, in order, on every socket that opens; the server answers an id it has seen again without
// doing it again. Which ids it has seen: for a message, what the session holds (its inbox, the log's
// `client` keys, the ids taken back), so a message is never logged twice, also after a restart; for
// any other action, the newest ACTS ids in memory.
import type { Incoming } from "./inbox.ts";
import type { Entry } from "./tree.ts";
import type { Received } from "./wire.ts";

// What a message's id names. `new`: never seen, taken now. A repeat: still `held` in the inbox,
// `logged` as entry `at`, or `taken-back` by a client and never logged.
export type Receipt =
  | { readonly type: "new" }
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
// it is in the log, so one being logged now is in one or the other. The log is read from its newest
// entry down, all of it: the ids live there, not in memory. A new message reads it whole, once
// (test/once.test.ts holds that under 5 ms against 100,000 entries).
export const receiptOf = (id: string, o: { readonly inbox: readonly Incoming[]; readonly log: readonly Entry[]; readonly taken: Seen }): Receipt | null => {
  if (o.inbox.some((m) => m.clientId === id)) return { type: "held" };
  for (let k = o.log.length - 1; k >= 0; k--) {
    const e = o.log[k];
    if (e?.client === id && e.kind === "user") return { at: e.i, type: "logged" };
  }
  return o.taken.has(id) ? { type: "taken-back" } : null;
};

// a message's receipt as its client is told it (src/wire.ts Received)
export const receivedOf = (id: string, r: Receipt): Received => ({ id, messageId: r.type === "logged" ? String(r.at) : null, outcome: r.type === "new" ? "taken" : r.type });
