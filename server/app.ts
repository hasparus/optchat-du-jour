// optchat-server (SPEC "Server, WebSocket API and CLI"): the memory, the compactor, the turn loop,
// and their HTTP face on one port: /ws (AG-UI, ./routes/ws.ts), /mcp (zoom and date over a
// WebSocket or POST, ./routes/mcp.ts), /api/* (read-only JSON, ./routes/api.ts) and / (the built
// web UI, ./routes/web.ts). This file builds the parts and hands them to the routes.
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Context, Effect, Layer, PubSub } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest } from "effect/http";
import { makeBudget } from "../src/apikey/budget.ts";
import { ApiKeys, apiKeysLayer } from "../src/apikey/clients.ts";
import { openChat } from "../src/chat.ts";
import { Runner } from "../src/claude/process.ts";
import { WarmLocalRunner } from "../src/claude/warm.ts";
import type { Summarize } from "../src/compactor.ts";
import { mediaSettings, type Settings } from "../src/config.ts";
import type { DownList } from "../src/engines/chain.ts";
import { makeGate } from "../src/engines/inflight.ts";
import { turnEngine } from "../src/engines/registry.ts";
import { forbidden, mount } from "../src/http.ts";
import { OpenAiPlan, openAiPlanLayer } from "../src/openai/responses.ts";
import { makeCaptioner } from "../src/media/caption.ts";
import { makeMedia } from "../src/media/media.ts";
import { makePersist } from "../src/persist.ts";
import { systemPrompt } from "../src/prompts.ts";
import { type Secrets, SecretsLive } from "../src/secrets.ts";
import { makeSession, type SessionEvent } from "../src/session.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { loadChoices, saveChoices, startingChoices } from "../src/choices.ts";
import { makeMaster } from "../src/master.ts";
import { type UsageRecord, logUsage } from "../src/usage.ts";
import { allowed, policyFor } from "./auth.ts";
import { makePlacements } from "./placement.ts";
import { apiRoutes } from "./routes/api.ts";
import { assetRoutes } from "./routes/assets.ts";
import { mcpRoutes } from "./routes/mcp.ts";
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
  readonly secrets?: Layer.Layer<Secrets>; // the plan's tokens and the API keys; SecretsLive unless a test says
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
      const { defsFor, runnerFor, toolsFor: toolsWith, unreachable } = yield* makePlacements({ device: o.device, local, port: o.port, report, secret, settings });
      // The session shows the compactor's engines that are down, for clients that connect later.
      // Compactions send a turn's system prompt and tools (docs/optchat.md §4): the default device's
      // on a provider, this machine's claude-code turn's on claude-code, which runs here.
      const compactor: { readonly down?: DownList; readonly summarize: Summarize } = o.summarize
        ? { summarize: o.summarize }
        : yield* makeSummarize({ ...needs, device: o.device, gate: makeGate(), instructions, placement: runnerFor(o.device), tools: defsFor(settings.defaultDevice) });
      const chat = yield* openChat(stream, { report, summarize: compactor.summarize });
      const toolsFor = (device: string) => toolsWith(device, chat.mem);
      // the master's chain as the session keeps it (src/master.ts), made here so each engine can
      // ask whether the warm processes follow it: the most recent turn's (E18)
      const master = yield* makeMaster(settings.master.chain.map((r) => r.ref), settings.master.effort);
      const choices = startingChoices({ followUp: settings.master.followUp }, yield* loadChoices(choicesPath, report));
      const engines = yield* Effect.forEach(settings.master.chain, (ref) =>
        turnEngine(ref, { ...needs, instructions, runnerFor, toolsFor, warms: () => master.latest() === ref.ref }),
      );
      // attachments: the shared asset store under the home, captions by their own chain (SPEC "Media")
      const mediaConfig = mediaSettings(settings);
      const captioner = makeCaptioner(mediaConfig.caption, { ...needs, device: o.device, planImages: mediaConfig.planImages, runner: local });
      const media = yield* makeMedia({ captioner, report, root: `${o.home}/assets`, settings: mediaConfig });
      // an upload no logged message names (a photo attached and never sent) is not committed
      const persist = yield* makePersist(report, () =>
        media.unreferenced(chat.mem.root.flatMap((e) => (e.kind === "user" ? [e.text] : []))).map((path) => `/assets/${path}`),
      );
      const session = yield* makeSession({
        chat,
        media,
        commit: Effect.suspend(() => persist(o.home, `chore(chat): ${chat.mem.root.length} messages`)),
        compactorDown: compactor.down,
        defaultDevice: settings.defaultDevice,
        devices: Object.keys(settings.devices),
        engines,
        events,
        choices,
        master,
        saveChoices: saveChoices(choicesPath, report),
        logUsage: usage,
      });
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

      yield* wsRoute(router, { assets: { find: media.find, report }, entries: chat.mem.root, session, thread: o.device, window: o.window ?? 200 });
      yield* mcpRoutes(router, { attached: media.zoomContent, mem: chat.mem, secret });
      yield* assetRoutes(router, { media, settings: mediaConfig });
      yield* apiRoutes(router, { device: o.device, mem: chat.mem, report, session, settings, usagePath });
      yield* webRoute(router, o.web);
      return { chat, session };
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
