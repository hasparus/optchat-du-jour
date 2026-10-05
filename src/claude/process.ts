// A running `claude -p` (ref §4): stream-json user messages in, events out. The process belongs to
// the scope that spawned it; closing the scope sends SIGTERM, then SIGKILL after KILL_GRACE
// (ref §5.2). The Runner service decides where it runs: here, or on a device (E7).
import { Context, Data, Effect, Layer, Option, Queue, Ref, type Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { KILL_GRACE } from "../config.ts";
import { type Block, type Event, type Result, parseEvent } from "./events.ts";

export class ClaudeError extends Data.TaggedError("ClaudeError")<{ readonly message: string }> {}

export type Claude = {
  // one stream-json user message
  readonly send: (blocks: readonly Block[]) => Effect.Effect<void>;
  // the next event, None once the process closed its output
  readonly next: Effect.Effect<Option.Option<Event>>;
  // the next `result`; fails if the process ends first
  readonly result: Effect.Effect<Result, ClaudeError>;
  // the model the stream reports (init or message_start), for the usage log
  readonly model: () => string | undefined;
};

export type Spawn = {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
};

export class Runner extends Context.Service<
  Runner,
  { readonly spawn: (o: Spawn) => Effect.Effect<Claude, ClaudeError, Scope.Scope> }
>()("optchat/Runner") {}

const userMessage = (blocks: readonly Block[]) =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: blocks } })}\n`;

// wraps a process's stdin queue and stdout lines into a Claude; `exit` explains why output ended
export const makeClaude = Effect.fnUntraced(function* (o: {
  readonly stdin: Queue.Queue<string>;
  readonly lines: Stream.Stream<string, ClaudeError>;
  readonly exit: Effect.Effect<string>;
}) {
  const events = yield* Queue.unbounded<Option.Option<Event>>();
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
    model: () => current,
    next,
    result,
    send: (blocks) => Queue.offer(o.stdin, userMessage(blocks)).pipe(Effect.asVoid),
  } satisfies Claude;
});

// `claude` on this machine; OPTCHAT_CLAUDE names another binary (the tests' fake), read at spawn time
export const LocalRunner = Layer.effect(
  Runner,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const spawn = Effect.fnUntraced(function* (o: Spawn) {
      const stdin = yield* Queue.unbounded<string>();
      const command = ChildProcess.make(Bun.env.OPTCHAT_CLAUDE ?? "claude", [...o.args], {
        cwd: o.cwd,
        env: { ...o.env },
        extendEnv: true,
        forceKillAfter: KILL_GRACE,
        killSignal: "SIGTERM",
        stdin: { encoding: "utf8", stream: Stream.fromQueue(stdin).pipe(Stream.encodeText) },
      });
      const handle = yield* spawner
        .spawn(command)
        .pipe(Effect.mapError((e) => new ClaudeError({ message: `cannot start claude: ${e.message}` })));
      const stderr = yield* Ref.make("");
      yield* handle.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((s) => Ref.update(stderr, (all) => (all + s).slice(-2000))),
        Effect.ignore,
        Effect.forkScoped,
      );
      const exit = Effect.gen(function* () {
        const code = yield* handle.exitCode.pipe(Effect.orElseSucceed(() => -1));
        const err = (yield* Ref.get(stderr)).trim().slice(-300);
        return `claude exited (code ${code}): ${err || "no error output"}`;
      });
      const lines = handle.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.mapError((e) => new ClaudeError({ message: e.message })),
      );
      return yield* makeClaude({ exit, lines, stdin });
    });
    return { spawn };
  }),
);
