// A Runner on another machine (SPEC "Multi-machine", E7): the same Claude as LocalRunner gives,
// over the device runner's wire (./wire.ts), so events, results and the model read the same.
// Until the device says claude started, every failure is DeviceOffline, so the master's chain can
// move on at once (SPEC "Device offline": fail fast, never queue). Closing the scope closes the
// socket, and the device runner kills the process.
import { type Cause, Clock, Deferred, Duration, Effect, Option, Queue, Schema, Stream } from "effect";
import { Socket } from "effect/socket";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { DeviceOffline } from "../engines/errors.ts";
import { ClaudeError, type Runner, type Spawn, exitText, makeClaude } from "./process.ts";
import { Health, type ToDevice, decodeFromDevice, frame, inbox } from "./wire.ts";

export type RemoteTimeouts = {
  readonly connect: Duration.Input; // an asleep or unreachable peer on the tailnet hangs rather than refuses
  readonly spawn: Duration.Input; // from sending the Spawn frame to the Spawned frame
  readonly remember: Duration.Input; // how long an unreachable device stays offline without asking again
};
const TIMEOUTS: RemoteTimeouts = { connect: "5 seconds", remember: "5 seconds", spawn: "15 seconds" };

// `url` with its host resolved to an IPv4 address: the runner listens on `tailscale ip -4` only,
// and MagicDNS answers AAAA too, which the WebSocket might try first (SPEC "Multi-machine")
export const ipv4 = (url: string) =>
  Effect.gen(function* () {
    const u = new URL(url);
    if (isIP(u.hostname.replaceAll(/^\[|\]$/g, "")) !== 0) return u;
    const { address } = yield* Effect.tryPromise({
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      try: async () => lookup(u.hostname, { family: 4 }),
    });
    u.hostname = address;
    return u;
  });

export const spawnUrl = (base: URL) => {
  const u = new URL("/spawn", base);
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

export const remoteRunner = (device: string, url: string, timeouts: Partial<RemoteTimeouts> = {}): Runner["Service"] => {
  const t = { ...TIMEOUTS, ...timeouts };
  const offline = (why: string) => new DeviceOffline({ message: `${device}: ${why}` });
  // The last time the device could not be reached, and why. A turn's priming finds it offline,
  // and the turn right after it fails at once with the same verdict instead of waiting again.
  let unreachable: { readonly until: number; readonly error: DeviceOffline } | null = null;
  const remember = (error: DeviceOffline) =>
    Clock.currentTimeMillis.pipe(
      Effect.tap((now) => Effect.sync(() => (unreachable = { error, until: now + Duration.toMillis(Duration.fromInputUnsafe(t.remember)) }))),
      Effect.andThen(Effect.fail(error)),
    );

  const open = Effect.gen(function* () {
    const base = yield* ipv4(url).pipe(Effect.mapError((e) => offline(`cannot resolve ${url} (${e.message})`)));
    const socket = yield* Socket.makeWebSocket(spawnUrl(base), { openTimeout: t.connect }).pipe(
      Effect.provide(Socket.layerWebSocketConstructorGlobal),
    );
    // a WebSocket can't tell a closed port from a 403: either way, nothing to run claude here
    const frames = yield* inbox(socket).pipe(
      Effect.mapError((e) => offline(`no device runner at ${url}, or it doesn't let this machine in (${e.message})`)),
    );
    unreachable = null;
    return { frames, socket };
  }).pipe(Effect.catchTag("DeviceOffline", remember));
  const connect = Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => (unreachable && unreachable.until > now ? Effect.fail(unreachable.error) : open)),
  );

  const spawn = Effect.fnUntraced(function* (o: Spawn) {
    const args = yield* inlineFiles(o.args);
    const { frames, socket } = yield* connect;
    const write = yield* socket.writer;
    const send = (f: ToDevice) => write.write(frame(f));
    // a runner that hangs up, stalls or answers nonsense before Spawned is remembered as unreachable,
    // like a failed connect; a refusal is about this request (its cwd), so the next one still asks
    const reply = yield* Effect.gen(function* () {
      yield* send({ _tag: "Spawn", args, cwd: o.cwd, env: { ...o.env } }).pipe(Effect.mapError((e) => offline(e.message)));
      const ack = yield* Queue.take(frames).pipe(
        Effect.timeoutOption(t.spawn),
        Effect.mapError((e) => offline(`the device runner hung up before claude started (${e.message})`)),
      );
      if (Option.isNone(ack)) return yield* offline("no answer to the spawn request");
      const decoded = decodeFromDevice(ack.value);
      if (Option.isNone(decoded) || (decoded.value._tag !== "Spawned" && decoded.value._tag !== "Refused"))
        return yield* offline("an unexpected answer to the spawn request");
      return decoded.value;
    }).pipe(Effect.catchTag("DeviceOffline", remember));
    if (reply._tag === "Refused") return yield* offline(`refused: ${reply.message}`);

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
        if (m.value._tag === "Exit") return exitText(m.value, device);
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

// What a device runner's GET /health said: who it is and which claude it runs; `refused` when it
// answered 403, so it is up but doesn't let this machine in (its WhoIs names or this node's name
// are misconfigured); `offline` when nothing sensible came back within `timeout`.
export type DeviceHealth =
  | { readonly _tag: "online"; readonly health: Health }
  | { readonly _tag: "refused" }
  | { readonly _tag: "offline" };

export const deviceHealth = (url: string, timeout: Duration.Input): Effect.Effect<DeviceHealth> =>
  Effect.gen(function* () {
    const base = yield* ipv4(url);
    const response = yield* Effect.tryPromise(async (signal) => {
      const r = await fetch(new URL("/health", base), { signal });
      return { status: r.status, text: await r.text() };
    });
    if (response.status === 403) return { _tag: "refused" } as const;
    return { _tag: "online", health: yield* decodeHealth(response.text) } as const;
  }).pipe(
    Effect.timeout(timeout),
    Effect.orElseSucceed((): DeviceHealth => ({ _tag: "offline" })),
  );
