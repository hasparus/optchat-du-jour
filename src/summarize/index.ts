// The compactor's engine for a node: the chain configured for its level (E5), engine by engine.
// A move to the next engine, and the way back, are reported (SPEC "Failover"; and "Policy":
// compaction must not move onto the Claude plan unseen).
import { Effect, PubSub, Result } from "effect";
import type { Runner } from "../claude/process.ts";
import { type Ref, type Settings, chainFor, parseRef } from "../config.ts";
import { type Job, CompactError, type Summarize } from "../compactor.ts";
import type { Budget } from "../apikey/budget.ts";
import type { ApiKeys } from "../apikey/clients.ts";
import { type Down, type DownList, failover, watchChain } from "../engines/chain.ts";
import { type EngineError, UsageLimit } from "../engines/errors.ts";
import type { OpenAiPlan } from "../openai/responses.ts";
import type { UsageRecord } from "../usage.ts";
import { apiKeyCompactor } from "./api-key.ts";
import { claudeCodeCompactor } from "./claude-code.ts";
import { openAiPlanCompactor } from "./openai-plan.ts";

type Compact = (job: Job, failoverFrom: string | null) => Effect.Effect<string, EngineError>;
type Options = {
  readonly settings: Settings;
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly apiKey?: { readonly clients: ApiKeys["Service"]; readonly budget: Budget }; // for api-key links
  readonly device?: string; // the machine the compactor calls run on
};

// how each compactor engine is built for a model, one per engine in IMPLEMENTED.compactor
const builders = {
  "claude-code": (model: string, o: Options) =>
    claudeCodeCompactor({ device: o.device, effort: o.settings.compactor.effort, log: o.log, model, ttl: o.settings.cache.claudeCodeTtl }),
  "openai-plan": (model: string, o: Options) => openAiPlanCompactor({ device: o.device, effort: o.settings.compactor.effort, log: o.log, model }),
  "api-key": (model: string, o: Options) =>
    Effect.succeed<Compact>(
      o.apiKey
        ? apiKeyCompactor({ ...o.apiKey, device: o.device, effort: o.settings.compactor.effort, log: o.log, ref: `api-key:${model}`, settings: o.settings })
        : () => Effect.fail(new UsageLimit({ message: "api-key: not set up on this server" })),
    ),
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

    const changes = yield* PubSub.unbounded<readonly Down[]>();
    const watch = watchChain(o.report, "compacting", Effect.suspend(() => PubSub.publish(changes, watch.down())).pipe(Effect.asVoid));
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
    const down: DownList = { changes, now: watch.down };
    return { down, summarize };
  });
