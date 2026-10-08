// openChat: one writer's whole chat. It holds the lock, owns the memory and runs the pump until
// its scope closes.
import { Console, Effect, Semaphore } from "effect";
import { type Commit, makePump, type PumpOptions } from "./compactor.ts";
import type { Kind } from "./records.ts";
import { appendMessage, appendNode, loadChat, lock, newMsg, saveView, type StoreError } from "./store.ts";
import type { Entry, Marks, Mem } from "./tree.ts";
import { addMessage, addNode } from "./view.ts";

export type Chat = {
  readonly dir: string;
  readonly mem: Mem;
  readonly problems: readonly string[];
  // docs/optchat.md §1: a message reaches the disk (written and synced) before anything else happens to it;
  // only then is the compactor given the chance to start on it
  readonly kick: Effect.Effect<void, StoreError>;
  readonly log: (kind: Kind, body: string, extra?: { readonly device?: string }) => Effect.Effect<Entry, StoreError>;
};

// The pump's commit: a node is on disk (fsynced) before memory knows it, so the view never
// leans on a summary a crash could lose. The view's lines change only when a message arrives.
export function committer(dir: string, mem: Mem): Commit {
  return (n) =>
    appendNode(dir, n).pipe(
      Effect.map(() => {
        addNode(mem, n);
      }),
    );
}

export const openChat = Effect.fn("openChat")(function* (dir: string, o: PumpOptions & { readonly marks?: Marks }) {
  yield* lock(dir);
  const { mem, problems } = yield* loadChat(dir, { marks: o.marks });
  const report = o.report ?? ((line: string) => Console.error(line));
  const commit = committer(dir, mem);
  const pump = yield* makePump({ ...o, commit, mem });
  // one message stored at a time, so two concurrent logs never take the same id
  const storing = yield* Semaphore.make(1);
  const store = (kind: Kind, body: string, extra: { readonly device?: string }) =>
    Effect.suspend(() => {
      const id = mem.root.length;
      const entry = { ...newMsg(id, kind, body), ...extra };
      // the log line first, then the view it changed (saved whole): a crash in between leaves a
      // view one message behind the log, which the next load catches up (view.ts restore). The
      // message is logged either way, so a view that cannot be saved is reported, not returned.
      return appendMessage(dir, entry).pipe(
        Effect.andThen(() => {
          addMessage(mem, entry);
          return saveView(dir, mem).pipe(Effect.catch((error) => report(error.message)));
        }),
        Effect.as(entry),
      );
    });
  // once the message is stored, logging it has succeeded: a pump that cannot start is reported
  const log: Chat["log"] = (kind, body, extra = {}) =>
    storing.withPermit(store(kind, body, extra)).pipe(Effect.tap(() => pump.nudge));
  // at startup there may be work already: free nodes to build, nodes an earlier run never finished
  yield* pump.kick;
  return { dir, kick: pump.kick, log, mem, problems } satisfies Chat;
});
