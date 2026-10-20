// A running `claude -p` (ref §4): stream-json user messages in, events out. The process belongs to
// the scope that spawned it; closing the scope sends SIGTERM, then SIGKILL after KILL_GRACE
// (ref §5.2). The Runner service decides where it runs: here, or on a device (E7).
import { Context, Data, Deferred, type Duration, Effect, Fiber, Layer, Option, type PlatformError, Queue, Ref, type Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { KILL_GRACE } from "../config.ts";
import type { DeviceOffline } from "../engines/errors.ts";
import { wireJson } from "../text.ts";
import { type Block, type Event, type Result, parseEvent } from "./events.ts";

export class ClaudeError extends Data.TaggedError("ClaudeError")<{ readonly message: string }> {}

export type Claude = {
  // one stream-json user message
  readonly send: (blocks: readonly Block[]) => Effect.Effect<void>;
  // the next event, None once the process closed its output
  readonly next: Effect.Effect<Option.Option<Event>>;
  // the next `result`; fails if the process ends first
  readonly result: Effect.Effect<Result, ClaudeError>;
  // which model answered, for usage.jsonl: the init event names it, message_start too
  readonly model: () => string | undefined;
  // waits until its output has closed: the process ended (a warm process that died while idle)
  readonly ended: Effect.Effect<void>;
  // whether `ended` has resolved already
  readonly hasEnded: () => boolean;
};

export type Spawn = {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  // false: never kept warm, never handed a warm process (a compactor call, E18)
  readonly pooled?: boolean;
};

// DeviceOffline: a device runner could not be reached or would not start claude (SPEC "Device offline").
// `warm`: the spawns to expect next, for a Runner that keeps processes started ahead (./warm.ts);
// every other Runner ignores it.
export class Runner extends Context.Service<
  Runner,
  {
    readonly spawn: (o: Spawn) => Effect.Effect<Claude, ClaudeError | DeviceOffline, Scope.Scope>;
    readonly warm: (expected: readonly Spawn[]) => Effect.Effect<void>;
  }
>()("optchat/Runner") {}

// one stream-json line, its strings made well-formed (wireJson): this is what claude sends a model
const userMessage = (blocks: readonly Block[]) => `${wireJson({ message: { content: blocks, role: "user" }, type: "user" })}\n`;

// wraps a process's stdin queue and stdout lines into a Claude; `exit` explains why output ended
export const makeClaude = Effect.fnUntraced(function* (o: {
  readonly stdin: Queue.Queue<string>;
  readonly lines: Stream.Stream<string, ClaudeError>;
  readonly exit: Effect.Effect<string>;
}) {
  const events = yield* Queue.unbounded<Option.Option<Event>>();
  const closed = yield* Deferred.make<true>();
  let current: string | undefined;
  yield* o.lines.pipe(
    Stream.runForEach((line) =>
      Option.match(parseEvent(line), {
        onNone: () => Effect.void,
        onSome: (event) => {
          if (event.type === "system" && event.model) current = event.model;
          if (event.type === "stream_event" && event.event.type === "message_start" && event.event.message.model)
            current = event.event.message.model;
          return Queue.offer(events, Option.some(event));
        },
      }),
    ),
    Effect.ignore,
    Effect.andThen(Queue.offer(events, Option.none())),
    Effect.andThen(Deferred.succeed(closed, true)),
    Effect.forkScoped,
  );

  const next = Queue.take(events).pipe(
    Effect.tap((e) => (Option.isNone(e) ? Queue.offer(events, e) : Effect.void)), // stays ended for every later take
  );
  const result: Effect.Effect<Result, ClaudeError> = Effect.gen(function* () {
    for (;;) {
      const e = yield* next;
      if (Option.isNone(e)) return yield* new ClaudeError({ message: yield* o.exit });
      if (e.value.type === "result") return e.value;
    }
  });
  return {
    ended: Effect.asVoid(Deferred.await(closed)),
    hasEnded: () => Deferred.isDoneUnsafe(closed),
    model: () => current,
    next,
    result,
    send: (blocks) => Queue.offer(o.stdin, userMessage(blocks)).pipe(Effect.asVoid),
  } satisfies Claude;
});

// the binary a Runner on this machine spawns; OPTCHAT_CLAUDE names another (the tests' fake)
export const claudeBinary = () => Bun.env.OPTCHAT_CLAUDE ?? "claude";

// `claude --version`, e.g. "2.1.3 (Claude Code)"; null when it can't be run (SPEC "Multi-machine", /health)
export const claudeVersion = (binary: string) =>
  ChildProcessSpawner.ChildProcessSpawner.use((spawner) => spawner.string(ChildProcess.make(binary, ["--version"], { stdin: "ignore" }))).pipe(
    Effect.timeout("10 seconds"),
    Effect.map((out) => out.trim() || null),
    Effect.orElseSucceed(() => null),
  );

// What a `claude` must never inherit (E34): with one of these set, Claude Code bills that API key
// or cloud account instead of the Max login (keys, tokens, Bedrock, Vertex, Foundry and their
// settings), sends the login's requests to another host (the base URLs), or reads a ref's model as
// another (the default-model overrides: our refs name the model, and turns, priming and compactor
// calls must stay byte-identical across devices). A stray export in the shell or launchd plist of
// the server or a device is enough. CLAUDE_CODE_OAUTH_TOKEN stays: it is the Max login itself,
// from `claude setup-token`. Every spawn of claude goes through spawnProcess (turns, priming,
// compactor calls, captions, subagents, the warm processes and the device runner), so this is the
// one place they are dropped.
export const STRIPPED_ENV: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
]);

// a child's environment: this process's, without STRIPPED_ENV, then the spawn's own on top (the
// cache settings a turn and its priming set; never one of those)
export const childEnv = (parent: Readonly<Record<string, string | undefined>>, own: Readonly<Record<string, string>>) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) if (v !== undefined && !STRIPPED_ENV.has(k)) env[k] = v;
  for (const [k, v] of Object.entries(own)) if (!STRIPPED_ENV.has(k)) env[k] = v;
  return env;
};

// how a process ended: its exit code, or the signal that killed it, and the tail of its stderr
export type Exited = { readonly code: number | null; readonly signal: string | null; readonly stderr: string };

export type Process = {
  readonly pid: number;
  readonly stdin: Queue.Queue<string>; // lines for its stdin, each ending in a newline
  readonly lines: Stream.Stream<string, ClaudeError>; // its stdout, a line at a time
  readonly exit: Effect.Effect<Exited>; // waits for it to end
};

const STDERR_TAIL = 2000;

// The spawner reports a signal only in the text of the Error under the PlatformError exitCode
// fails with ("Process interrupted due to receipt of signal: 'SIGKILL'"); this is the one place
// that reads it.
const signalOf = (e: PlatformError.PlatformError) => {
  const text = e.reason.cause instanceof Error ? e.reason.cause.message : e.message;
  return /'(SIG[A-Z0-9]+)'/.exec(text)?.[1] ?? "a signal";
};

// One process of `binary`, never through a shell, in its own process group. It belongs to the
// calling scope: closing it sends SIGTERM to the group, then SIGKILL after `killGrace` (ref §5.2).
// Used for claude on this machine (LocalRunner) and on a device (device/runner.ts).
export const spawnProcess = Effect.fnUntraced(function* (binary: string, o: Spawn, killGrace: Duration.Input) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const stdin = yield* Queue.unbounded<string>();
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(binary, [...o.args], {
        cwd: o.cwd,
        env: childEnv(process.env, o.env),
        extendEnv: false, // childEnv has this process's environment already, minus what bills elsewhere (E34)
        forceKillAfter: killGrace,
        killSignal: "SIGTERM",
        stdin: { encoding: "utf8", stream: Stream.fromQueue(stdin).pipe(Stream.encodeText) },
      }),
    )
    .pipe(Effect.mapError((e) => new ClaudeError({ message: `cannot start ${binary}: ${e.message}` })));
  const stderr = yield* Ref.make("");
  const reader = yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((s) => Ref.update(stderr, (all) => (all + s).slice(-STDERR_TAIL))),
    Effect.ignore,
    Effect.forkScoped,
  );
  const exit: Effect.Effect<Exited> = Effect.gen(function* () {
    const ended = yield* handle.exitCode.pipe(
      Effect.map((code): Pick<Exited, "code" | "signal"> => ({ code, signal: null })),
      Effect.catch((error) => Effect.succeed({ code: null, signal: signalOf(error) })),
    );
    yield* Fiber.join(reader).pipe(Effect.timeout("1 second"), Effect.ignore); // what it wrote last; a grandchild may hold stderr open
    return { ...ended, stderr: yield* Ref.get(stderr) };
  });
  const lines = handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.mapError((e) => new ClaudeError({ message: e.message })),
  );
  return { exit, lines, pid: handle.pid, stdin } satisfies Process;
});

// why a claude ended, for the error a turn reports; `where` names the device it ran on
export const exitText = (e: Exited, where?: string) => {
  const who = where === undefined ? "claude" : `claude on ${where}`;
  const how = e.code === null ? `was killed (${e.signal ?? "a signal"})` : `exited (code ${e.code})`;
  return `${who} ${how}: ${e.stderr.trim().slice(-300) || "no error output"}`;
};

// `claude` on this machine, read at spawn time
export const LocalRunner = Layer.effect(
  Runner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawn = (o: Spawn) =>
      spawnProcess(claudeBinary(), o, KILL_GRACE).pipe(
        Effect.flatMap((p) => makeClaude({ exit: Effect.map(p.exit, (e) => exitText(e)), lines: p.lines, stdin: p.stdin })),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    return { spawn, warm: () => Effect.void };
  }),
);
