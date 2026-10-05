// openChat: one writer's whole chat. It holds the lock, owns the memory and runs the pump until
// its scope closes.
import { Effect, Semaphore } from "effect";
import { type Commit, makePump, type PumpOptions } from "./compactor.ts";
import type { Kind } from "./records.ts";
import { appendMessage, appendNode, loadChat, lock, newMsg, type StoreError } from "./store.ts";
import type { Entry, Mem } from "./tree.ts";
import { addMessage, addNode } from "./view.ts";

export type Chat = {
  readonly dir: string;
  readonly mem: Mem;
  readonly problems: readonly string[];
  // gist §7: a message reaches the disk (written and synced) before anything else happens to it;
  // only then is the compactor given the chance to start on it
  readonly kick: Effect.Effect<void, StoreError>;
  readonly log: (kind: Kind, body: string, extra?: { readonly device?: string }) => Effect.Effect<Entry, StoreError>;
};

// The pump's commit: a node is on disk (fsynced) before memory knows it, so the view never
// leans on a summary a crash could lose. addNode refits the view.
export function committer(dir: string, mem: Mem): Commit {
  return (n) =>
    appendNode(dir, n).pipe(
      Effect.map(() => {
        addNode(mem, n);
      }),
    );
}

export const openChat = Effect.fn("openChat")(function* (dir: string, o: PumpOptions & { readonly budget?: number }) {
  yield* lock(dir);
  const { mem, problems } = yield* loadChat(dir, { budget: o.budget });
  const commit = committer(dir, mem);
  const pump = yield* makePump({ ...o, commit, mem });
  // one message stored at a time, so two concurrent logs never take the same id
  const storing = yield* Semaphore.make(1);
  const store = (kind: Kind, body: string, extra: { readonly device?: string }) =>
    Effect.suspend(() => {
      const id = mem.root.length;
      const entry = { ...newMsg(id, kind, body), ...extra };
      return appendMessage(dir, entry).pipe(
        Effect.map(() => {
          addMessage(mem, entry);
          return entry;
        }),
      );
    });
  // once the message is stored, logging it has succeeded: a pump that cannot start is reported
  const log: Chat["log"] = (kind, body, extra = {}) =>
    storing.withPermit(store(kind, body, extra)).pipe(Effect.tap(() => pump.nudge));
  // at startup there may be work already: free nodes to build, nodes an earlier run never finished
  yield* pump.kick;
  return { dir, kick: pump.kick, log, mem, problems } satisfies Chat;
});
