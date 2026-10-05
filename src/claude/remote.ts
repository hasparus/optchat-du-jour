// A Runner on another machine (SPEC "Multi-machine", E7): the same Claude as LocalRunner gives,
// over the device runner's wire (./wire.ts), so events, results and the model read the same.
// Until the device says claude started, every failure is DeviceOffline, so the master's chain can
// move on at once (SPEC "Device offline": fail fast, never queue). Closing the scope closes the
// socket, and the device runner kills the process.
import { type Cause, Deferred, Duration, Effect, Option, Queue, Schema, Stream } from "effect";
import { Socket } from "effect/socket";
import { DeviceOffline } from "../engines/errors.ts";
import { ClaudeError, type Runner, type Spawn, makeClaude } from "./process.ts";
import { TOOL_TIMEOUT } from "../tools/files.ts";
import { Health, type ToDevice, type ToolCall, ToolReply, decodeFromDevice, frame, inbox } from "./wire.ts";

const CONNECT_TIMEOUT = "5 seconds"; // an asleep or unreachable peer on the tailnet hangs rather than refuses
const SPAWN_TIMEOUT = "15 seconds";

export const spawnUrl = (url: string) => {
  const u = new URL("/spawn", url);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.href;
};

// --system-prompt-file names a file on the server; the device gets the same bytes inline, so the
// system prompt, and with it the cache key, is identical on every device (SPEC "Turn and priming")
const inlineFiles = (args: readonly string[]) =>
  Effect.gen(function* () {
    const k = args.indexOf("--system-prompt-file");
    const path = args[k + 1];
    if (k === -1 || path === undefined) return [...args];
    const text = yield* Effect.tryPromise({
      catch: () => new ClaudeError({ message: `cannot read ${path}` }),
      try: async () => Bun.file(path).text(),
    });
    return [...args.slice(0, k), "--system-prompt", text, ...args.slice(k + 2)];
  });

export const remoteRunner = (device: string, url: string): Runner["Service"] => {
  const offline = (why: string) => new DeviceOffline({ message: `${device}: ${why}` });
  const spawn = Effect.fnUntraced(function* (o: Spawn) {
    const args = yield* inlineFiles(o.args);
    const socket = yield* Socket.makeWebSocket(spawnUrl(url), { openTimeout: CONNECT_TIMEOUT }).pipe(
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
    );
    const frames = yield* inbox(socket).pipe(Effect.mapError((e) => offline(`no device runner at ${url} (${e.message})`)));
    const write = yield* socket.writer;
    const send = (f: ToDevice) => write.write(frame(f));
    yield* send({ _tag: "Spawn", args, cwd: o.cwd, env: { ...o.env } }).pipe(Effect.mapError((e) => offline(e.message)));

    const ack = yield* Queue.take(frames).pipe(
      Effect.timeoutOption(SPAWN_TIMEOUT),
      Effect.mapError((e) => offline(`the device runner hung up before claude started (${e.message})`)),
    );
    if (Option.isNone(ack)) return yield* offline("no answer to the spawn request");
    const reply = decodeFromDevice(ack.value);
    if (Option.isSome(reply) && reply.value._tag === "Refused") return yield* offline(`refused: ${reply.value.message}`);
    if (Option.isNone(reply) || reply.value._tag !== "Spawned") return yield* offline("an unexpected answer to the spawn request");

    const stdin = yield* Queue.unbounded<string>();
    yield* Queue.take(stdin).pipe(
      Effect.flatMap((line) => send({ _tag: "Stdin", line })),
      Effect.forever,
      Effect.ignore,
      Effect.forkScoped,
    );
    // stdout lines until the Exit frame, or until the connection drops
    const lines = yield* Queue.unbounded<string, Cause.Done>();
    const ended = yield* Deferred.make<string>();
    const pump: Effect.Effect<string> = Effect.gen(function* () {
      for (;;) {
        const m = decodeFromDevice(yield* Queue.take(frames));
        if (Option.isNone(m)) continue;
        if (m.value._tag === "Line") yield* Queue.offer(lines, m.value.line);
        if (m.value._tag !== "Exit") continue;
        const { code, signal, stderr } = m.value;
        const err = stderr.trim().slice(-300) || "no error output";
        return `claude on ${device} ${code === null ? `was killed (${signal ?? "signal"})` : `exited (code ${code})`}: ${err}`;
      }
    }).pipe(Effect.catch((error) => Effect.succeed(`lost the connection to ${device}: ${error.message}`)));
    yield* pump.pipe(
      Effect.flatMap((why) => Deferred.succeed(ended, why)),
      Effect.andThen(Queue.end(lines)),
      Effect.forkScoped,
    );
    return yield* makeClaude({ exit: Deferred.await(ended), lines: Stream.fromQueue(lines), stdin });
  });
  return { spawn };
};

const decodeHealth = Schema.decodeUnknownEffect(Schema.fromJsonString(Health));

// a device runner's GET /health, None when it doesn't answer within `timeout`
export const deviceHealth = (url: string, timeout: Duration.Input) =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: async (signal) => {
      const response = await fetch(new URL("/health", url), { signal });
      return response.text();
    },
  }).pipe(Effect.flatMap(decodeHealth), Effect.timeout(timeout), Effect.option);

const decodeReply = Schema.decodeUnknownEffect(Schema.fromJsonString(ToolReply));

// One read-only tool call on a device runner (POST /tool, M5). An unreachable device or a refusal
// is the tool's answer, as text: the turn goes on and the model reads why.
export const remoteTool =
  (device: string, url: string) =>
  (name: string, input: Schema.Json): Effect.Effect<string> => {
    const call: ToolCall = { input, name };
    return Effect.tryPromise({
      catch: (cause) => cause,
      try: async (signal) => {
        const response = await fetch(new URL("/tool", url), { body: JSON.stringify(call), headers: { "content-type": "application/json" }, method: "POST", signal });
        if (!response.ok) throw new Error(`the device runner answered ${response.status}`);
        return response.text();
      },
    }).pipe(
      Effect.flatMap(decodeReply),
      Effect.map((r) => r.output),
      Effect.timeout(Duration.sum(Duration.fromInputUnsafe(TOOL_TIMEOUT), Duration.seconds(5))),
      Effect.catch((error) => Effect.succeed(`Error: ${device} did not run ${name}: ${error instanceof Error ? error.message : String(error)}`)),
    );
  };
