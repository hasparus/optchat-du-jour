// optchat-device (SPEC "Multi-machine", E7): runs `claude -p` on this machine when the server asks,
// inside the configured folders, and streams its events back over the wire in src/claude/wire.ts.
// A process lives exactly as long as its socket: a disconnect, the daemon's SIGTERM or the end of
// the request close its scope, which sends SIGTERM and then SIGKILL after KILL_GRACE (ref §5.2).
// It writes nothing of its own; claude's tools change files here, nothing else does. POST /tool
// runs one read-only tool (Read, Glob, Grep) in the same folders for an engine with its own tool
// loop (M5): never a shell, never a write.
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Data, type Duration, Effect, FileSystem, Layer, Option, Queue, Schema, Stream } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import { claudeVersion, spawnProcess } from "../src/claude/process.ts";
import { type FromDevice, type Health, ToolCall, type ToolReply, decodeToDevice, frame, inbox } from "../src/claude/wire.ts";
import { KILL_GRACE } from "../src/config.ts";
import { forbidden, mount } from "../src/http.ts";
import { confine as confineTo, makeFileTools } from "../src/tools/files.ts";
import { type Trust, trusted } from "./auth.ts";

export type DeviceOptions = {
  readonly name: string;
  readonly folders: readonly string[]; // as configured; `~` is this machine's home
  readonly host: string; // the tailnet address; 127.0.0.1 in tests
  readonly port: number;
  readonly claude: string; // the binary; never a shell
  readonly trust: Trust;
  readonly killGrace?: Duration.Input; // KILL_GRACE
};

export class SpawnRefused extends Data.TaggedError("SpawnRefused")<{ readonly message: string }> {}

// what the server may set in claude's environment: exactly what a turn and its priming set (E6),
// so a turn behaves the same on every device. Not a security boundary: the caller also sends the
// argv, and a trusted caller drives a bypassPermissions claude anyway. Who may call is the boundary.
const ENV: ReadonlySet<string> = new Set(["CLAUDE_CODE_PROMPT_CACHE_TTL", "DISABLE_PROMPT_CACHING"]);
const FIRST_FRAME = "10 seconds";

// `cwd`'s real path when it is one of `folders` or inside one; symlinks and `..` are resolved first
export const confine = (cwd: string, folders: readonly string[]) =>
  confineTo(cwd, folders).pipe(Effect.mapError((e) => new SpawnRefused({ message: e.message })));

export const deviceRoutes = (o: DeviceOptions) =>
  mount((router) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const version = yield* Effect.cachedWithTTL(claudeVersion(o.claude), "10 minutes"); // claude updates itself
      // A browser sends an Origin with every WebSocket handshake and CORS request; the server's
      // RemoteRunner (Bun's WebSocket and fetch) sends none. Refused before WhoIs: a page open on an
      // allowed machine is that machine's node, too.
      const allowed = (request: HttpServerRequest.HttpServerRequest) =>
        request.headers.origin === undefined ? trusted(o.trust, request.remoteAddress) : Effect.succeed(false);

      // one claude for one socket
      const serve = (socket: Socket.Socket) =>
        Effect.gen(function* () {
          const write = yield* socket.writer;
          const send = (f: FromDevice) => write.write(frame(f));
          const frames = yield* inbox(socket);
          const first = yield* Queue.take(frames).pipe(
            Effect.timeoutOrElse({ duration: FIRST_FRAME, orElse: () => Effect.succeed("") }),
            Effect.map(decodeToDevice),
          );
          if (Option.isNone(first) || first.value._tag !== "Spawn")
            return yield* new SpawnRefused({ message: "the first frame must be a Spawn request" });
          const request = first.value;
          const cwd = yield* confine(request.cwd ?? o.folders[0] ?? "", o.folders).pipe(Effect.provideService(FileSystem.FileSystem, fs));
          const odd = Object.keys(request.env).find((k) => !ENV.has(k));
          if (odd !== undefined) return yield* new SpawnRefused({ message: `${odd} is not passed to claude` });

          const claude = yield* spawnProcess(o.claude, { args: request.args, cwd, env: request.env }, o.killGrace ?? KILL_GRACE).pipe(
            Effect.mapError((e) => new SpawnRefused({ message: e.message })),
          );
          yield* send({ _tag: "Spawned", pid: claude.pid });
          yield* Effect.logInfo(`claude ${claude.pid} in ${cwd}`);

          // stdin lines until the server hangs up
          const hangup = Queue.take(frames).pipe(
            Effect.flatMap((f) =>
              Option.match(decodeToDevice(f), {
                onNone: () => Effect.void,
                onSome: (m) => (m._tag === "Stdin" ? Queue.offer(claude.stdin, m.line) : Effect.void),
              }),
            ),
            Effect.forever,
            Effect.ignore,
          );
          // stdout lines until claude ends, then why it ended
          const output = claude.lines.pipe(
            Stream.ignore,
            Stream.runForEach((line) => send({ _tag: "Line", line })),
            Effect.andThen(claude.exit),
            Effect.flatMap((exit) => send({ _tag: "Exit", ...exit })),
            Effect.andThen(write.write(new Socket.CloseEvent(1000))),
            Effect.ignore,
          );
          yield* Effect.raceFirst(output, hangup);
        }).pipe(
          Effect.catchTag("SpawnRefused", (refused) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(`refused: ${refused.message}`);
              const write = yield* socket.writer;
              yield* write.write(frame({ _tag: "Refused", message: refused.message }));
              yield* write.write(new Socket.CloseEvent(1000));
            }),
          ),
          Effect.ignore,
          Effect.scoped, // the process dies with it
        );

      yield* router.add("GET", "/spawn", (request) =>
        Effect.gen(function* () {
          if (!(yield* allowed(request))) {
            yield* Effect.logWarning(`refused a caller at ${Option.getOrElse(request.remoteAddress, () => "an unknown address")}`);
            return forbidden;
          }
          yield* serve(yield* request.upgrade);
          return HttpServerResponse.empty();
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
      );

      // one read-only tool call (src/tools/files.ts), let in on the same terms as /spawn
      const tools = yield* makeFileTools(o.folders);
      const decodeCall = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCall));
      yield* router.add("POST", "/tool", (request) =>
        Effect.gen(function* () {
          if (!(yield* allowed(request))) return forbidden;
          const call = yield* decodeCall(yield* request.text);
          const reply: ToolReply = { output: yield* tools(call.name, call.input) };
          return HttpServerResponse.jsonUnsafe(reply);
        }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
      );

      yield* router.add("GET", "/health", (request) =>
        Effect.gen(function* () {
          if (!(yield* allowed(request))) return forbidden;
          const health: Health = { claudeVersion: yield* version, device: o.name, folders: [...o.folders] };
          return HttpServerResponse.jsonUnsafe(health);
        }),
      );
    }),
  );

export const deviceLayer = (o: DeviceOptions) =>
  HttpRouter.serve(deviceRoutes(o), { disableLogger: true }).pipe(
    // on SIGTERM, interrupt the open sockets (killing their claude) instead of waiting for them to end
    Layer.provide(BunHttpServer.layer({ disablePreemptiveShutdown: true, hostname: o.host, port: o.port })),
    Layer.provide(BunServices.layer),
  );
