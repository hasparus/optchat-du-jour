// The compactor's engine for a node: the chain configured for its level (E5), engine by engine.
// A move to the next engine, and the way back, are reported (SPEC "Failover"; and "Policy":
// compaction must not move onto the Claude plan unseen).
import { Effect, PubSub } from "effect";
import { chainFor } from "../config.ts";
import { CompactError, type Summarize } from "../compactor.ts";
import { type Down, type DownList, failover, watchChain } from "../engines/chain.ts";
import { type Compact, type CompactorNeeds, compactorEngine } from "../engines/registry.ts";

export const makeSummarize = (o: CompactorNeeds) =>
  Effect.gen(function* () {
    // one engine per ref any level names, built once
    const engines = new Map<string, Compact>();
    for (const ref of o.settings.compactor.byLevel.flatMap((b) => b.chain))
      if (!engines.has(ref.ref)) engines.set(ref.ref, yield* compactorEngine(ref, o));

    const changes = yield* PubSub.unbounded<readonly Down[]>();
    const watch = watchChain(o.report, "compacting", Effect.suspend(() => PubSub.publish(changes, watch.down())).pipe(Effect.asVoid));
    const summarize: Summarize = (job) =>
      failover(
        chainFor(o.settings, job.l).flatMap(({ ref }) => {
          const run = engines.get(ref);
          return run ? [{ ref, run: (from: string | null) => run(job, from) }] : [];
        }),
        watch,
      ).pipe(Effect.mapError((e) => new CompactError({ message: e.message })));
    // the engines down right now, with why: for the UI, so compaction never runs elsewhere unseen
    const down: DownList = { changes, now: watch.down };
    return { down, summarize };
  });
