// The pump (gist §4.1): builds tree nodes in rule-3 order, at most `jobs` at once, each job a
// fiber in the pump's scope. A failed node waits RETRY and goes back to the pump, forever: the
// pump then takes a fresh context for it, which a retry of the same job could not.
import { Console, Data, type Duration, Effect, Semaphore } from "effect";
import { JOBS, RETRY } from "./config.ts";
import { offers } from "./kernel.ts";
import type { Node } from "./records.ts";
import { newNode, type StoreError } from "./store.ts";
import { built, type Coord, entry, type Entry, freeText, label, type Mem, node, nodes, ready } from "./tree.ts";
import { context } from "./view.ts";

// one compactor call: the context lines (bare, gist §4.2) and the message or the two children
export type Job = { readonly l: number; readonly i: number; readonly ctx: readonly string[] } & (
  | { readonly msg: Entry }
  | { readonly a: string; readonly b: string }
);

export class CompactError extends Data.TaggedError("CompactError")<{ readonly message: string }> {}
export type Summarize = (job: Job) => Effect.Effect<string, CompactError>;
export type Commit = (n: Node) => Effect.Effect<void, StoreError>;

// What a call for (l, i) sees, taken now: the view lines before message i for a leaf, up to
// the node's last message for a merge.
export function makeJob(mem: Mem, l: number, i: number): Job {
  if (l === 0) return { ctx: context(mem, i), i, l, msg: entry(mem, i) };
  return { a: node(mem, l - 1, 2 * i).text, b: node(mem, l - 1, 2 * i + 1).text, ctx: context(mem, (i + 1) * 2 ** l), i, l };
}

// Every node whose source fits in NODE bytes, without a model call. Bottom-up, each committed
// before the next is looked at, so two free children make their parent free in the same pass.
export const buildFree = (mem: Mem, commit: Commit) =>
  Effect.gen(function* () {
    for (const c of nodes(mem.root.length)) {
      if (built(mem, c.l, c.i) || !ready(mem, c.l, c.i)) continue;
      const text = freeText(mem, c.l, c.i);
      if (text !== null) yield* commit(newNode(c.l, c.i, text));
    }
  });

export type Pump = {
  // build the free nodes, then start what rule 3 allows; call it after every change
  readonly kick: Effect.Effect<void, StoreError>;
  readonly busy: ReadonlySet<string>;
};

export const makePump = (o: {
  readonly mem: Mem;
  readonly commit: Commit;
  readonly summarize: Summarize;
  readonly jobs?: number | undefined;
  readonly retry?: Duration.Input | undefined;
  readonly report?: ((message: string) => Effect.Effect<void>) | undefined;
}) =>
  Effect.gen(function* () {
    const { mem, commit, summarize } = o;
    const jobs = o.jobs ?? JOBS, retry = o.retry ?? RETRY, report = o.report ?? ((m: string) => Console.error(m));
    const scope = yield* Effect.scope;
    const busy = new Set<string>(), reported = new Set<string>();
    // one kick at a time, so two of them never commit the same free node
    const one = yield* Semaphore.make(1);

    // a kick that follows a job is no part of that job: its failure is reported on its own
    const again: Effect.Effect<void> = Effect.suspend(() => kick).pipe(Effect.catch((error) => report(error.message)));

    const run = (c: Coord, job: Job) => {
      const name = label(c);
      return summarize(job).pipe(
        Effect.flatMap((text) => commit(newNode(c.l, c.i, text))),
        Effect.matchEffect({
          onFailure: (e) =>
            Effect.gen(function* () {
              if (!reported.has(name)) {
                reported.add(name);
                yield* report(`${name}: ${e.message}`);
              }
              yield* Effect.sleep(retry);
              busy.delete(name);
              yield* again;
            }),
          onSuccess: () =>
            Effect.gen(function* () {
              busy.delete(name);
              yield* again;
            }),
        }),
      );
    };

    const start = Effect.gen(function* () {
      for (const c of offers(mem)) {
        if (busy.size >= jobs) return;
        const name = label(c);
        if (busy.has(name)) continue;
        busy.add(name);
        // the context is taken here, in the state rule 3 just checked
        yield* Effect.forkIn(run(c, makeJob(mem, c.l, c.i)), scope);
      }
    });

    const kick: Effect.Effect<void, StoreError> = one.withPermit(Effect.andThen(buildFree(mem, commit), start));
    return { busy, kick } satisfies Pump;
  });
