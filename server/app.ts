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
import { turnEngine } from "../src/engines/registry.ts";
import { forbidden, mount } from "../src/http.ts";
import { OpenAiPlan, openAiPlanLayer } from "../src/openai/responses.ts";
import { makeCaptioner } from "../src/media/caption.ts";
import { makeMedia } from "../src/media/media.ts";
import { makePersist } from "../src/persist.ts";
import { promptFile, systemPrompt } from "../src/prompts.ts";
import { type Secrets, SecretsLive } from "../src/secrets.ts";
import { makeSession, type SessionEvent } from "../src/session.ts";
import { makeSummarize } from "../src/summarize/index.ts";
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
        Layer.buildWithScope(apiKeysLayer(settings.apiKey).pipe(Layer.provide(outside)), scope).pipe(Effect.map((c) => Context.get(c, ApiKeys))),
      );
      const needs = { apiKeys, budget, log: usage, plan, report, settings };
      // the session shows the compactor's engines that are down, for clients that connect later
      const compactor: { readonly down?: DownList; readonly summarize: Summarize } = o.summarize
        ? { summarize: o.summarize }
        : yield* makeSummarize({ ...needs, device: o.device, runner: local });
      const chat = yield* openChat(stream, { report, summarize: compactor.summarize });

      const instructions = systemPrompt(o.home); // one text for every engine and device (gist §7.2)
      const systemFile = yield* promptFile(instructions);
      const { runnerFor, toolsFor, unreachable } = yield* makePlacements({ device: o.device, local, mem: chat.mem, port: o.port, report, secret, settings });
      const engines = yield* Effect.forEach(settings.master.chain, (ref, k) => turnEngine(ref, { ...needs, instructions, lead: k === 0, runnerFor, systemFile, toolsFor }));
      const persist = yield* makePersist(report);
      // attachments: the shared asset store under the home, captions by their own chain (SPEC "Media")
      const mediaConfig = mediaSettings(settings);
      const captioner = makeCaptioner(mediaConfig.caption, { ...needs, device: o.device, planImages: mediaConfig.planImages, runner: local });
      const media = yield* makeMedia({ captioner, report, root: `${o.home}/assets`, settings: mediaConfig });
      const session = yield* makeSession({
        chat,
        media,
        commit: Effect.suspend(() => persist(o.home, `chore(chat): ${chat.mem.root.length} messages`)),
        compactorDown: compactor.down,
        defaultDevice: settings.defaultDevice,
        devices: Object.keys(settings.devices),
        engines,
        events,
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

export const serverLayer = (o: ServerOptions) =>
  HttpRouter.serve(routes(o)).pipe(
    // on SIGTERM, open sockets (a web page's /ws) are closed at once instead of waited for
    Layer.provide(BunHttpServer.layer({ disablePreemptiveShutdown: true, hostname: o.host, port: o.port })),
    Layer.provide(WarmLocalRunner),
    Layer.provide(BunServices.layer),
  );
