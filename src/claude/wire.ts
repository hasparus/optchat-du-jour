// The device runner's wire (SPEC "Multi-machine", E7). One WebSocket per `claude` process, opened
// with `GET /spawn` (a WebSocket handshake is a GET, so SPEC's "POST /spawn" became this). Every
// frame is one JSON object with a `_tag`:
//
//   server → device   Spawn {args, env, cwd?}   the first frame, once
//                     Stdin {line}              one stream-json line for claude's stdin
//   device → server   Spawned {pid}             claude started; anything before this is "offline"
//                     Refused {message}         no claude for this request; the socket closes
//                     Line {line}               one line of claude's stdout
//                     Exit {code, signal, stderr}  claude ended (stderr's tail); the socket closes
//
// Closing the socket from the server's side kills the process.
//
// `POST /tool` runs one read-only tool (src/tools/files.ts) in the device's folders: a ToolCall in,
// a ToolReply out. A refused path, a missing file or a timeout is the reply's text, not an error.
import { Effect, Queue, Schema, type Scope } from "effect";
import { Socket } from "effect/socket";

export const Spawn = Schema.TaggedStruct("Spawn", {
  args: Schema.Array(Schema.String),
  env: Schema.Record(Schema.String, Schema.String),
  cwd: Schema.optional(Schema.String),
});
export const Stdin = Schema.TaggedStruct("Stdin", { line: Schema.String });
export const ToDevice = Schema.Union([Spawn, Stdin]);
export type ToDevice = typeof ToDevice.Type;

export const Spawned = Schema.TaggedStruct("Spawned", { pid: Schema.Number });
export const Refused = Schema.TaggedStruct("Refused", { message: Schema.String });
export const Line = Schema.TaggedStruct("Line", { line: Schema.String });
export const Exit = Schema.TaggedStruct("Exit", {
  code: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  stderr: Schema.String,
});
export const FromDevice = Schema.Union([Spawned, Refused, Line, Exit]);
export type FromDevice = typeof FromDevice.Type;

// GET /health
export const Health = Schema.Struct({
  device: Schema.String,
  claudeVersion: Schema.NullOr(Schema.String),
  folders: Schema.Array(Schema.String),
});
export type Health = typeof Health.Type;

// POST /tool
export const ToolCall = Schema.Struct({ name: Schema.String, input: Schema.Json });
export type ToolCall = typeof ToolCall.Type;
export const ToolReply = Schema.Struct({ output: Schema.String });
export type ToolReply = typeof ToolReply.Type;

export const decodeToDevice = Schema.decodeUnknownOption(Schema.fromJsonString(ToDevice));
export const decodeFromDevice = Schema.decodeUnknownOption(Schema.fromJsonString(FromDevice));

export const frame = (f: ToDevice | FromDevice) => JSON.stringify(f);

// the socket's text frames one at a time; `take` fails with the SocketError that ended them
export const inbox = (socket: Socket.Socket): Effect.Effect<Queue.Dequeue<string, Socket.SocketError>, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const pull = yield* Socket.readerString(socket);
    const queue = yield* Queue.unbounded<string, Socket.SocketError>();
    yield* pull.pipe(
      Effect.flatMap((batch) => Queue.offerAll(queue, batch)),
      Effect.forever,
      Effect.catch((error) => Queue.fail(queue, error)),
      Effect.forkScoped,
    );
    return queue;
  });
