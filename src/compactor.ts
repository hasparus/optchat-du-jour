// The pump (gist §4.1): starts every node rule 3 allows, up to JOBS at once; free nodes need no
// model call. Each job is a fiber in the pump's scope, so closing the scope stops them all.
import { Data, type Duration, Effect, FiberSet, Schedule, type Scope } from "effect";
import { JOBS, RETRY } from "./config.ts";
import * as K from "./kernel.ts";
import type { Node } from "./records.ts";
import { newNode, type StoreError } from "./store.ts";
import { built, type Coord, type Entry, entry, freeText, key, label, type Mem, node, ready } from "./tree.ts";
import { context } from "./view.ts";

// A compactor call's input (gist §4.2): the view lines before the node, bare, and the step's source:
// the message whole, or the two child lines. `level` picks the engine chain (E5).
export type Job = { readonly ctx: readonly string[]; readonly i: number; readonly l: number; } & (
  | { readonly a: string; readonly b: string }
  | { readonly msg: Entry }
);

export class CompactError extends Data.TaggedError("CompactError")<{ readonly message: string }> {}
export type Summarize = (job: Job) => Effect.Effect<string, CompactError>;
export type Commit = (n: Node) => Effect.Effect<void, StoreError>;

export function makeJob(mem: Mem, l: number, i: number): Job {
  if (l === 0) return { ctx: context(mem, i), i, l, msg: entry(mem, i) };
  return { a: node(mem, l - 1, 2 * i).text, b: node(mem, l - 1, 2 * i + 1).text, ctx: context(mem, (i + 1) * 2 ** l), i, l };
}

// free nodes, bottom-up: no model call, so no JOBS slot and no rule 3. Each is committed before
// the pass goes on, so a free pair makes its parent ready further up the same pass.
// ponytail: every pass scans all nodes, O(T); fine to ~1e5 messages, then keep a per-level cursor
export const buildFree = (mem: Mem, commit: Commit) =>
  Effect.gen(function* () {
    const T = mem.root.length;
    for (let l = 0; 2 ** l <= T; l++)
      for (let i = 0; (i + 1) * 2 ** l <= T; i++) {
        if (built(mem, l, i) || !ready(mem, l, i)) continue;
        const text = freeText(mem, l, i);
        if (text !== null) yield* commit(newNode(l, i, text));
      }
  });

export type Pump = {
  // look for work: build the free nodes, then start what rule 3 allows
  readonly busy: ReadonlySet<string>;
  readonly kick: Effect.Effect<void, StoreError>;
};

// The slots are a count of running jobs rather than a semaphore: each pass offers the free slots
// to the nodes in rule-3 order, so a merge never waits behind a message queued earlier.
export const makePump = (o: {
  readonly commit: Commit;
  readonly jobs?: number;
  readonly mem: Mem;
  readonly report?: (message: string) => Effect.Effect<void>;
  readonly retry?: Duration.Input;
  readonly summarize: Summarize;
}): Effect.Effect<Pump, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { commit, mem, summarize } = o;
    const jobs = o.jobs ?? JOBS, report = o.report ?? (() => Effect.void);
    const busy = new Set<string>(), failed = new Set<string>();
    const fibers = yield* FiberSet.make();
    const retry = Schedule.spaced(o.retry ?? RETRY);

    const run = (c: Coord): Effect.Effect<void, StoreError> => {
      const k = key(c.l, c.i);
      let job = makeJob(mem, c.l, c.i); // the state this pass decided on; a retry looks again
      let tries = 0;
      return Effect.suspend(() => {
        if (tries++ > 0) job = makeJob(mem, c.l, c.i);
        return summarize(job);
      }).pipe(
        Effect.flatMap((text) =>
          text.trim() ? Effect.succeed(text.trim()) : Effect.fail(new CompactError({ message: "empty summary" })),
        ),
        Effect.flatMap((text) => commit(newNode(c.l, c.i, text))),
        Effect.tapError((e) => {
          if (failed.has(k)) return Effect.void; // only the first failure of a node is reported
          failed.add(k);
          return report(`${label(c)}: ${e.message}`);
        }),
        Effect.retry(retry), // fixed, forever: the next turn waits for these (gist §4.1)
        Effect.orDie, // a spaced schedule never gives up, so nothing gets here
        Effect.tap(() =>
          Effect.sync(() => {
            busy.delete(k);
            failed.delete(k);
          }),
        ),
        Effect.andThen(() => kick),
      );
    };

    const kick: Effect.Effect<void, StoreError> = Effect.gen(function* () {
      yield* buildFree(mem, commit);
      for (const c of K.offers(mem)) {
        if (busy.size >= jobs) return;
        const k = key(c.l, c.i);
        if (busy.has(k)) continue;
        busy.add(k);
        yield* FiberSet.run(fibers, run(c).pipe(Effect.catch((error) => report(`${label(c)}: ${error.message}`))));
      }
    });

    return { busy, kick };
  });
