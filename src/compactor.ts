// The compactor's scheduler (gist §4.1). It starts what rule 3 allows, level by level, never
// more than `jobs` at a time, each job a fiber in the pump's scope. A node that fails rests for
// RETRY and is then offered again, without end; it gets a context taken afresh at that point,
// since the view may have moved on while it rested.
import { Cause, Console, Data, type Duration, Effect, Exit, Semaphore } from "effect";
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
  if (c.l === 0) return { ctx: context(mem, c.i), i: c.i, l: 0, msg: entry(mem, c.i) };
  const [left, right] = children(c);
  return { a: node(mem, left).text, b: node(mem, right).text, ctx: context(mem, end(c)), i: c.i, l: c.l };
}

// Every node whose source fits in NODE bytes, without a model call. Bottom-up, each committed
// before the next is looked at, so two free children make their parent free in the same pass.
export const buildFree = (mem: Mem, commit: Commit) =>
  Effect.gen(function* () {
    for (const c of nodes(mem.root.length)) {
      const text = built(mem, c) || !ready(mem, c) ? null : freeText(mem, c);
      if (text !== null) yield* commit(newNode(c.l, c.i, text));
    }
  });

// gist §4.3: the reply, trimmed, is the summary; nothing left after trimming is a failed call
const summaryOf = (reply: string) => {
  const text = reply.trim();
  return text ? Effect.succeed(text) : Effect.fail(new CompactError({ message: "the compactor replied with nothing" }));
};

export type Pump = {
  // build the free nodes, then start what rule 3 allows; call it after every change
  readonly kick: Effect.Effect<void, StoreError>;
  // the same, for a caller whose own work is already done: a failure is reported, not returned
  readonly nudge: Effect.Effect<void>;
};

export type PumpOptions = {
  readonly summarize: Summarize;
  readonly jobs?: number | undefined;
  readonly retry?: Duration.Input | undefined;
  readonly report?: ((message: string) => Effect.Effect<void>) | undefined;
};

export const makePump = ({ commit, mem, summarize, ...o }: PumpOptions & { readonly mem: Mem; readonly commit: Commit }) =>
  Effect.gen(function* () {
    const limit = o.jobs ?? JOBS;
    const pause = o.retry ?? RETRY;
    const report = o.report ?? ((line: string) => Console.error(line));
    const scope = yield* Effect.scope;
    // nodes with a job running or resting, and the nodes whose failure was already reported
    const running = new Set<string>(), told = new Set<string>();
    // one kick at a time, so two of them never commit the same free node
    const one = yield* Semaphore.make(1);
    const kicks = { failing: false, again: false };

    // A kick that comes after other work (a job, a logged message) is no part of that work. When
    // it fails, typed error or defect alike, the failure is reported (once until a kick gets
    // through again) and one more kick is set for RETRY later, so nothing waits on an event that
    // may never come. Interruption is the scope closing and passes through.
    const nudge: Effect.Effect<void> = Effect.suspend(() => kick).pipe(
      Effect.andThen(
        Effect.sync(() => {
          kicks.failing = false;
        }),
      ),
      Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : kickFailed(cause))),
    );
    const kickFailed = (cause: Cause.Cause<StoreError>) =>
      Effect.gen(function* () {
        if (!kicks.failing) {
          kicks.failing = true;
          yield* report(reason(cause));
        }
        if (kicks.again) return;
        kicks.again = true;
        const later = Effect.sleep(pause).pipe(
          Effect.andThen(
            Effect.sync(() => {
              kicks.again = false;
            }),
          ),
          Effect.andThen(nudge),
        );
        yield* Effect.forkIn(later, scope);
      });

    // One job for node c. Making the call, summarizing, committing: whatever goes wrong there (a
    // typed error, a throw, a defect) is one failure of c, reported the first time c fails, after
    // which c rests for RETRY. Built or not, c then leaves `running` and the pump looks again.
    const job = (c: Coord, call: Exit.Exit<Job>) => {
      const name = label(c);
      const attempt = call.pipe(
        Effect.flatMap((j) => Effect.suspend(() => summarize(j))),
        Effect.flatMap(summaryOf),
        Effect.flatMap((text) => commit(newNode(c.l, c.i, text))),
      );
      const rest = (cause: Cause.Cause<CompactError | StoreError>) =>
        Effect.gen(function* () {
          if (!told.has(name)) {
            told.add(name);
            yield* report(`${name}: ${reason(cause)}`);
          }
          yield* Effect.sleep(pause);
        });
      return attempt.pipe(
        Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : rest(cause))),
        Effect.andThen(
          Effect.sync(() => {
            running.delete(name);
          }),
        ),
        Effect.andThen(nudge),
      );
    };

    const start = Effect.gen(function* () {
      for (const c of offers(mem)) {
        if (running.size >= limit) return;
        const name = label(c);
        if (running.has(name)) continue;
        // the context is taken now, in the state rule 3 just checked; if making it throws, that
        // is the job's failure and goes through the same rest and retry
        const call = yield* Effect.exit(Effect.sync(() => makeJob(mem, c)));
        running.add(name);
        yield* Effect.forkIn(job(c, call), scope);
      }
    });

    const kick: Effect.Effect<void, StoreError> = one.withPermit(Effect.andThen(buildFree(mem, commit), start));
    return { kick, nudge } satisfies Pump;
  });
