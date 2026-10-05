// The compactor's engine for a node: the chain configured for its level (E5), engine by engine.
// A move to the next engine, and the way back, are reported (SPEC "Failover"; and "Policy":
// compaction must not move onto the Claude plan unseen).
import { Effect, Schema } from "effect";
import { type Settings, chainFor } from "../config.ts";
import { type Job, CompactError, type Summarize } from "../compactor.ts";
import { failover, watchChain } from "../engines/chain.ts";
import type { EngineError } from "../engines/errors.ts";
import { Engine, type UsageRecord } from "../usage.ts";
import { claudeCodeCompactor } from "./claude-code.ts";
import { openAiPlanCompactor } from "./openai-plan.ts";

type Compact = (job: Job, failoverFrom: string | null) => Effect.Effect<string, EngineError>;
const decodeEngine = Schema.decodeUnknownSync(Engine);

export const makeSummarize = (o: {
  readonly settings: Settings;
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly report: (message: string) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const { effort } = o.settings.compactor;
    const build = (ref: string) => {
      const [engine = "", model = ""] = ref.split(/:(.*)/s);
      const kind = decodeEngine(engine);
      switch (kind) {
        case "claude-code":
          return claudeCodeCompactor({ effort, log: o.log, model, ttl: o.settings.cache.claudeCodeTtl });
        case "openai-plan":
          return openAiPlanCompactor({ effort, log: o.log, model });
        case "api-key":
          // loadSettings refuses a chain naming an engine not built yet
          return Effect.die(new Error(`${ref}: no ${kind} compactor yet`));
      }
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
