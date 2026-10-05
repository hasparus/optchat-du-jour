// The compactor's engine for a node: the chain configured for its level (E5), engine by engine.
import { Effect } from "effect";
import { type Settings, chainFor } from "../config.ts";
import { type Job, CompactError, type Summarize } from "../compactor.ts";
import type { ApiKeys } from "../apikey/clients.ts";
import type { Budget } from "../apikey/budget.ts";
import { failover } from "../engines/chain.ts";
import { type EngineError, UsageLimit } from "../engines/errors.ts";
import type { UsageRecord } from "../usage.ts";
import { apiKeyCompactor } from "./api-key.ts";
import { claudeCodeCompactor } from "./claude-code.ts";
import { openAiPlanCompactor } from "./openai-plan.ts";

export const makeSummarize = (o: {
  readonly settings: Settings;
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly report: (message: string) => Effect.Effect<void>;
  readonly apiKey?: { readonly clients: ApiKeys["Service"]; readonly budget: Budget }; // for api-key links
}) =>
  Effect.gen(function* () {
    const engines = new Map<string, (job: Job, failoverFrom: string | null) => Effect.Effect<string, EngineError>>();
    const { effort } = o.settings.compactor;
    for (const ref of new Set(o.settings.compactor.byLevel.flatMap((b) => b.chain))) {
      const [engine, model = ""] = ref.split(/:(.*)/s);
      // loadSettings refuses a chain naming an engine not built yet
      if (engine === "claude-code") engines.set(ref, yield* claudeCodeCompactor({ effort, log: o.log, model, ttl: o.settings.cache.claudeCodeTtl }));
      if (engine === "openai-plan") engines.set(ref, yield* openAiPlanCompactor({ effort, log: o.log, model }));
      if (engine === "api-key")
        engines.set(
          ref,
          o.apiKey
            ? apiKeyCompactor({ ...o.apiKey, effort, log: o.log, ref, settings: o.settings })
            : () => Effect.fail(new UsageLimit({ message: "api-key: not set up on this server" })),
        );
    }
    // one notice per change of failover, not one per node: signed out, every node would say it
    let last = "";
    const moved = (from: string, to: string, why: string) => {
      const notice = `compactor: ${from} → ${to} (${why})`;
      if (notice === last) return Effect.void;
      last = notice;
      return o.report(notice);
    };
    const summarize: Summarize = (job) =>
      failover(
        chainFor(o.settings, job.l).flatMap((ref) => {
          const run = engines.get(ref);
          return run ? [{ ref, run: (from: string | null) => run(job, from) }] : [];
        }),
        moved,
      ).pipe(Effect.mapError((e) => new CompactError({ message: e.message })));
    return summarize;
  });
