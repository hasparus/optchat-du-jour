// The compactor's scheduler (docs/optchat.md §4 "The order"). Up to `jobs` calls run at once, each a
// fiber in the pump's scope. A message's node starts once fewer than AHEAD view lines before it
// are unbuilt, a merge once both its halves are built. Nodes ready to build wait in queues, kept as
// messages arrive and nodes are built, never found by scanning the tree (§7 mistake 13): the
// unbuilt messages in order, whose first AHEAD are the ones that may start, and the ready merges
// level by level. A failed call is tried again at the next message, once it has rested (E31); a
// node the model refused, or gave no line for, REFUSALS times is built from its source, clipped.
import { Cause, Clock, Console, Data, Duration, Effect, Exit, PubSub, Semaphore } from "effect";
import { AHEAD, JOBS, REFUSALS } from "./config.ts";
import type { Node } from "./records.ts";
import { newNode, type StoreError } from "./store.ts";
import { built, children, clippedText, type Coord, end, entry, type Entry, freeText, label, type Mem, node, nodes, ready } from "./tree.ts";
import { compactionContext } from "./view.ts";

// one compactor call: its compaction view's lines (id+n|text) and the message or the two halves
export type Job = { readonly l: number; readonly i: number; readonly ctx: readonly string[] } & (
  | { readonly msg: Entry }
  | { readonly a: string; readonly b: string }
);

// `refused`: the model answered and gave no usable line (a refusal, or an empty line). That is its
// input's doing, so asking again mostly fails alike: REFUSALS of them clip the node (E31). Any
// other failure (a limit, the network, a crash) says nothing about the input and is only retried.
export class CompactError extends Data.TaggedError("CompactError")<{ readonly message: string; readonly refused?: boolean }> {}
export type Summarize = (job: Job) => Effect.Effect<string, CompactError>;
export type Commit = (n: Node) => Effect.Effect<void, StoreError>;

// a failure in one line: the typed error's message, else the defect's
const reason = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

// The call for node c, with its compaction view as it stands now (docs/optchat.md §4): a message's
// node sees the lines before the message, a merge those up to its last message, both up to the
// first unbuilt line; a merge gets its halves' texts.
export function makeJob(mem: Mem, c: Coord): Job {
  if (c.l === 0) return { ctx: compactionContext(mem, c.i), i: c.i, l: 0, msg: entry(mem, c.i) };
  const [left, right] = children(c);
  return { a: node(mem, left).text, b: node(mem, right).text, ctx: compactionContext(mem, end(c)), i: c.i, l: c.l };
}

// Every node whose source fits in NODE bytes, without a model call, in one scan of the tree: for
// an import, which builds a whole tree at once. Bottom-up, each committed before the next is
// looked at, so two free children make their parent free in the same pass.
export const buildFree = (mem: Mem, commit: Commit) =>
  Effect.gen(function* () {
    for (const c of nodes(mem.root.length)) {
      const text = built(mem, c) || !ready(mem, c) ? null : freeText(mem, c);
      if (text !== null) yield* commit(newNode(c.l, c.i, text));
    }
  });

// docs/optchat.md §4 "The size": the reply, trimmed, is the summary; nothing left after trimming is a failed call
const summaryOf = (reply: string) => {
  const text = reply.trim();
  return text ? Effect.succeed(text) : Effect.fail(new CompactError({ message: "the compactor replied with nothing", refused: true }));
};

// A queue that only grows at its end and is read from its head; what was read stays in the array
// below `head` until the array is compacted, which happens once that part is the bigger one.
class Line<A> {
  private items: A[] = [];
  private head = 0;
  push(a: A) {
    this.items.push(a);
  }
  // the first items from the head on, dropping from the head those `gone` says are done
  *from(gone: (a: A) => boolean): Generator<A> {
    for (let at = this.items[this.head]; at !== undefined && gone(at); at = this.items[this.head]) this.head++;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    for (let k = this.head, at = this.items[k]; at !== undefined; at = this.items[++k]) yield at;
  }
}

// The pump's work at one level of the tree, as clients see it (SessionState.compactions): calls
// running now, nodes ready and waiting for a free call, and nodes whose call failed and wait for
// the next message. Nodes not ready yet (a merge whose halves aren't built) are in none of these.
export type Activity = { readonly level: number; readonly running: number; readonly queued: number; readonly failed: number };

export type Pump = {
  // what the pump has to start at all: at startup, one scan of the tree into the queues
  readonly kick: Effect.Effect<void, StoreError>;
  // message i was logged: its node joins the queue, failed calls that have rested are tried again,
  // and the pump starts what it may; a failure is reported, not returned (the message is logged
  // either way)
  readonly logged: (i: number) => Effect.Effect<void>;
  // a message is coming (one the session holds for its turn), or a turn waiting for summaries asks
  // again (WAIT_RETRY): every failed call is tried again now, rested or not
  readonly retry: Effect.Effect<void>;
  // the work per level, the busy levels only, lowest first
  readonly activity: () => readonly Activity[];
  // published after every change of the queues (a call started or ended, a node queued)
  readonly changes: PubSub.PubSub<true>;
};

export type PumpOptions = {
  readonly summarize: Summarize;
  readonly jobs?: number | undefined;
  readonly ahead?: number | undefined; // AHEAD
  readonly report?: ((message: string) => Effect.Effect<void>) | undefined;
  // How long a failed call rests before a logged entry may try it again (E31): a turn logs its
  // replies, tool calls and results back to back, and each would otherwise ask a vendor that is
  // down again at once. None by default, as docs/optchat.md §4 has it; the server rests WAIT_RETRY.
  readonly rest?: Duration.Input | undefined;
  readonly refusals?: number | undefined; // REFUSALS
};

export const makePump = ({ commit, mem, summarize, ...o }: PumpOptions & { readonly mem: Mem; readonly commit: Commit }) =>
  Effect.gen(function* () {
    const limit = o.jobs ?? JOBS, ahead = o.ahead ?? AHEAD, refusals = o.refusals ?? REFUSALS;
    const rest = Duration.toMillis(Duration.fromInputUnsafe(o.rest ?? 0));
    const report = o.report ?? ((line: string) => Console.error(line));
    const scope = yield* Effect.scope;
    const clock = yield* Clock.Clock;
    // The queues: the unbuilt messages, in order, and the ready merges of each level. A node is in
    // at most one of: a queue, `running`, `failed` (waiting for the next message). `told`: the
    // nodes whose failure was reported already.
    const leaves = new Line<number>();
    const merges: (Line<Coord> | undefined)[] = [];
    // `queued` and `running` keep each node's level, for `activity`; `failedAt`, when each failed
    // node failed; `refused`, how many of its calls the model answered with no line (E31)
    const queued = new Map<string, number>(), running = new Map<string, number>(), failed = new Map<string, Coord>(), told = new Set<string>();
    const failedAt = new Map<string, number>(), refused = new Map<string, number>();
    // node c failed: it waits for the next message, rested
    const park = (name: string, c: Coord) => {
      failed.set(name, c);
      failedAt.set(name, clock.currentTimeMillisUnsafe());
    };
    const changes = yield* PubSub.sliding<true>(1);
    // one change of the queues at a time
    const one = yield* Semaphore.make(1);
    const kicks = { failing: false };

    // Node c is ready (its message is logged, or both halves built): built at once when it is
    // free, else queued. A free node that cannot be committed waits for the next message, failed.
    // A message's node also has its place in `leaves` (see `logged`).
    const consider = (c: Coord): Effect.Effect<void, StoreError> =>
      Effect.suspend(() => {
        const name = label(c);
        if (built(mem, c) || queued.has(name) || running.has(name) || failed.has(name)) return Effect.void;
        const text = freeText(mem, c);
        if (text !== null)
          return commit(newNode(c.l, c.i, text)).pipe(
            Effect.tapCause(() =>
              Effect.sync(() => {
                park(name, c); // a defect too: it is tried again all the same
              }),
            ),
            Effect.andThen(Effect.suspend(() => done(c))),
          );
        queued.set(name, c.l);
        if (c.l > 0) (merges[c.l] ??= new Line<Coord>()).push(c);
        return Effect.void;
      });
    // Node c is built: its parent is ready when its sibling is built too.
    const done = (c: Coord): Effect.Effect<void, StoreError> => {
      const sibling = { i: c.i ^ 1, l: c.l }, parent = { i: c.i >> 1, l: c.l + 1 };
      return built(mem, sibling) && !built(mem, parent) ? consider(parent) : Effect.void;
    };
    // message i is logged, or found unbuilt at startup: its place among the unbuilt messages
    const arrived = (i: number) =>
      Effect.suspend(() => {
        leaves.push(i);
        return consider({ i, l: 0 });
      });

    // The next node to start, if any: a message's among the first `ahead` unbuilt ones (every
    // unbuilt message is a view line of its own, and the view's only unbuilt lines are those), else
    // the oldest ready merge of the lowest level.
    const next = (): Coord | null => {
      let seen = 0;
      for (const i of leaves.from((k) => built(mem, { i: k, l: 0 }))) {
        if (built(mem, { i, l: 0 })) continue;
        if (++seen > ahead) break;
        const name = label({ i, l: 0 });
        if (queued.has(name)) return { i, l: 0 };
      }
      for (const level of merges) {
        if (!level) continue;
        for (const c of level.from((m) => !queued.has(label(m)))) if (queued.has(label(c))) return c;
      }
      return null;
    };

    // One job for node c. Making the call, summarizing, committing: whatever goes wrong there (a
    // typed error, a throw, a defect, the call coming back interrupted) is one failure of c,
    // reported the first time c fails; c then waits for the next message. Built or not, c leaves
    // `running`, and the pump starts what it may. A node the model gave no line for REFUSALS times
    // is not asked again: its job commits its source, clipped, marked as such (E31).
    const job = (c: Coord, call: Exit.Exit<Job>) => {
      const name = label(c);
      const clip = (refused.get(name) ?? 0) >= refusals;
      const attempt = clip
        ? Effect.suspend(() => commit(newNode(c.l, c.i, clippedText(mem, c), true)))
        : call.pipe(
            Effect.flatMap((j) => Effect.suspend(() => summarize(j))),
            Effect.flatMap(summaryOf),
            Effect.flatMap((text) => commit(newNode(c.l, c.i, text))),
          );
      const fail = (cause: Cause.Cause<CompactError | StoreError>) =>
        Effect.gen(function* () {
          const error = Cause.squash(cause);
          const none = !clip && error instanceof CompactError && error.refused === true ? (refused.get(name) ?? 0) + 1 : 0;
          if (none > 0) refused.set(name, none);
          // the last refusal: queued again at once, for a job that clips it (`clip`), said once
          if (none >= refusals) {
            yield* Effect.exit(report(`${name}: ${reason(cause)}; the model gave no line ${none} times, so the node is its source, clipped`));
            yield* Effect.exit(consider(c)); // not free (it would be built), so nothing to commit here
            return;
          }
          park(name, c);
          if (told.has(name)) return;
          told.add(name);
          // a report that fails has nowhere to go: the node waits for the next message all the same
          yield* Effect.exit(report(`${name}: ${reason(cause)}`));
        });
      // The attempt runs interruptibly inside an uninterruptible frame, so its outcome is always
      // looked at. An engine whose call ends interrupted (a process killed under it) has failed
      // like any other. If it is this fiber that is being interrupted (the pump's scope closing),
      // turning interruption back on for the rest ends the job right there.
      const once = Effect.uninterruptibleMask((restore) =>
        Effect.exit(restore(attempt)).pipe(
          Effect.flatMap((exit) =>
            restore(
              Exit.isSuccess(exit)
                ? guarded(Effect.suspend(() => (running.delete(name), refused.delete(name), done(c))))
                : Effect.andThen(one.withPermit(Effect.suspend(() => (running.delete(name), fail(exit.cause)))), nudge),
            ),
          ),
        ),
      );
      return once.pipe(Effect.ensuring(Effect.sync(() => void running.delete(name))));
    };

    // start what may start, up to `limit` at once; each job's context is taken now
    const start = Effect.gen(function* () {
      while (running.size < limit) {
        const c = next();
        if (c === null) return;
        const name = label(c);
        queued.delete(name);
        // if making the context throws, that is the job's failure and goes the same way
        const call = yield* Effect.exit(Effect.sync(() => makeJob(mem, c)));
        running.set(name, c.l);
        yield* Effect.forkIn(job(c, call), scope);
      }
    });

    // the failed nodes, ready again: every one (`all`), or those that have rested
    const again = (all: boolean) =>
      Effect.suspend(() => {
        const now = clock.currentTimeMillisUnsafe();
        const waiting = [...failed].filter(([name]) => all || now - (failedAt.get(name) ?? 0) >= rest);
        for (const [name] of waiting) {
          failed.delete(name);
          failedAt.delete(name);
        }
        return Effect.forEach(waiting, ([, c]) => consider(c), { discard: true });
      });

    // A change of the queues that comes after other work (a job, a logged message) is no part of
    // that work: its failure is reported (once until one gets through again), and what failed
    // waits for the next message. Interruption is the scope closing and passes through.
    const guarded = (change: Effect.Effect<void, StoreError>): Effect.Effect<void> =>
      one.withPermit(Effect.andThen(change, start)).pipe(
        Effect.ensuring(PubSub.publish(changes, true)),
        Effect.andThen(Effect.sync(() => void (kicks.failing = false))),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.suspend(() => {
                if (kicks.failing) return Effect.void;
                kicks.failing = true;
                return report(reason(cause));
              }),
        ),
      );
    const nudge = guarded(Effect.void);

    // at startup: every ready node of the tree, level by level, oldest first, into the queues (or
    // built, when free); the one scan the pump makes
    const scan = Effect.gen(function* () {
      for (const c of nodes(mem.root.length)) if (!built(mem, c) && ready(mem, c)) yield* c.l === 0 ? arrived(c.i) : consider(c);
    });
    const kick: Effect.Effect<void, StoreError> = one.withPermit(Effect.andThen(scan, start)).pipe(Effect.ensuring(PubSub.publish(changes, true)));
    const activity = (): readonly Activity[] => {
      const at = new Map<number, { running: number; queued: number; failed: number }>();
      const count = (level: number, key: "running" | "queued" | "failed") => {
        const row = at.get(level) ?? { failed: 0, queued: 0, running: 0 };
        row[key]++;
        at.set(level, row);
      };
      for (const level of running.values()) count(level, "running");
      for (const level of queued.values()) count(level, "queued");
      for (const c of failed.values()) count(c.l, "failed");
      return [...at].toSorted(([a], [b]) => a - b).map(([level, row]) => ({ level, ...row }));
    };
    const logged = (i: number) => guarded(Effect.andThen(again(false), arrived(i)));
    const retry = guarded(again(true));
    return { activity, changes, kick, logged, retry } satisfies Pump;
  });
