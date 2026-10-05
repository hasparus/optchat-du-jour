// One place that turns an engine ref into an engine (E4, E5; SPEC "Engines"): a turn engine for a
// link of the master's chain, a compactor engine for a link of a level's chain. Refs come decoded
// from the settings (src/config.ts Ref), so there is nothing left to refuse here. What an engine
// needs from outside is asked for only when a ref names that engine: the ChatGPT plan's client
// for openai-plan, the API keys' clients for api-key, each built once on first use.
import { Effect } from "effect";
import type { Budget } from "../apikey/budget.ts";
import type { ApiKeys } from "../apikey/clients.ts";
import { Runner } from "../claude/process.ts";
import type { Job } from "../compactor.ts";
import type { ToolBox } from "../tools/box.ts";
import { MASTER_TOOLS, mediaSettings, type Ref, type Settings } from "../config.ts";
import { apiKeyProvider } from "../providers/api-key.ts";
import type { Provider } from "../providers/provider.ts";
import { responsesProvider } from "../providers/responses.ts";
import type { OpenAiPlan } from "../openai/responses.ts";
import { apiKeyCompactor } from "../summarize/api-key.ts";
import { claudeCodeCompactor } from "../summarize/claude-code.ts";
import { openAiPlanCompactor } from "../summarize/openai-plan.ts";
import { type Placement, claudeCodeTurn } from "../turn/claude-code.ts";
import type { TurnEngine } from "../turn/engine.ts";
import { toolLoop } from "../turn/loop.ts";
import type { UsageRecord } from "../usage.ts";
import type { DeviceOffline, EngineError } from "./errors.ts";

// one compactor engine: a node's summary, or why not; `failoverFrom` names the link before it
export type Compact = (job: Job, failoverFrom: string | null) => Effect.Effect<string, EngineError>;

// what every engine may need
export type EngineNeeds = {
  readonly settings: Settings;
  // usage.jsonl, each record through the api-key budget first
  readonly log: (record: UsageRecord) => Effect.Effect<void>;
  readonly report: (message: string) => Effect.Effect<void>;
  readonly budget: Budget; // the api-key engine's monthly budget
  readonly plan: Effect.Effect<OpenAiPlan["Service"]>; // the ChatGPT plan's client, built on first use
  readonly apiKeys: Effect.Effect<ApiKeys["Service"]>; // the API keys' clients, built on first use
};

// a compactor engine's needs: compactor calls run on the server's own machine, named in their usage records
export type CompactorNeeds = EngineNeeds & { readonly device?: string; readonly runner: Runner["Service"] };

// a turn engine's needs: the one system prompt (gist §7.2), where each device's claude runs (E7),
// and the read-only tools of an engine with its own loop (M5)
export type TurnNeeds = EngineNeeds & {
  readonly lead: boolean; // the first link of the master's chain (E18)
  readonly instructions: string;
  readonly systemFile: string;
  readonly runnerFor: (device: string) => Effect.Effect<Placement, DeviceOffline>;
  readonly toolsFor: (device: string) => ToolBox;
};

export const compactorEngine = (ref: Ref, o: CompactorNeeds): Effect.Effect<Compact> => {
  const { effort } = o.settings.compactor;
  switch (ref.engine) {
    case "claude-code":
      return claudeCodeCompactor({ device: o.device, effort, log: o.log, model: ref.model, ttl: o.settings.cache.claudeCodeTtl }).pipe(
        Effect.provideService(Runner, o.runner),
      );
    case "openai-plan":
      return Effect.map(o.plan, (plan) => openAiPlanCompactor({ device: o.device, effort, log: o.log, model: ref.model, plan }));
    case "api-key":
      return Effect.map(o.apiKeys, (clients) => apiKeyCompactor({ budget: o.budget, clients, device: o.device, effort, log: o.log, ref, settings: o.settings }));
  }
};

// The provider of an engine that has no loop of its own (SPEC "Engines": openai-plan, the Responses
// API on the ChatGPT plan, with `stream: true` and `store: false`; api-key, an API key's Anthropic
// or OpenAI), built from what the ref's engine needs. Our tool loop (../turn/loop.ts) runs it.
export const providerOf = (ref: Ref, o: EngineNeeds, effort?: string): Effect.Effect<Provider> => {
  switch (ref.engine) {
    case "openai-plan":
      return Effect.map(o.plan, (plan) => responsesProvider({ auth: "chatgpt-pro", effort, engine: "openai-plan", model: ref.model, respond: plan.respond }));
    case "api-key":
      return Effect.map(o.apiKeys, (clients) => apiKeyProvider({ budget: o.budget, clients, effort, ref, settings: o.settings }));
    case "claude-code":
      return Effect.die(new Error("claude-code runs its own loop: it has no provider"));
  }
};

export const turnEngine = (ref: Ref, o: TurnNeeds): Effect.Effect<TurnEngine> => {
  const { effort, permissionMode, tools } = o.settings.master;
  switch (ref.engine) {
    case "claude-code":
      return claudeCodeTurn({
        effort,
        lead: o.lead,
        logUsage: o.log,
        model: ref.model,
        permissionMode,
        primeTtl: o.settings.cache.primeTtl,
        report: o.report,
        runnerFor: o.runnerFor,
        systemFile: o.systemFile,
        tools: tools ?? MASTER_TOOLS,
        ttl: o.settings.cache.claudeCodeTtl,
      });
    case "openai-plan":
    case "api-key":
      // the plan's route is sent images only once that is known to work (SPEC "Media")
      return Effect.map(providerOf(ref, o, effort), (provider) =>
        toolLoop({ instructions: o.instructions, provider, ref: ref.ref, toolsFor: o.toolsFor, vision: ref.engine === "api-key" || mediaSettings(o.settings).planImages }),
      );
  }
};
