// optchat-server (SPEC "Server, WebSocket API and CLI"): the memory, the compactor, the turn loop,
// and their HTTP face on one port: /ws (AG-UI, ./routes/ws.ts), /mcp (zoom and date over a
// WebSocket or POST, ./routes/mcp.ts), /api/* (JSON, ./routes/api.ts) and / (the built
// web UI, ./routes/web.ts). This file builds the parts and hands them to the routes.
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Context, Deferred, type Duration, Effect, Layer, PubSub } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import { makeBudget } from "../src/apikey/budget.ts";
import { ApiKeys, apiKeysLayer } from "../src/apikey/clients.ts";
import { openChat } from "../src/chat.ts";
import { Runner } from "../src/claude/process.ts";
import { WarmLocalRunner } from "../src/claude/warm.ts";
import type { Summarize } from "../src/compactor.ts";
import { artifactsLeftOut, openArtifacts } from "../src/artifacts/store.ts";
import { makeArtifactTools } from "../src/artifacts/tools.ts";
import { artifactSettings, entryLabel, mediaSettings, reasoningSettings, type Settings, subagentSettings, WAIT_RETRY, WAKE_DEBOUNCE } from "../src/config.ts";
import type { DownList } from "../src/engines/chain.ts";
import { makeGate } from "../src/engines/inflight.ts";
import { masterPolicy, subagentPolicy, turnEngine } from "../src/engines/registry.ts";
import { forbidden, mount } from "../src/http.ts";
import { OpenAiPlan, openAiPlanLayer } from "../src/openai/responses.ts";
import { makeCaptioner } from "../src/media/caption.ts";
import { makeMedia } from "../src/media/media.ts";
import { makePersist } from "../src/persist.ts";
import { systemPrompt } from "../src/prompts.ts";
import { openReasoning, reasoningLeftOut } from "../src/reasoning.ts";
import { type Secrets, SecretsLive } from "../src/secrets.ts";
import { makeSession, type SessionEvent } from "../src/session.ts";
import { makeSubagents, type SubagentHost, type Subagents } from "../src/subagents.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { loadChoices, saveChoices, startingChoices } from "../src/choices.ts";
import { makeMaster } from "../src/master.ts";
import type { Marks } from "../src/tree.ts";
import { type UsageRecord, logUsage } from "../src/usage.ts";
import { allowed, policyFor } from "./auth.ts";
import { makePlacements } from "./placement.ts";
import { watchMemory } from "./memory-feed.ts";
import { apiRoutes } from "./routes/api.ts";
import { artifactRoutes } from "./routes/artifacts.ts";
import { assetRoutes } from "./routes/assets.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { memoryRoutes } from "./routes/memory.ts";
import { webRoute } from "./routes/web.ts";
import { wsRoute } from "./routes/ws.ts";

export type ServerOptions = {
  readonly home: string; // ~/.optchat: streams/, usage.jsonl, instructions.md, its own git repo
  readonly settings: Settings;
  readonly device: string; // this machine
  readonly host: string;
  readonly port: number;
  readonly web?: string; // the built web UI
  readonly summarize?: Summarize; // tests replace the compactor
  readonly window?: number; // log entries in a client's first snapshot
  readonly heartbeat?: Duration.Input; // HEARTBEAT; tests make it short
  readonly secrets?: Layer.Layer<Secrets>; // the plan's tokens and the API keys; SecretsLive unless a test says
  readonly marks?: { readonly view: Marks; readonly compaction: Marks }; // the sawtooths' marks; tests make them small
};

export const routes = (o: ServerOptions) =>
  mount((router) =>
    Effect.gen(function* () {
      const { settings } = o;
      const usagePath = `${o.home}/usage.jsonl`;
      const choicesPath = `${o.home}/session.json`; // the clients' choices: follow-ups
      const stream = `${o.home}/streams/${o.device}`;
      const secret = crypto.randomUUID();
      const local = yield* Runner;

      // every client is told what goes wrong, and so is the server's own log (no client may be connected)
      const events = yield* PubSub.unbounded<SessionEvent>();
      const report = (message: string) => Effect.logInfo(message).pipe(Effect.andThen(PubSub.publish(events, { message, type: "info" })), Effect.asVoid);
      // the api-key engine's monthly budget sees every record before usage.jsonl does
      const budget = makeBudget({ monthly: settings.apiKey?.monthlyBudget ?? 0, report, usagePath });
      const usage = (record: UsageRecord) =>
        budget.note(record).pipe(
          Effect.andThen(logUsage(usagePath, record)),
          Effect.flatMap((e) => (e ? report(e) : Effect.void)),
        );
      // The ChatGPT plan's client and the API keys' clients, built on first use and then kept: a
      // server whose chains name neither engine, or whose compactor a test replaced, never builds
      // them. Built here so that a refresh token the plan can't save is told to the clients.
      const scope = yield* Effect.scope;
      const outside = Layer.mergeAll(o.secrets ?? SecretsLive, FetchHttpClient.layer);
      const plan = yield* Effect.cached(
        Layer.buildWithScope(openAiPlanLayer(settings.openai, { report }).pipe(Layer.provide(outside)), scope).pipe(Effect.map((c) => Context.get(c, OpenAiPlan))),
      );
      const apiKeys = yield* Effect.cached(
        Layer.buildWithScope(apiKeysLayer({ ...settings.apiKey, report }).pipe(Layer.provide(outside)), scope).pipe(Effect.map((c) => Context.get(c, ApiKeys))),
      );
      const needs = { apiKeys, budget, log: usage, plan, report, settings };
      const instructions = systemPrompt(o.home); // one text for every engine, device, turn and compaction (docs/optchat.md §5)
      const { agentRunnerFor, defsFor, folderFor, runnerFor, toolsFor: toolsWith, unreachable, worktrees } = yield* makePlacements({ device: o.device, local, port: o.port, report, secret, settings });
      // The session shows the compactor's engines that are down, for clients that connect later.
      // Compactions send a turn's system prompt and tools (docs/optchat.md §4): the default device's
      // on a provider, this machine's claude-code turn's on claude-code, which runs here.
      const compactor: { readonly down?: DownList; readonly summarize: Summarize } = o.summarize
        ? { summarize: o.summarize }
        : yield* makeSummarize({ ...needs, device: o.device, gate: makeGate(), instructions, placement: runnerFor(o.device), tools: defsFor(settings.defaultDevice) });
      // a failed call rests WAIT_RETRY before a logged entry tries it again (E33); the waiting turn's own retry doesn't wait
      const chat = yield* openChat(stream, { compactionMarks: o.marks?.compaction, marks: o.marks?.view, report, rest: WAIT_RETRY, summarize: compactor.summarize });
      // the view's lines as they change, to every client (E47): published as the memory changes, so
      // before what the session says after it
      const memory = yield* Effect.acquireRelease(
        Effect.sync(() => watchMemory(chat.mem, (e) => void PubSub.publishUnsafe(events, e))),
        (feed) => Effect.sync(feed.close),
      );
      // a turn's thinking, kept beside the log in the stream's chat/reasoning/ (SPEC "Reasoning")
      const thinking = reasoningSettings(settings);
      const reasoning = yield* openReasoning(stream, { keep: thinking.keep, report });
      // the master's chain as the session keeps it (src/master.ts), made here so each engine can
      // ask whether the warm processes follow it: the most recent turn's (E18)
      const master = yield* makeMaster(settings.master.chain.map((r) => ({ label: entryLabel(r, settings.master.effort), ref: r.ref })), settings.master.effort);
      const choices = startingChoices({ followUp: settings.master.followUp }, yield* loadChoices(choicesPath, report));
      // attachments: the shared asset store under the home, captions by their own chain (SPEC "Media")
      const mediaConfig = mediaSettings(settings);
      const captioner = makeCaptioner(mediaConfig.caption, { ...needs, device: o.device, planImages: mediaConfig.planImages, runner: local });
      const media = yield* makeMedia({ captioner, report, root: `${o.home}/assets`, settings: mediaConfig });
      // an upload no logged message names (a photo attached and never sent) is not committed, nor,
      // with reasoning.commit off, the thinking side files (git keeps those already committed)
      const persist = yield* makePersist(report, () => [
        ...media.unreferenced(chat.mem.root.flatMap((e) => (e.kind === "user" ? [e.text] : []))).map((path) => `/assets/${path}`),
        ...reasoningLeftOut(thinking.commit),
        ...artifactsLeftOut(artifactSettings(settings).commit),
      ]);
      // the artifacts the master and its subagents publish (SPEC "Artifacts"), beside the stream's
      // chat/; a saved version is told to every client
      const artifacts = yield* openArtifacts(stream, { report });
      const artifactTools = makeArtifactTools({
        artifacts,
        changed: (name, version) => PubSub.publish(events, { name, type: "artifact", version }).pipe(Effect.asVoid),
      });
      // The subagents (SPEC "Subagents"): they run where a master turn on their device runs, through
      // the engines a turn has, at the master's permissions and with its tools, artifacts' too (E36),
      // each with its own /mcp key and tool box, and need the session (for reports and the turn's
      // view), which needs their list: it is handed to them once it exists.
      const commit = Effect.suspend(() => persist(o.home, `chore(chat): ${chat.mem.root.length} messages`));
      const host = yield* Deferred.make<SubagentHost>();
      const agentSettings = subagentSettings(settings);
      const subagents: Subagents = yield* makeSubagents({
        chain: settings.master.chain,
        commit,
        device: o.device,
        devices: settings.devices,
        dir: stream,
        effort: settings.master.effort,
        // read when a run starts, long after `subagents` is set
        engine: (ref, at) =>
          turnEngine(
            ref,
            { ...needs, instructions, runnerFor: () => agentRunnerFor(at), toolsFor: (device) => toolsWith(device, chat.mem, subagents.tools({ agent: at.name }), artifactTools.tools({ agent: at.name })) },
            subagentPolicy(at.name),
          ),
        folderFor,
        host,
        logUsage: usage,
        max: agentSettings.max,
        mem: chat.mem,
        publish: (e) => PubSub.publish(events, e).pipe(Effect.asVoid),
        worktrees: (device) => worktrees.get(device),
      });
      const toolsFor = (device: string) => toolsWith(device, chat.mem, subagents.tools("master"), artifactTools.tools("master"));
      const engines = yield* Effect.forEach(settings.master.chain, (ref) =>
        turnEngine(ref, { ...needs, instructions, runnerFor, toolsFor }, masterPolicy(() => master.latest() === ref.ref)),
      );
      const session = yield* makeSession({
        chat,
        media,
        commit,
        compactorDown: compactor.down,
        defaultDevice: settings.defaultDevice,
        devices: Object.keys(settings.devices),
        engines,
        events,
        reasoning,
        choices,
        master,
        saveChoices: saveChoices(choicesPath, report),
        logUsage: usage,
        subagents,
        wake: agentSettings.wake ? WAKE_DEBOUNCE : null,
        wakeLimit: agentSettings.wakeLimit,
        artifactBase: (name) => artifacts.read(name).pipe(Effect.map((found) => found?.html ?? null), Effect.orElseSucceed(() => null)),
      });
      yield* Deferred.succeed(host, { lastView: session.lastView, report: session.report, turnNow: session.turnNow });
      yield* subagents.restore; // runs a restart cut short go on (E40); reports not delivered yet are sent
      for (const p of chat.problems) yield* report(p);
      if (unreachable.length > 0) {
        const notice = `server.publicUrl is not set: turns on ${unreachable.join(", ")} are refused, since claude there could not reach zoom and date`;
        yield* Effect.logWarning(notice);
        yield* report(notice);
      }

      // every request, on every route, passes the same check first (server/auth.ts has the threat model)
      const policy = policyFor(o.port, settings.allowedLogins, settings.server?.publicUrl);
      const guard = (request: HttpServerRequest.HttpServerRequest) =>
        allowed({ header: (name) => request.headers[name], remoteAddress: request.remoteAddress }, policy);
      yield* router.addGlobalMiddleware((handle) =>
        Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => (guard(request) ? handle : Effect.succeed(forbidden))),
      );

      yield* wsRoute(router, { assets: { find: media.find }, entries: chat.mem.root, heartbeat: o.heartbeat, session, subagents, thread: o.device, window: o.window ?? 200 });
      yield* mcpRoutes(router, { agents: subagents.tools, artifacts: artifactTools.tools, attached: media.zoomContent, callerOf: subagents.callerOf, mem: chat.mem, secret });
      yield* artifactRoutes(router, { artifacts });
      yield* assetRoutes(router, { media, settings: mediaConfig });
      yield* memoryRoutes(router, { mem: chat.mem, rev: memory.rev });
      yield* apiRoutes(router, { assets: { find: media.find }, device: o.device, mem: chat.mem, reasoning, report, session, settings, subagents, usagePath });
      yield* webRoute(router, o.web);
      return { artifacts, chat, session, subagents };
    }),
  );

// Bun refuses a request body over `maxRequestBodySize` (128 MiB unless set) with a 413 before any
// route runs: set from the media limits (an upload is the largest body), plus room for headers'
// sake, so raising media.maxVideoBytes is enough.
const MARGIN = 1024 * 1024;

export const serverLayer = (o: ServerOptions) =>
  HttpRouter.serve(routes(o)).pipe(
    // on SIGTERM, open sockets (a web page's /ws) are closed at once instead of waited for
    Layer.provide(
      BunHttpServer.layer({
        disablePreemptiveShutdown: true,
        hostname: o.host,
        maxRequestBodySize: Math.max(mediaSettings(o.settings).maxImageBytes, mediaSettings(o.settings).maxVideoBytes) + MARGIN,
        port: o.port,
      }),
    ),
    Layer.provide(WarmLocalRunner),
    Layer.provide(BunServices.layer),
  );
