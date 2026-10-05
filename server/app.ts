// optchat-server (SPEC "Server, WebSocket API and CLI"): the memory, the compactor, the turn loop,
// and their HTTP face on one port: /ws (AG-UI), /mcp (zoom and date, over a WebSocket or POST),
// /api/* (read-only JSON for the web UI) and / (the built web UI).
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Context, Effect, Layer, Option, Predicate, PubSub, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import { existsSync } from "node:fs";
import { openChat } from "../src/chat.ts";
import type { Settings } from "../src/config.ts";
import { Runner, claudeBinary, claudeVersion } from "../src/claude/process.ts";
import { remoteRunner, remoteTool } from "../src/claude/remote.ts";
import { WarmLocalRunner } from "../src/claude/warm.ts";
import { makeBudget } from "../src/apikey/budget.ts";
import { ApiKeys, apiKeysLayer } from "../src/apikey/clients.ts";
import type { Summarize } from "../src/compactor.ts";
import type { DownList } from "../src/engines/chain.ts";
import { DeviceOffline } from "../src/engines/errors.ts";
import { turnEngine } from "../src/engines/registry.ts";
import { handleMcp, mcpConfig, mcpTransports, openNode } from "../src/mcp.ts";
import { forbidden, mount } from "../src/http.ts";
import { OpenAiPlan, openAiPlanLayer } from "../src/openai/responses.ts";
import { expandHome } from "../src/paths.ts";
import { makePersist } from "../src/persist.ts";
import { promptFile, systemPrompt } from "../src/prompts.ts";
import { makeSession, type SessionEvent } from "../src/session.ts";
import { type Secrets, SecretsLive } from "../src/secrets.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { getNode, localTime, span } from "../src/tree.ts";
import type { Placement } from "../src/turn/claude-code.ts";
import { toolBox } from "../src/tools/box.ts";
import { type FileTools, makeFileTools } from "../src/tools/files.ts";
import { type UsageRecord, logUsage, readUsage } from "../src/usage.ts";
import { PLACEHOLDER, render, viewSize } from "../src/view.ts";
import { type AgUiEvent, openStream } from "./agui.ts";
import { allowed, policyFor } from "./auth.ts";
import { deviceStatuses, versionWarning } from "./devices.ts";

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


// What a client sends: AG-UI's RunAgentInput (its user messages not seen before are the ones to answer), or an abort
const TextPart = Schema.Struct({ text: Schema.optional(Schema.String), type: Schema.String });
const InboundMessage = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TextPart)])),
  id: Schema.String,
  role: Schema.String,
});
const Inbound = Schema.Union([
  Schema.Struct({ type: Schema.Literal("abort") }),
  Schema.Struct({
    forwardedProps: Schema.optional(Schema.Struct({ device: Schema.optional(Schema.String) })),
    messages: Schema.Array(InboundMessage),
  }),
]);
const decodeInbound = Schema.decodeUnknownOption(Schema.fromJsonString(Inbound));

const textOf = ({ content = "" }: typeof InboundMessage.Type) => (Predicate.isString(content) ? content : content.map((p) => p.text ?? "").join(""));

// how many message ids a connection remembers
const SEEN = 1000;

// The user messages of each RunAgentInput on one connection that it has not sent before: a client
// that sends the whole history every time must not have old texts answered again. An id that is a
// log index names an entry the server sent (message ids are log indexes, server/agui.ts).
const unseen = (logged: () => number) => {
  const seen = new Set<string>();
  return (messages: readonly (typeof InboundMessage.Type)[]) =>
    messages.filter(({ id, role }) => {
      if (role !== "user" || seen.has(id) || (/^\d+$/.test(id) && Number(id) < logged())) return false;
      seen.add(id);
      for (const old of seen) {
        if (seen.size <= SEEN) break;
        seen.delete(old); // the oldest first
      }
      return true;
    });
};

const Before = Schema.Struct({ before: Schema.optional(Schema.NumberFromString), limit: Schema.optional(Schema.NumberFromString) });
// a node's level and index: integers, and a level whose span 2^l is still a safe integer
const NodeAt = Schema.Struct({
  i: Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  l: Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween({ maximum: 52, minimum: 0 })),
});
const json = (body: Schema.Json) => HttpServerResponse.jsonUnsafe(body);

export const routes = (o: ServerOptions) =>
  mount((router) =>
    Effect.gen(function* () {
      const { settings } = o;
      const usagePath = `${o.home}/usage.jsonl`;
      const stream = `${o.home}/streams/${o.device}`;
      const thread = o.device;
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
      // Where each device's claude runs (E7): this machine's own Runner, or that device's runner
      // over the tailnet. A claude elsewhere reaches /mcp through `tailscale serve` at
      // server.publicUrl (E8); without it, turns there are refused rather than handed the
      // loopback URL and its key, which no other machine can use. Each device dials /mcp over a
      // WebSocket until its claude is seen not to connect that way (E8).
      const transports = mcpTransports(settings.server?.mcpTransport ?? "ws", report);
      const place = (name: string, cwd: string | undefined, base: string, runner: Runner["Service"]) =>
        Effect.sync(
          (): Placement => ({
            cwd,
            mcpConfig: mcpConfig(`${base.replace(/\/$/, "")}/mcp?key=${secret}`, transports.of(name)),
            mcpSeen: (seen) => transports.seen(name, seen),
            runner,
          }),
        );
      const { publicUrl } = settings.server ?? {};
      const placements = new Map<string, Effect.Effect<Placement, DeviceOffline>>();
      const unreachable: string[] = [];
      for (const [name, d] of Object.entries(settings.devices)) {
        const folder = d.folders[0];
        if (name === o.device) placements.set(name, place(name, folder === undefined ? undefined : expandHome(folder), `http://127.0.0.1:${o.port}`, local));
        else if (publicUrl === undefined) {
          unreachable.push(name);
          placements.set(name, Effect.fail(new DeviceOffline({ message: `${name}: server.publicUrl is not set, so claude there could not reach zoom and date` })));
        } else placements.set(name, place(name, folder, publicUrl, remoteRunner(name, d.url))); // `~` is the device's home: it expands it
      }
      const runnerFor = (device: string) => placements.get(device) ?? Effect.fail(new DeviceOffline({ message: `${device} is not a configured device` }));
      // the read-only tools of an engine with its own loop (M5): this machine's in-process, another
      // device's over its runner's POST /tool, zoom and date from memory
      const localFiles = yield* makeFileTools(settings.devices[o.device]?.folders ?? []);
      const files = new Map<string, FileTools>(
        Object.entries(settings.devices).map(([name, d]) => [name, name === o.device ? localFiles : remoteTool(name, d.url)] as const),
      );
      const toolsFor = (device: string) =>
        toolBox({
          device,
          files: files.get(device) ?? ((name) => Effect.succeed(`Error: ${device} is not a configured device, so ${name} can't run`)),
          folders: settings.devices[device]?.folders ?? [],
          mem: chat.mem,
        });
      const engines = yield* Effect.forEach(settings.master.chain, (ref) => turnEngine(ref, { ...needs, instructions, runnerFor, systemFile, toolsFor }));
      const persist = yield* makePersist(report);
      const session = yield* makeSession({
        chat,
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

      yield* router.add("GET", "/ws", (request) =>
        Effect.gen(function* () {
          const socket = yield* request.upgrade;
          const write = yield* socket.writer;
          const send = (events: readonly AgUiEvent[]) => Effect.forEach(events, (e) => write.write(JSON.stringify(e)), { discard: true });
          const live = yield* PubSub.subscribe(session.events); // before the snapshot, so nothing falls between
          const { first, translate } = openStream({ entries: chat.mem.root, live: session.live(), state: session.state(), thread, window: o.window ?? 200 });
          yield* send(first);
          yield* session.primeSoon;
          yield* PubSub.take(live).pipe(
            Effect.flatMap((e) => send(translate(e))),
            Effect.forever,
            Effect.forkScoped,
          );
          const fresh = unseen(() => chat.mem.root.length);
          const pull = yield* Socket.readerString(socket);
          yield* pull.pipe(
            Effect.flatMap((frames) =>
              Effect.forEach(frames, (frame) =>
                Option.match(decodeInbound(frame), {
                  onNone: () => Effect.void,
                  onSome: (m) =>
                    "messages" in m
                      ? Effect.forEach(fresh(m.messages), (x) => session.input(textOf(x), m.forwardedProps?.device, x.id), { discard: true })
                      : session.cancel,
                }),
              ),
            ),
            Effect.forever,
            Effect.ignore, // the socket closed
          );
          return HttpServerResponse.empty();
        }).pipe(Effect.scoped, Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
      );

      // MCP (E8), over a WebSocket (a GET that upgrades) or one POST per message. tailscale serve
      // hides the peer, so the URL carries a secret, made at startup
      const keyed = (request: HttpServerRequest.HttpServerRequest) => new URL(request.url, "http://x").searchParams.get("key") === secret;
      yield* router.add("POST", "/mcp", (request) =>
        Effect.gen(function* () {
          if (!keyed(request)) return forbidden;
          const reply = handleMcp(chat.mem, yield* request.text);
          return reply.body === null
            ? HttpServerResponse.empty({ status: reply.status })
            : HttpServerResponse.text(reply.body, { contentType: "application/json", status: reply.status });
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
      );
      // one JSON-RPC message per text frame each way; Bun answers the "mcp" subprotocol claude asks for
      yield* router.add("GET", "/mcp", (request) =>
        Effect.gen(function* () {
          if (request.headers.upgrade?.toLowerCase() !== "websocket") return HttpServerResponse.empty({ status: 405 });
          if (!keyed(request)) return forbidden;
          const socket = yield* request.upgrade;
          const write = yield* socket.writer;
          const pull = yield* Socket.readerString(socket);
          yield* pull.pipe(
            Effect.flatMap((frames) =>
              Effect.forEach(
                frames,
                (frame) => {
                  const reply = handleMcp(chat.mem, frame);
                  return reply.body === null ? Effect.void : write.write(reply.body);
                },
                { discard: true },
              ),
            ),
            Effect.forever,
            Effect.ignore, // the socket closed
          );
          return HttpServerResponse.empty();
        }).pipe(Effect.scoped, Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
      );

      yield* router.add("GET", "/api/state", Effect.sync(() => json(session.state())));

      // the log, a page at a time, newest last; `before` is a message id
      yield* router.add("GET", "/api/messages", () =>
        Effect.gen(function* () {
          const q = yield* HttpServerRequest.schemaSearchParams(Before);
          const end = Math.min(q.before ?? chat.mem.root.length, chat.mem.root.length);
          const start = Math.max(0, end - (q.limit ?? 100));
          return json({ entries: chat.mem.root.slice(start, end), total: chat.mem.root.length });
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
      );

      // what the model sees: each view line with its range, dates and size (SPEC "Web UI", Memory)
      yield* router.add(
        "GET",
        "/api/view",
        Effect.sync(() =>
          json({
            budget: chat.mem.budget,
            lines: chat.mem.view.map((c) => {
              const node = getNode(chat.mem, c);
              const { n, id } = span(c);
              const from = chat.mem.root[id], to = chat.mem.root[id + n - 1];
              return {
                built: node !== undefined,
                from: from ? localTime(from.date) : null,
                id,
                l: c.l,
                i: c.i,
                n,
                size: node?.size ?? null,
                text: node?.text ?? PLACEHOLDER,
                to: to ? localTime(to.date) : null,
              };
            }),
            size: viewSize(chat.mem),
            text: render(chat.mem),
          }),
        ),
      );

      // one node and its two children, down to the message (the memory browser's zoom, as mcp.ts opens it)
      yield* router.add("GET", "/api/node", () =>
        Effect.gen(function* () {
          const { i, l } = yield* HttpServerRequest.schemaSearchParams(NodeAt);
          const { id, n } = span({ i, l });
          const found = openNode(chat.mem, id, n);
          if (!found) return HttpServerResponse.empty({ status: 404 });
          if ("message" in found) {
            const m = found.message;
            return json({ id, kind: m.kind, l, i, n, text: m.text, date: localTime(m.date) });
          }
          return json({
            children: found.halves.map((h) => ({ built: h.node !== undefined, i: h.at.i, l: h.at.l, text: h.node?.text ?? null })),
            id,
            l,
            i,
            n,
            text: found.node?.text ?? null,
          });
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
      );

      yield* router.add("GET", "/api/usage", Effect.sync(() => json(readUsage(usagePath))));
      // which devices answer and which claude they run (./devices.ts)
      const localVersion = yield* Effect.cachedWithTTL(claudeVersion(claudeBinary()), "10 minutes");
      let warned = "";
      yield* router.add(
        "GET",
        "/api/devices",
        Effect.gen(function* () {
          const list = yield* deviceStatuses({ devices: settings.devices, localVersion, self: o.device });
          const warning = versionWarning(list);
          if (warning && warning.key !== warned) {
            warned = warning.key;
            yield* report(warning.message);
          }
          return json(list);
        }),
      );

      // the built web UI; any other path is the app's (it has no router), except a missing file
      // under /assets/: a stale page asking for a chunk an old build had must fail, not get HTML
      if (o.web && existsSync(`${o.web}/index.html`)) {
        const { web } = o;
        yield* router.add("GET", "/*", (request) =>
          Effect.gen(function* () {
            const path = new URL(request.url, "http://x").pathname;
            const file = `${web}${path}`;
            const found = !path.includes("..") && path !== "/" && existsSync(file);
            if (!found && path.startsWith("/assets/")) return HttpServerResponse.empty({ status: 404 });
            return yield* HttpServerResponse.file(found ? file : `${web}/index.html`);
          }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 404 }))),
        );
      }
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
