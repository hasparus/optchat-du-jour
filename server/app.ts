// optchat-server (SPEC "Server, WebSocket API and CLI"): the memory, the compactor, the turn loop,
// and their HTTP face on one port: /ws (AG-UI), /mcp (zoom and date), /api/* (read-only JSON for
// the web UI) and / (the built web UI).
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Predicate, PubSub, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { openChat } from "../src/chat.ts";
import { type Settings, MASTER_TOOLS } from "../src/config.ts";
import { LocalRunner, Runner } from "../src/claude/process.ts";
import type { Summarize } from "../src/compactor.ts";
import { DeviceOffline } from "../src/engines/errors.ts";
import { handleMcp, mcpConfig, openNode } from "../src/mcp.ts";
import { makePersist } from "../src/persist.ts";
import { promptFile, systemPrompt } from "../src/prompts.ts";
import { makeSession, type SessionEvent } from "../src/session.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { getNode, localTime, span } from "../src/tree.ts";
import { claudeCodeTurn } from "../src/turn/claude-code.ts";
import type { TurnEngine } from "../src/turn/engine.ts";
import { type UsageRecord, logUsage, readUsage } from "../src/usage.ts";
import { PLACEHOLDER, render, viewSize } from "../src/view.ts";
import { type AgUiEvent, openStream } from "./agui.ts";
import { allowed, policyFor } from "./auth.ts";

export type ServerOptions = {
  readonly home: string; // ~/.optchat: streams/, usage.jsonl, instructions.md, its own git repo
  readonly settings: Settings;
  readonly device: string; // this machine
  readonly host: string;
  readonly port: number;
  readonly web?: string; // the built web UI
  readonly summarize?: Summarize; // tests replace the compactor
  readonly window?: number; // log entries in a client's first snapshot
};

const expand = (path: string) => path.replace(/^~(?=\/|$)/, homedir());

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
const forbidden = HttpServerResponse.text("forbidden", { status: 403 });
const json = (body: Schema.Json) => HttpServerResponse.jsonUnsafe(body);
// HttpRouter.use, renamed: the React hooks rule takes any `use(` call for a hook
const mount = HttpRouter.use;

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
      const usage = (record: UsageRecord) => logUsage(usagePath, record).pipe(Effect.flatMap((e) => (e ? report(e) : Effect.void)));
      const summarize = o.summarize ?? (yield* makeSummarize({ device: o.device, log: usage, report, settings }));
      const chat = yield* openChat(stream, { report, summarize });

      const systemFile = yield* promptFile(systemPrompt(o.home));
      const mcp = mcpConfig(`http://127.0.0.1:${o.port}/mcp?key=${secret}`);
      const runnerFor = (device: string) =>
        device === o.device
          ? Effect.succeed({ cwd: settings.devices[device]?.folders[0] ? expand(settings.devices[device].folders[0]) : undefined, runner: local })
          : Effect.fail(new DeviceOffline({ message: `${device} has no device runner yet` }));
      const engines: TurnEngine[] = [];
      for (const ref of settings.master.chain) {
        const [engine, model = ""] = ref.split(/:(.*)/s);
        if (engine !== "claude-code") continue;
        engines.push(
          yield* claudeCodeTurn({
            effort: settings.master.effort,
            logUsage: usage,
            mcpConfig: mcp,
            model,
            permissionMode: settings.master.permissionMode,
            primeTtl: settings.cache.primeTtl,
            report,
            runnerFor,
            systemFile,
            tools: settings.master.tools ?? MASTER_TOOLS,
            ttl: settings.cache.claudeCodeTtl,
          }),
        );
      }
      const persist = yield* makePersist(report);
      const session = yield* makeSession({
        chat,
        commit: Effect.suspend(() => persist(o.home, `chore(chat): ${chat.mem.root.length} messages`)),
        defaultDevice: settings.defaultDevice,
        devices: Object.keys(settings.devices),
        engines,
        events,
        logUsage: usage,
      });
      for (const p of chat.problems) yield* report(p);

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

      // MCP over HTTP (E8). tailscale serve hides the peer, so the URL carries a secret, made at startup
      yield* router.add("POST", "/mcp", (request) =>
        Effect.gen(function* () {
          if (new URL(request.url, "http://x").searchParams.get("key") !== secret) return forbidden;
          const reply = handleMcp(chat.mem, yield* request.text);
          return reply.body === null
            ? HttpServerResponse.empty({ status: reply.status })
            : HttpServerResponse.text(reply.body, { contentType: "application/json", status: reply.status });
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
      );
      yield* router.add("GET", "/mcp", HttpServerResponse.empty({ status: 405 }));

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
      yield* router.add(
        "GET",
        "/api/devices",
        Effect.sync(() => json(Object.entries(settings.devices).map(([name, d]) => ({ folders: d.folders, local: name === o.device, name, url: d.url })))),
      );

      // the built web UI; any other path is the app's (it has no router)
      if (o.web && existsSync(`${o.web}/index.html`)) {
        const { web } = o;
        yield* router.add("GET", "/*", (request) =>
          Effect.gen(function* () {
            const path = new URL(request.url, "http://x").pathname;
            const file = `${web}${path}`;
            const found = !path.includes("..") && path !== "/" && existsSync(file);
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
    Layer.provide(LocalRunner),
    Layer.provide(BunServices.layer),
  );

