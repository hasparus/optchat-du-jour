// One place that turns an engine ref into an engine (E4, E5; SPEC "Engines"): a turn engine for a
// link of the master's chain, a compactor engine for a link of a level's chain. Refs come decoded
// from the settings (src/config.ts Ref), so there is nothing left to refuse here. What an engine
// needs from outside is asked for only when a ref names that engine: the ChatGPT plan's client
// for openai-plan, the API keys' clients for api-key, each built once on first use.
import { Effect } from "effect";
import type { Budget } from "../apikey/budget.ts";
import type { ApiKeys } from "../apikey/clients.ts";
import type { Job } from "../compactor.ts";
import type { ToolBox } from "../tools/box.ts";
import { MASTER_TOOLS, mediaSettings, type ProviderRef, type Ref, type Settings } from "../config.ts";
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
import type { ToolDef } from "../tools/files.ts";
import type { UsageRecord } from "../usage.ts";
import type { DeviceOffline, EngineError } from "./errors.ts";
import type { Gate } from "./inflight.ts";

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

// A compactor engine's needs: compactor calls run on the server's own machine, named in their usage
// records. They send what a turn sends before its view (docs/optchat.md §4, §5): the one system
// prompt, and a turn's tools (the default device's for a provider; for claude-code, a turn's on
// this machine, `placement`): the same bytes before the view. A cache entry is the model's own at
// its effort, so they read a turn's entry only when they run on the turns' model and effort, which
// the shipped chains don't (E5, E26). They wait on a call writing the same marked prefix, on the
// same model and effort (`gate`, docs/optchat.md §3.3).
export type CompactorNeeds = EngineNeeds & {
  readonly device?: string;
  readonly instructions: string;
  readonly tools: readonly ToolDef[];
  readonly placement: Effect.Effect<Placement, DeviceOffline>;
  readonly gate: Gate;
};

// a turn engine's needs: the one system prompt (docs/optchat.md §5), where each device's claude runs (E7),
// and the read-only tools of an engine with its own loop (M5)
export type TurnNeeds = EngineNeeds & {
  readonly warms: () => boolean; // the warm processes follow it: it ran the most recent turn, or heads the chain before any (E18)
  readonly instructions: string;
  readonly runnerFor: (device: string) => Effect.Effect<Placement, DeviceOffline>;
  readonly toolsFor: (device: string) => ToolBox;
};

export const compactorEngine = (ref: Ref, o: CompactorNeeds): Effect.Effect<Compact> => {
  // the entry's own effort, else the compactor's (src/config.ts Ref)
  const effort = ref.effort ?? o.settings.compactor.effort;
  const { gate, instructions, tools } = o;
  switch (ref.engine) {
    case "claude-code":
      return Effect.succeed(
        claudeCodeCompactor({
          device: o.device,
          effort,
          gate,
          instructions,
          log: o.log,
          model: ref.model,
          placement: o.placement,
          tools: o.settings.master.tools ?? MASTER_TOOLS,
          ttl: o.settings.cache.claudeCodeTtl,
        }),
      );
    case "openai-plan":
      return Effect.map(o.plan, (plan) => openAiPlanCompactor({ device: o.device, effort, gate, instructions, log: o.log, model: ref.model, plan, tools }));
    case "api-key":
      return Effect.map(providerOf(ref, o, effort), (provider) => apiKeyCompactor({ device: o.device, effort, gate, instructions, log: o.log, model: ref.model, provider, tools }));
  }
};

// The provider of an engine that has no loop of its own (SPEC "Engines": openai-plan, the Responses
// API on the ChatGPT plan, with `stream: true` and `store: false`; api-key, an API key's Anthropic
// or OpenAI), built from what the ref's engine needs. Our tool loop (../turn/loop.ts) runs it.
export const providerOf = (ref: ProviderRef, o: EngineNeeds, effort?: string): Effect.Effect<Provider> => {
  switch (ref.engine) {
    case "openai-plan":
      return Effect.map(o.plan, (plan) => responsesProvider({ auth: "chatgpt-pro", effort, engine: "openai-plan", model: ref.model, respond: plan.respond }));
    case "api-key":
      return Effect.map(o.apiKeys, (clients) => apiKeyProvider({ budget: o.budget, clients, effort, ref, settings: o.settings }));
  }
};

export const turnEngine = (ref: Ref, o: TurnNeeds): Effect.Effect<TurnEngine> => {
  const { permissionMode, tools } = o.settings.master;
  const effort = ref.effort ?? o.settings.master.effort; // the entry's own, else the master's
  switch (ref.engine) {
    case "claude-code":
      return claudeCodeTurn({
        effort,
        instructions: o.instructions,
        logUsage: o.log,
        model: ref.model,
        permissionMode,
        primeTtl: o.settings.cache.primeTtl,
        ref: ref.ref,
        report: o.report,
        runnerFor: o.runnerFor,
        tools: tools ?? MASTER_TOOLS,
        ttl: o.settings.cache.claudeCodeTtl,
        warms: o.warms,
      });
    case "openai-plan":
    case "api-key":
      // the plan's route is sent images only once that is known to work (SPEC "Media")
      return Effect.map(providerOf(ref, o, effort), (provider) =>
        toolLoop({ instructions: o.instructions, provider, ref: ref.ref, toolsFor: o.toolsFor, vision: ref.engine === "api-key" || mediaSettings(o.settings).planImages }),
      );
  }
};
