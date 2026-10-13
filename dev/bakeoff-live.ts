import { BunServices } from "@effect/platform-bun";
import { Console, Context, Duration, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { existsSync } from "node:fs";
import { makeBudget } from "../src/apikey/budget.ts";
import { ApiKeys, apiKeysLayer } from "../src/apikey/clients.ts";
import { Runner, LocalRunner } from "../src/claude/process.ts";
import { loadSettings } from "../src/config.ts";
import { makeGate } from "../src/engines/inflight.ts";
import { OpenAiPlan, openAiPlanLayer } from "../src/openai/responses.ts";
import { HOME } from "../src/paths.ts";
import { systemPrompt } from "../src/prompts.ts";
import { SecretsLive } from "../src/secrets.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { toolDefs } from "../src/tools/box.ts";
import { type UsageRecord, logUsage } from "../src/usage.ts";
import { type BakeoffArtifact, type RunOutcome, ArtifactWriteError, createArtifact, writeArtifact } from "./bakeoff-artifact.ts";
import { lexicalAnswerer, measure, modelBuiltNodes, table } from "./bakeoff-metrics.ts";
import { type BakeoffCommand, resolveBakeoffOptions } from "./bakeoff-options.ts";
import { readSource, replay } from "./bakeoff-replay.ts";
import { makeRunControl, runContenders } from "./bakeoff-run.ts";

export const executeBakeoff = (command: Extract<BakeoffCommand, { readonly type: "run" }>) => Effect.gen(function* () {
  const root = new URL("..", import.meta.url).pathname;
  const loaded = yield* loadSettings(Bun.env.OPTCHAT_CONFIG ?? `${root}optchat.config.ts`);
  const options = yield* Effect.try(() => resolveBakeoffOptions(command, loaded, { outputExists: existsSync, sourceExists: existsSync }));
  const messages = yield* readSource(options.from, options.messageCount, options.skip);
  const control = makeRunControl(options.maxRequests, options.failFast);
  let current: RunOutcome = { active: { type: "none" }, contenders: [], type: "running" };
  const artifact = (outcome: RunOutcome): BakeoffArtifact => ({
    outcome,
    requestedNames: options.contenders.map((contender) => contender.name),
    requests: { authorized: control.snapshot().authorizedRequests, max: options.maxRequests },
    version: 2,
  });
  let published = false;
  const persist = (outcome: RunOutcome) => Effect.sync(() => {
    if (!published && outcome.type === "aborted") return;
    current = outcome;
    try {
      (published || options.overwrite ? writeArtifact : createArtifact)(options.out, artifact(outcome));
      published = true;
    } catch (error) {
      if (error instanceof ArtifactWriteError && error.published) published = true;
      throw error;
    }
  });
  const execute = Effect.scoped(Effect.gen(function* () {
    const count = modelBuiltNodes(messages.length);
    yield* Console.error(`bake-off setup: ${options.contenders.length} contenders, ${count} model-built nodes each`);
    yield* Console.error(`bake-off limits: ${count * options.contenders.length} one-call lower bound, ${options.maxRequests} max authorized requests`);
    const outside = Layer.mergeAll(SecretsLive, FetchHttpClient.layer);
    const scope = yield* Effect.scope;
    const plan = yield* Effect.cached(
      Layer.buildWithScope(openAiPlanLayer(options.settings.openai, { report: () => Effect.void }).pipe(Layer.provide(outside)), scope).pipe(
        Effect.map((context) => Context.get(context, OpenAiPlan)),
      ),
    );
    const apiKeys = yield* Effect.cached(
      Layer.buildWithScope(apiKeysLayer(options.settings.apiKey).pipe(Layer.provide(outside)), scope).pipe(Effect.map((context) => Context.get(context, ApiKeys))),
    );
    const runner = Context.get(yield* Layer.build(LocalRunner.pipe(Layer.provide(BunServices.layer))), Runner);
    const usagePath = `${HOME}/usage.jsonl`;
    const budget = makeBudget({ monthly: options.settings.apiKey?.monthlyBudget ?? 0, report: () => Effect.void, usagePath });
    const spend = (record: UsageRecord) => record.auth === "api-key" ? logUsage(usagePath, record).pipe(Effect.asVoid) : Effect.void;
    const outcome = yield* runContenders({
      contenders: options.contenders,
      control,
      persist,
      run: (contender, local) => Effect.gen(function* () {
        const replayed = yield* replay({
          contender,
          control: local,
          deadline: Duration.minutes(options.deadlineMinutes),
          messages,
          summarizeFor: (choice, log, report) => makeSummarize({
            apiKeys,
            budget,
            gate: makeGate(),
            instructions: systemPrompt(HOME),
            log: (record) => budget.note(record).pipe(Effect.andThen(log(record)), Effect.andThen(spend(record))),
            placement: Effect.succeed({ cwd: undefined, mcpConfig: JSON.stringify({ mcpServers: {} }), mcpSeen: () => Effect.succeed(false), runner }),
            plan,
            report,
            settings: { ...options.settings, compactor: { ...options.settings.compactor, byLevel: choice.byLevel } },
            tools: toolDefs({ device: options.settings.defaultDevice, folders: options.settings.devices[options.settings.defaultDevice]?.folders ?? [] }),
          }).pipe(Effect.map((made) => made.summarize)),
        });
        if (replayed.type === "failed") {
          if (replayed.failure.type === "global") return { abort: replayed.failure.abort, progress: replayed.progress, type: "global-abort" } as const;
          return { name: contender.name, progress: replayed.progress, reason: replayed.failure.reason, type: "failed" } as const;
        }
        const metrics = yield* measure(replayed, messages, { answerer: lexicalAnswerer, kinds: options.kinds, questions: options.questionCount });
        return { metrics, name: contender.name, type: "complete", usageRecords: replayed.records.length } as const;
      }),
    });
    yield* Console.log(table(outcome.contenders.flatMap((contender) => contender.type === "complete" ? [contender] : [])));
    return outcome.type === "complete" ? 0 : 1;
  }));
  return yield* execute.pipe(Effect.catchCause((cause) => {
    if (!published) return Effect.failCause(cause);
    const active = current.type === "running" && current.active.type === "active" ? { name: current.active.name, type: "unavailable" as const } : { type: "none" as const };
    return persist({ abort: { type: "unexpected" }, active, contenders: current.contenders, type: "aborted" }).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.andThen(Console.error("bake-off failed (details redacted)")),
      Effect.as(1),
    );
  }));
});
