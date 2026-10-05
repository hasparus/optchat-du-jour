// The compactor's engine for a node: the chain configured for its level (E5), engine by engine.
// A move to the next engine, and the way back, are reported (SPEC "Failover"; and "Policy":
// compaction must not move onto the Claude plan unseen).
import { Effect, Result } from "effect";
import type { Runner } from "../claude/process.ts";
import { type Ref, type Settings, chainFor, parseRef } from "../config.ts";
import { type Job, CompactError, type Summarize } from "../compactor.ts";
import { failover, watchChain } from "../engines/chain.ts";
import type { EngineError } from "../engines/errors.ts";
import type { OpenAiPlan } from "../openai/responses.ts";
import type { UsageRecord } from "../usage.ts";
import { claudeCodeCompactor } from "./claude-code.ts";
import { openAiPlanCompactor } from "./openai-plan.ts";

type Compact = (job: Job, failoverFrom: string | null) => Effect.Effect<string, EngineError>;
type Options = { readonly settings: Settings; readonly log: (record: UsageRecord) => Effect.Effect<void> };

// how each compactor engine is built for a model, one per engine in IMPLEMENTED.compactor
const builders = {
  "claude-code": (model: string, o: Options) =>
    claudeCodeCompactor({ effort: o.settings.compactor.effort, log: o.log, model, ttl: o.settings.cache.claudeCodeTtl }),
  "openai-plan": (model: string, o: Options) => openAiPlanCompactor({ effort: o.settings.compactor.effort, log: o.log, model }),
} satisfies Record<Ref<"compactor">["engine"], (model: string, o: Options) => Effect.Effect<Compact, never, Runner | OpenAiPlan>>;

export const makeSummarize = (o: Options & { readonly report: (message: string) => Effect.Effect<void> }) =>
  Effect.gen(function* () {
    const build = (ref: string) => {
      const parsed = parseRef("compactor", ref);
      // loadSettings refuses such a chain first
      if (Result.isFailure(parsed)) return Effect.die(new Error(parsed.failure));
      return builders[parsed.success.engine](parsed.success.model, o);
    };
    const engines = new Map<string, Compact>();
    for (const ref of new Set(o.settings.compactor.byLevel.flatMap((b) => b.chain))) engines.set(ref, yield* build(ref));

    const watch = watchChain(o.report, "compacting");
    const summarize: Summarize = (job) =>
      failover(
        chainFor(o.settings, job.l).flatMap((ref) => {
          const run = engines.get(ref);
          return run ? [{ ref, run: (from: string | null) => run(job, from) }] : [];
        }),
        watch.moved,
        watch.answered,
      ).pipe(Effect.mapError((e) => new CompactError({ message: e.message })));
    // the engines down right now, with why: for the UI, so compaction never runs elsewhere unseen
    return { down: watch.down, summarize };
  });
