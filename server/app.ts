// optchat-server (SPEC "Server, WebSocket API and CLI"): the memory, the compactor, the turn loop,
// and their HTTP face on one port: /ws (AG-UI), /mcp (zoom and date), /api/* (read-only JSON for
// the web UI) and / (the built web UI).
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Predicate, PubSub, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import { existsSync } from "node:fs";
import { openChat } from "../src/chat.ts";
import { type Settings, MASTER_TOOLS } from "../src/config.ts";
import { LocalRunner, Runner, claudeBinary, claudeVersion } from "../src/claude/process.ts";
import { remoteRunner, remoteTool } from "../src/claude/remote.ts";
import { makeBudget } from "../src/apikey/budget.ts";
import { ApiKeys, apiKeysLayer } from "../src/apikey/clients.ts";
import type { Summarize } from "../src/compactor.ts";
import { DeviceOffline } from "../src/engines/errors.ts";
import { handleMcp, mcpConfig } from "../src/mcp.ts";
import { forbidden, mount } from "../src/http.ts";
import { endpointsOf } from "../src/openai/auth.ts";
import { OpenAiPlan, openAiPlanLayer } from "../src/openai/responses.ts";
import { expandHome } from "../src/paths.ts";
import { makePersist } from "../src/persist.ts";
import { promptFile, systemPrompt } from "../src/prompts.ts";
import { makeSession } from "../src/session.ts";
import { type Secrets, SecretsLive } from "../src/secrets.ts";
import { makeSummarize } from "../src/summarize/index.ts";
import { children, getNode, localTime, span } from "../src/tree.ts";
import { type Placement, claudeCodeTurn } from "../src/turn/claude-code.ts";
import { toolBox } from "../src/tools/box.ts";
import { type FileTools, makeFileTools } from "../src/tools/files.ts";
import { apiKeyTurn } from "../src/turn/api-key.ts";
import type { TurnEngine } from "../src/turn/engine.ts";
import { openAiPlanTurn } from "../src/turn/openai-plan.ts";
import { type UsageRecord, logUsage, readUsage } from "../src/usage.ts";
import { PLACEHOLDER, render, viewSize } from "../src/view.ts";
import { type AgUiEvent, makeTranslator, snapshot } from "./agui.ts";
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


// What a client sends: AG-UI's RunAgentInput (the newest user message is the one to answer), or an abort
const TextPart = Schema.Struct({ text: Schema.optional(Schema.String), type: Schema.String });
const InboundMessage = Schema.Struct({ content: Schema.optional(Schema.Union([Schema.String, Schema.Array(TextPart)])), role: Schema.String });
const Inbound = Schema.Union([
  Schema.Struct({ type: Schema.Literal("abort") }),
  Schema.Struct({
    forwardedProps: Schema.optional(Schema.Struct({ device: Schema.optional(Schema.String) })),
    messages: Schema.Array(InboundMessage),
  }),
]);
const decodeInbound = Schema.decodeUnknownOption(Schema.fromJsonString(Inbound));

const lastUserText = (messages: readonly (typeof InboundMessage.Type)[]) => {
  const content = messages.findLast((x) => x.role === "user")?.content ?? "";
  return Predicate.isString(content) ? content : content.map((p) => p.text ?? "").join("");
};

const Before = Schema.Struct({ before: Schema.optional(Schema.NumberFromString), limit: Schema.optional(Schema.NumberFromString) });
const NodeAt = Schema.Struct({ i: Schema.NumberFromString, l: Schema.NumberFromString });

const logReport = (message: string) => Effect.logInfo(message);
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

      let report = logReport;
      // the api-key engine's monthly budget sees every record before usage.jsonl does
      const budget = makeBudget({ monthly: settings.apiKey?.monthlyBudget ?? 0, report: (m) => report(m), usagePath });
      const usage = (record: UsageRecord) =>
        budget.note(record).pipe(
          Effect.andThen(logUsage(usagePath, record)),
          Effect.flatMap((e) => (e ? report(e) : Effect.void)),
        );
      const clients = yield* ApiKeys;
      const summarize = o.summarize ?? (yield* makeSummarize({ apiKey: { budget, clients }, device: o.device, log: usage, report: (m) => report(m), settings }));
      const chat = yield* openChat(stream, { report: (m) => report(m), summarize });

      const instructions = systemPrompt(o.home); // one text for every engine and device (gist §7.2)
      const systemFile = yield* promptFile(instructions);
      // Where each device's claude runs (E7): this machine's own Runner, or that device's runner
      // over the tailnet. A claude elsewhere reaches /mcp through `tailscale serve` at
      // server.publicUrl (E8); without it, turns there are refused rather than handed the
      // loopback URL and its key, which no other machine can use.
      const mcpAt = (base: string) => mcpConfig(`${base.replace(/\/$/, "")}/mcp?key=${secret}`);
      const { publicUrl } = settings.server ?? {};
      const placements = new Map<string, Effect.Effect<Placement, DeviceOffline>>();
      const unreachable: string[] = [];
      for (const [name, d] of Object.entries(settings.devices)) {
        const folder = d.folders[0];
        if (name === o.device)
          placements.set(name, Effect.succeed({ cwd: folder === undefined ? undefined : expandHome(folder), mcpConfig: mcpAt(`http://127.0.0.1:${o.port}`), runner: local }));
        else if (publicUrl === undefined) {
          unreachable.push(name);
          placements.set(name, Effect.fail(new DeviceOffline({ message: `${name}: server.publicUrl is not set, so claude there could not reach zoom and date` })));
        } else placements.set(name, Effect.succeed({ cwd: folder, mcpConfig: mcpAt(publicUrl), runner: remoteRunner(name, d.url) })); // `~` is the device's home: it expands it
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
      const plan = yield* OpenAiPlan;
      const engines: TurnEngine[] = [];
      for (const ref of settings.master.chain) {
        const [engine, model = ""] = ref.split(/:(.*)/s);
        const { effort } = settings.master;
        if (engine === "openai-plan") engines.push(yield* openAiPlanTurn({ effort, instructions, model, toolsFor }).pipe(Effect.provideService(OpenAiPlan, plan)));
        if (engine === "api-key") engines.push(apiKeyTurn({ budget, clients, effort, instructions, ref, settings, toolsFor }));
        if (engine !== "claude-code") continue;
        engines.push(
          yield* claudeCodeTurn({
            effort: settings.master.effort,
            logUsage: usage,
            model,
            permissionMode: settings.master.permissionMode,
            primeTtl: settings.cache.primeTtl,
            report: (m) => report(m),
            runnerFor,
            systemFile,
            tools: settings.master.tools ?? MASTER_TOOLS,
            ttl: settings.cache.claudeCodeTtl,
          }),
        );
      }
      const persist = yield* makePersist;
      const session = yield* makeSession({
        chat,
        commit: Effect.suspend(() => persist(o.home, `chore(chat): ${chat.mem.root.length} messages`)),
        defaultDevice: settings.defaultDevice,
        devices: Object.keys(settings.devices),
        engines,
        logUsage: usage,
      });
      report = (message) => PubSub.publish(session.events, { message, type: "info" }).pipe(Effect.asVoid);
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
          const translate = makeTranslator(thread, session.state());
          yield* send(snapshot(chat.mem.root.slice(-(o.window ?? 200)), session.state()));
          yield* session.primeSoon;
          yield* PubSub.take(live).pipe(
            Effect.flatMap((e) => send(translate(e))),
            Effect.forever,
            Effect.forkScoped,
          );
          const pull = yield* Socket.readerString(socket);
          yield* pull.pipe(
            Effect.flatMap((frames) =>
              Effect.forEach(frames, (frame) =>
                Option.match(decodeInbound(frame), {
                  onNone: () => Effect.void,
                  onSome: (m) => ("messages" in m ? session.input(lastUserText(m.messages), m.forwardedProps?.device) : session.cancel),
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
              const { id, n } = span(c);
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

      // one node and its two children, down to the message (the memory browser's zoom)
      yield* router.add("GET", "/api/node", () =>
        Effect.gen(function* () {
          const { i, l } = yield* HttpServerRequest.schemaSearchParams(NodeAt);
          const { id, n } = span({ i, l });
          if (l === 0) {
            const m = chat.mem.root[i];
            return m ? json({ id, kind: m.kind, l, i, n, text: m.text, date: localTime(m.date) }) : HttpServerResponse.empty({ status: 404 });
          }
          return json({
            children: children({ i, l }).map((c) => {
              const half = getNode(chat.mem, c);
              return { built: half !== undefined, i: c.i, l: c.l, text: half?.text ?? null };
            }),
            id,
            l,
            i,
            n,
            text: getNode(chat.mem, { i, l })?.text ?? null,
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

export const serverLayer = (o: ServerOptions) => {
  const outside = Layer.mergeAll(o.secrets ?? SecretsLive, FetchHttpClient.layer);
  return HttpRouter.serve(routes(o)).pipe(
    Layer.provide(BunHttpServer.layer({ hostname: o.host, port: o.port })),
    Layer.provide(LocalRunner),
    Layer.provide(openAiPlanLayer(endpointsOf(o.settings.openai)).pipe(Layer.provide(outside))),
    Layer.provide(apiKeysLayer(o.settings.apiKey).pipe(Layer.provide(outside))),
    Layer.provide(BunServices.layer),
  );
};

