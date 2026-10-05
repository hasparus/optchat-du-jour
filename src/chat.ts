// The running chat: the lock, the memory and the pump, alive for as long as the scope is.
import { type Duration, Effect } from "effect";
import { type Commit, makePump, type Summarize } from "./compactor.ts";
import type { Kind } from "./records.ts";
import { appendMessage, appendNode, loadChat, lock, newMsg, type StoreError } from "./store.ts";
import type { Entry, Mem } from "./tree.ts";
import { addMessage, addNode } from "./view.ts";

export type Chat = {
  readonly dir: string;
  readonly mem: Mem;
  readonly problems: readonly string[];
  // every message is logged and fsynced, then the pump looks for work (gist §7)
  readonly kick: Effect.Effect<void, StoreError>;
  readonly log: (kind: Kind, text: string, extra?: { readonly device?: string }) => Effect.Effect<Entry, StoreError>;
};

// persist a built node, then add it to memory and refit the view
export const committer =
  (dir: string, mem: Mem): Commit =>
  (n) =>
    appendNode(dir, n).pipe(
      Effect.andThen(
        Effect.sync(() => {
          addNode(mem, n);
        }),
      ),
    );

export const openChat = Effect.fn("openChat")(function* (
  dir: string,
  o: {
    readonly budget?: number;
    readonly jobs?: number;
    readonly report?: (message: string) => Effect.Effect<void>;
    readonly retry?: Duration.Input;
    readonly summarize: Summarize;
  },
) {
  yield* lock(dir);
  const { mem, problems } = yield* loadChat(dir, { budget: o.budget });
  const pump = yield* makePump({ commit: committer(dir, mem), jobs: o.jobs, mem, report: o.report, retry: o.retry, summarize: o.summarize });
  const log = (kind: Kind, text: string, extra: { readonly device?: string } = {}) =>
    Effect.gen(function* () {
      const m = { ...newMsg(mem.root.length, kind, text), ...extra };
      yield* appendMessage(dir, m);
      addMessage(mem, m);
      yield* pump.kick;
      return m;
    });
  yield* pump.kick; // catch up: the free nodes and whatever the last run left unbuilt
  return { dir, kick: pump.kick, log, mem, problems } satisfies Chat;
});
