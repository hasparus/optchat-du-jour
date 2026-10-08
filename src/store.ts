// The data dir on disk (gist §2, ref §3): two append-only JSONL streams split by local day,
// one write and one fsync per line; the view, replaced whole and atomically (gist 2026-10-08 §1,
// §3.2); and a unix-socket lock that keeps a second writer out.
import { Data, Effect, Option, Schema } from "effect";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { createServer, type Server, connect } from "node:net";
import { dirname, resolve } from "node:path";
import { type Kind, Msg, Node } from "./records.ts";
import { bytes, dayOf, type Entry, label, type Marks, type Mem, msgText, newMem, setNode } from "./tree.ts";
import { type Found, restore } from "./view.ts";

export class StoreError extends Data.TaggedError("StoreError")<{ readonly message: string }> {}
export class Locked extends Data.TaggedError("Locked")<{ readonly message: string }> {}

const io = <A>(what: string, f: () => A) =>
  Effect.try({
    catch: (error) => new StoreError({ message: `${what}: ${error instanceof Error ? error.message : String(error)}` }),
    try: f,
  });

// Records carry their keys in the order the reference writes them, so both write the same
// bytes: {i, kind, text, size, date} and {l, i, text, size}.
export function newMsg(i: number, kind: Kind, text: string, at: Date = new Date()): Entry {
  const size = bytes(msgText({ text, kind }));
  return { i, kind, text, size, date: at.toISOString() };
}
export function newNode(l: number, i: number, text: string) {
  const size = bytes(text);
  return { l, i, text, size };
}

// open a file, hand its descriptor to `body`, and close it whatever happens
function withFd<A>(path: string, flags: string, body: (fd: number) => A): A {
  const handle = openSync(path, flags);
  try {
    return body(handle);
  } finally {
    closeSync(handle);
  }
}
function fsyncPath(path: string) {
  withFd(path, "r", fsyncSync);
}

// all of data, in as many writes as the OS takes it in, then fsync
function writeAll(fd: number, data: Buffer, target: string) {
  let done = 0;
  while (done < data.length) {
    const wrote = writeSync(fd, data, done, data.length - done);
    if (wrote <= 0) throw new Error(`${target}: wrote ${done} of ${data.length} bytes`);
    done += wrote;
  }
  fsyncSync(fd);
}

// a directory made for a new file: it, and the entries of every directory made just now
function makeDir(dir: string) {
  const made = mkdirSync(dir, { recursive: true }); // the first directory it had to create
  return () => {
    if (made === undefined) return;
    const top = resolve(made);
    for (let p = resolve(dir); p.length >= top.length; p = dirname(p)) fsyncPath(dirname(p));
  };
}

// one line, one write (more only if the OS takes it in parts), then fsync; a new file also
// gets its directory entry synced
function appendLine(dir: string, file: string, line: string) {
  const synced = makeDir(dir);
  const target = `${dir}/${file}`, isNew = !existsSync(target);
  withFd(target, "a", (fd) => {
    writeAll(fd, Buffer.from(line, "utf8"), target);
  });
  if (isNew) fsyncPath(dir);
  synced();
}

export function appendMessage(dir: string, msg: Entry) {
  const file = `${dayOf(new Date(msg.date))}.jsonl`;
  return io(`cannot log message ${msg.i}`, () => {
    appendLine(`${dir}/chat/main`, file, `${JSON.stringify(msg)}\n`);
  });
}

export function appendNode(dir: string, record: Node, now = new Date()) {
  const line = `${JSON.stringify(newNode(record.l, record.i, record.text))}\n`;
  return io(`cannot save node ${label(record)}`, () => {
    appendLine(`${dir}/chat/tree`, `${dayOf(now)}.jsonl`, line);
  });
}

// The view (gist 2026-10-08 §1: "view.json, the view, as [l, i] pairs") beside the two streams,
// with whether a batch is still owed. Written whole whenever the view changes, after the log line
// that changed it: to a temp file, synced, renamed over the old one, the directory synced. A crash
// leaves the old view or the new, never half of one; and the log is ahead of it, never behind.
const VIEW_FILE = "view.json";
const ViewFile = Schema.Struct({ folding: Schema.Boolean, view: Schema.Array(Schema.Tuple([Schema.Int, Schema.Int])) });
const decodeView = Schema.decodeUnknownOption(Schema.fromJsonString(ViewFile));

export function saveView(dir: string, mem: Mem) {
  const folder = `${dir}/chat`, target = `${folder}/${VIEW_FILE}`, temp = `${target}.tmp`;
  const text = `${JSON.stringify({ folding: mem.folding, view: mem.view.map((c) => [c.l, c.i]) })}\n`;
  return io(`cannot save ${target}`, () => {
    const synced = makeDir(folder);
    withFd(temp, "w", (fd) => {
      writeAll(fd, Buffer.from(text, "utf8"), temp);
    });
    renameSync(temp, target);
    fsyncPath(folder);
    synced();
  });
}

// the saved view, or why there is none to use
function readView(dir: string): Found {
  const target = `${dir}/chat/${VIEW_FILE}`;
  if (!existsSync(target)) return { ok: false, why: "missing" };
  return Option.match(decodeView(readFileSync(target, "utf8")), {
    onNone: (): Found => ({ ok: false, why: "unreadable" }),
    onSome: (saved): Found => ({ ok: true, saved }),
  });
}

export type Loaded = { readonly mem: Mem; readonly problems: readonly string[] };

// a day file is named YYYY-MM-DD.jsonl (ref §3); nothing else in the directory is read
const DAY_FILE = /^[0-9]{4}(-[0-9]{2}){2}\.jsonl$/;

// The decoded lines of one stream, oldest day first. A line that doesn't decode is listed in
// `problems` and skipped. An unterminated last line may be a write in progress: a reader leaves
// it alone, quietly unless it decodes; the lock holder (`repair`) ends it with a newline.
function readStream<A>(dir: string, stream: string, decode: (line: string) => Option.Option<A>, repair: boolean, problems: string[]) {
  const folder = [dir, "chat", stream].join("/");
  const records: A[] = [];
  if (!existsSync(folder)) return records;
  const days = readdirSync(folder).filter((name) => DAY_FILE.test(name)).toSorted();
  for (const day of days) {
    const raw = readFileSync(`${folder}/${day}`, "utf8"), where = `${stream}/${day}`;
    if (repair && raw !== "" && !raw.endsWith("\n")) appendLine(folder, day, "\n");
    const lines = raw.split(/\n/);
    // the last piece is "" after a final newline, else a line whose write may still be going on
    for (const [k, line] of lines.entries()) {
      if (line === "") continue;
      const decoded = decode(line);
      if (Option.isSome(decoded)) {
        records.push(decoded.value);
        continue;
      }
      // an unfinished last line that doesn't decode is the writer's business, not a reader's
      const unfinished = k === lines.length - 1;
      if (repair || !unfinished) problems.push(`${where} line ${k + 1}: unreadable, ignored`);
    }
  }
  return records;
}

const decodeMsg = Schema.decodeUnknownOption(Schema.fromJsonString(Msg));
const decodeNode = Schema.decodeUnknownOption(Schema.fromJsonString(Node));

export const loadChat = (
  dir: string,
  o: { readonly marks?: Marks; readonly repair?: boolean; readonly view?: boolean } = {},
): Effect.Effect<Loaded, StoreError> =>
  Effect.gen(function* () {
    const { repair = true, view = true } = o;
    const skipped: string[] = [];
    const msgs = yield* io(`cannot read ${dir}/chat/main`, () => readStream(dir, "main", decodeMsg, repair, skipped));
    const recs = yield* io(`cannot read ${dir}/chat/tree`, () => readStream(dir, "tree", decodeNode, repair, skipped));
    const mem = newMem(o.marks);
    const byId = msgs.toSorted((x, y) => x.i - y.i);
    for (const [expected, logged] of byId.entries()) {
      if (logged.i !== expected) {
        const what = logged.i < expected ? `message ${logged.i} is logged twice` : `message ${expected} is missing`;
        return yield* new StoreError({ message: `${dir}/chat/main: ${what}` });
      }
      mem.root.push({ ...logged, size: bytes(msgText(logged)) });
    }
    for (const n of recs) setNode(mem, n);
    // a reader that wants the records only (an exporter, a check) skips the view
    if (!view) return { problems: skipped, mem };
    const found = yield* io(`cannot read ${dir}/chat/${VIEW_FILE}`, () => readView(dir));
    // a new chat has no view to save yet: its first message saves one
    const note = !found.ok && mem.root.length === 0 ? null : restore(mem, found);
    if (note === null) return { problems: skipped, mem };
    skipped.push(note);
    // only the lock holder writes; a reader keeps what it rebuilt to itself
    if (repair) yield* saveView(dir, mem);
    return { problems: skipped, mem };
  });

// Is something answering on the socket? A refused connection (its owner died) or no socket
// at all means no.
const answers = (path: string) =>
  Effect.callback<boolean, StoreError>((resume) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resume(Effect.succeed(true));
    });
    socket.once("error", (e: NodeJS.ErrnoException) => {
      socket.destroy();
      if (e.code === "ECONNREFUSED" || e.code === "ENOENT") resume(Effect.succeed(false));
      else resume(Effect.fail(new StoreError({ message: `cannot check the lock ${path}: ${e.message}` })));
    });
  });

const listen = (path: string) =>
  Effect.callback<Server, StoreError>((resume) => {
    const server = createServer((peer) => {
      peer.end();
    });
    server.once("error", (e) => {
      resume(Effect.fail(new StoreError({ message: `cannot take the lock ${path}: ${e.message}` })));
    });
    server.listen(path, () => {
      // holding a lock is no reason for the process to stay up
      server.unref();
      resume(Effect.succeed(server));
    });
  });

// closing the server also removes its socket file
const release = (server: Server) =>
  Effect.callback<undefined>((resume) => {
    server.close(() => {
      resume(Effect.undefined);
    });
  });

// gist §2 "One writer": hold `<dir>/lock` for the life of the scope. A socket that answers has
// a live owner; one that refuses connections is stale and is taken over.
export const lock = (dir: string) =>
  Effect.gen(function* () {
    const socket = `${dir}/lock`;
    yield* io(`cannot create ${dir}`, () => mkdirSync(dir, { recursive: true }));
    if (yield* answers(socket)) return yield* new Locked({ message: `another optchat is already running on ${dir}` });
    yield* io(`cannot remove the stale lock ${socket}`, () => {
      if (existsSync(socket)) unlinkSync(socket);
    });
    return yield* Effect.acquireRelease(listen(socket), release).pipe(Effect.asVoid);
  });
