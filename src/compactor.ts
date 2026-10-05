// The pump (gist §4.1): builds tree nodes in rule-3 order, at most `jobs` at once, each job a
// fiber in the pump's scope. A failed node waits RETRY and goes back to the pump, forever: the
// pump then takes a fresh context for it, which a retry of the same job could not.
import { Cause, Console, Data, type Duration, Effect, Semaphore } from "effect";
import { JOBS, RETRY } from "./config.ts";
import { offers } from "./kernel.ts";
import type { Node } from "./records.ts";
import { newNode, type StoreError } from "./store.ts";
import { built, children, type Coord, end, entry, type Entry, freeText, label, type Mem, node, nodes, ready } from "./tree.ts";
import { context } from "./view.ts";

// one compactor call: the context lines (bare, gist §4.2) and the message or the two children
export type Job = { readonly l: number; readonly i: number; readonly ctx: readonly string[] } & (
  | { readonly msg: Entry }
  | { readonly a: string; readonly b: string }
);

export class CompactError extends Data.TaggedError("CompactError")<{ readonly message: string }> {}
export type Summarize = (job: Job) => Effect.Effect<string, CompactError>;
export type Commit = (n: Node) => Effect.Effect<void, StoreError>;

// a failure in one line: the typed error's message, else the defect's
const reason = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

// The call for node c, with the context as the view stands now. A merge sees every view line
// up to its own last message and gets its children's texts; a message's summary sees only the
// lines before that message.
export function makeJob(mem: Mem, c: Coord): Job {
  const { i, l } = c;
  if (l > 0) {
    const [left, right] = children(c);
    return { a: node(mem, left.l, left.i).text, b: node(mem, right.l, right.i).text, ctx: context(mem, end(c)), i, l };
  }
  return { ctx: context(mem, i), i, l, msg: entry(mem, i) };
}

// Every node whose source fits in NODE bytes, without a model call. Bottom-up, each committed
// before the next is looked at, so two free children make their parent free in the same pass.
export const buildFree = (mem: Mem, commit: Commit) =>
  Effect.gen(function* () {
    for (const c of nodes(mem.root.length)) {
      if (built(mem, c.l, c.i) || !ready(mem, c)) continue;
      const text = freeText(mem, c);
      if (text !== null) yield* commit(newNode(c.l, c.i, text));
    }
  });

export type Pump = {
  // build the free nodes, then start what rule 3 allows; call it after every change
  readonly kick: Effect.Effect<void, StoreError>;
  // the same, for a caller whose own work is already done: a failure is reported, not returned
  readonly nudge: Effect.Effect<void>;
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
    const { commit, mem, summarize } = o;
    const jobs = o.jobs ?? JOBS, retry = o.retry ?? RETRY, report = o.report ?? ((m: string) => Console.error(m));
    const scope = yield* Effect.scope;
    const busy = new Set<string>(), reported = new Set<string>();
    // one kick at a time, so two of them never commit the same free node
    const one = yield* Semaphore.make(1);

    // a kick that follows a job is no part of that job: its failure is reported on its own
    const nudge: Effect.Effect<void> = Effect.suspend(() => kick).pipe(Effect.catch((error) => report(error.message)));

    // One job: summarize, commit, and whatever goes wrong on the way (a typed error, a throw, a
    // defect in the store) is one failure: reported the first time this node fails, then the
    // node rests RETRY. Built or not, it then leaves `busy` and the pump looks again. An
    // interrupt (the pump's scope closing) is no failure and stays an interrupt.
    const run = (c: Coord, job: Job) => {
      const name = label(c);
      const attempt = Effect.suspend(() => summarize(job)).pipe(Effect.flatMap((text) => commit(newNode(c.l, c.i, text))));
      const rest = (cause: Cause.Cause<CompactError | StoreError>) =>
        Effect.gen(function* () {
          if (!reported.has(name)) {
            reported.add(name);
            yield* report(`${name}: ${reason(cause)}`);
          }
          yield* Effect.sleep(retry);
        });
      const failed = (cause: Cause.Cause<CompactError | StoreError>) =>
        Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : rest(cause);
      return attempt.pipe(
        Effect.catchCause(failed),
        Effect.andThen(Effect.sync(() => busy.delete(name))),
        Effect.andThen(nudge),
      );
    };

    const start = Effect.gen(function* () {
      for (const c of offers(mem)) {
        if (busy.size >= jobs) return;
        const name = label(c);
        if (busy.has(name)) continue;
        busy.add(name);
        // the context is taken here, in the state rule 3 just checked
        yield* Effect.forkIn(run(c, makeJob(mem, c)), scope);
      }
    });

    const kick: Effect.Effect<void, StoreError> = one.withPermit(Effect.andThen(buildFree(mem, commit), start));
    return { kick, nudge } satisfies Pump;
  });
