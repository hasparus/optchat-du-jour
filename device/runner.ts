// optchat-device (SPEC "Multi-machine", E7): runs `claude -p` on this machine when the server asks,
// inside the configured folders, and streams its events back over the wire in src/claude/wire.ts.
// A process lives exactly as long as its socket: a disconnect, the daemon's SIGTERM or the end of
// the request close its scope, which sends SIGTERM and then SIGKILL after KILL_GRACE (ref §5.2).
// It writes nothing of its own; claude's tools change files here, nothing else does. POST /tool
// runs one read-only tool (Read, Glob, Grep) in the same folders for an engine with its own tool
// loop (M5): never a shell, never a write.
import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Data, type Duration, Effect, FileSystem, Layer, Option, Queue, Ref, Schema, Stream } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";
import { claudeVersion } from "../src/claude/process.ts";
import { type FromDevice, type Health, ToolCall, type ToolReply, decodeToDevice, frame, inbox } from "../src/claude/wire.ts";
import { KILL_GRACE } from "../src/config.ts";
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

// what the server may set in claude's environment (cache TTL, DISABLE_PROMPT_CACHING); nothing that loads code
const ENV = /^(CLAUDE_CODE_|DISABLE_)[A-Z0-9_]*$/;
const FIRST_FRAME = "10 seconds";

// `cwd`'s real path when it is one of `folders` or inside one; symlinks and `..` are resolved first
export const confine = (cwd: string, folders: readonly string[]) =>
  confineTo(cwd, folders).pipe(Effect.mapError((e) => new SpawnRefused({ message: e.message })));

const signalOf = (message: string) => /'(SIG[A-Z0-9]+)'/.exec(message)?.[1] ?? null;

const forbidden = HttpServerResponse.text("forbidden", { status: 403 });
// HttpRouter.use, renamed: the React hooks rule takes any `use(` call for a hook
const mount = HttpRouter.use;

export const deviceRoutes = (o: DeviceOptions) =>
  mount((router) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const version = yield* Effect.cachedWithTTL(claudeVersion(o.claude), "10 minutes"); // claude updates itself
      const allowed = (request: HttpServerRequest.HttpServerRequest) => trusted(o.trust, request.remoteAddress);

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
          const odd = Object.keys(request.env).find((k) => !ENV.test(k));
          if (odd !== undefined) return yield* new SpawnRefused({ message: `${odd} is not passed to claude` });

          const stdin = yield* Queue.unbounded<string>();
          const handle = yield* spawner
            .spawn(
              ChildProcess.make(o.claude, [...request.args], {
                cwd,
                env: { ...request.env },
                extendEnv: true,
                forceKillAfter: o.killGrace ?? KILL_GRACE,
                killSignal: "SIGTERM",
                stdin: { encoding: "utf8", stream: Stream.fromQueue(stdin).pipe(Stream.encodeText) },
              }),
            )
            .pipe(Effect.mapError((e) => new SpawnRefused({ message: `cannot start claude: ${e.message}` })));
          yield* send({ _tag: "Spawned", pid: handle.pid });
          yield* Effect.logInfo(`claude ${handle.pid} in ${cwd}`);

          const stderr = yield* Ref.make("");
          yield* handle.stderr.pipe(
            Stream.decodeText(),
            Stream.runForEach((s) => Ref.update(stderr, (all) => (all + s).slice(-2000))),
            Effect.ignore,
            Effect.forkScoped,
          );
          // stdin lines until the server hangs up
          const hangup = Queue.take(frames).pipe(
            Effect.flatMap((f) =>
              Option.match(decodeToDevice(f), {
                onNone: () => Effect.void,
                onSome: (m) => (m._tag === "Stdin" ? Queue.offer(stdin, m.line) : Effect.void),
              }),
            ),
            Effect.forever,
            Effect.ignore,
          );
          // stdout lines until claude ends, then why it ended
          const output = handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) => send({ _tag: "Line", line })),
            Effect.andThen(handle.exitCode),
            Effect.map((code) => ({ code, signal: null })),
            Effect.catch((error) => Effect.succeed({ code: null, signal: signalOf(error.message) })),
            Effect.flatMap((exit) => Effect.flatMap(Ref.get(stderr), (tail) => send({ _tag: "Exit", ...exit, stderr: tail }))),
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

      // one read-only tool call (src/tools/files.ts). A browser page could POST here from anywhere
      // on the tailnet, so a request that carries an Origin is refused before anything else.
      const tools = yield* makeFileTools(o.folders);
      const decodeCall = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolCall));
      yield* router.add("POST", "/tool", (request) =>
        Effect.gen(function* () {
          if (request.headers.origin !== undefined || !(yield* allowed(request))) return forbidden;
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
