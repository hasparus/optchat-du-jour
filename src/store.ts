// The data dir on disk (gist §2, ref §3): two append-only JSONL streams split by local day,
// one write and one fsync per line, and a unix-socket lock that keeps a second writer out.
import { Data, Effect, Option, Schema } from "effect";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { dirname, resolve } from "node:path";
import { VIEW } from "./config.ts";
import { type Kind, Msg, Node } from "./records.ts";
import { bytes, dayOf, type Entry, type Mem, msgText, newMem, setNode } from "./tree.ts";
import { refold } from "./view.ts";

export class StoreError extends Data.TaggedError("StoreError")<{ readonly message: string }> {}
export class Locked extends Data.TaggedError("Locked")<{ readonly message: string }> {}

const io = <A>(what: string, f: () => A) =>
  Effect.try({
    catch: (error) => new StoreError({ message: `${what}: ${error instanceof Error ? error.message : String(error)}` }),
    try: f,
  });

// Records carry their keys in the order the reference writes them, so both write the same
// bytes: {i, kind, text, size, date} and {l, i, text, size}.
export const newMsg = (i: number, kind: Kind, text: string, date = new Date()): Entry => ({
  i,
  kind,
  text,
  size: bytes(msgText({ kind, text })),
  date: date.toISOString(),
});
export const newNode = (l: number, i: number, text: string) => ({ l, i, text, size: bytes(text) });

const fsyncPath = (path: string) => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

// one line, one write, then fsync; a new file also gets its directory entry synced
function appendLine(dir: string, file: string, line: string) {
  const made = mkdirSync(dir, { recursive: true }); // the first directory it had to create
  const path = `${dir}/${file}`, isNew = !existsSync(path);
  const fd = openSync(path, "a");
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (isNew) fsyncPath(dir);
  // directories made just now: their entries too
  if (made === undefined) return;
  const top = resolve(made);
  for (let p = resolve(dir); p.length >= top.length; p = dirname(p)) fsyncPath(dirname(p));
}

export const appendMessage = (dir: string, m: Entry) =>
  io(`cannot log message ${m.i}`, () => {
    appendLine(`${dir}/chat/main`, `${dayOf(new Date(m.date))}.jsonl`, `${JSON.stringify(m)}\n`);
  });

export const appendNode = (dir: string, n: Node, now = new Date()) =>
  io(`cannot save node (${n.l}, ${n.i})`, () => {
    appendLine(`${dir}/chat/tree`, `${dayOf(now)}.jsonl`, `${JSON.stringify(newNode(n.l, n.i, n.text))}\n`);
  });

export type Loaded = { readonly mem: Mem; readonly problems: readonly string[] };

// The decoded lines of one stream, oldest day first. A line that doesn't decode is listed in
// `problems` and skipped. An unterminated last line may be a write in progress: a reader leaves
// it alone, quietly unless it decodes; the lock holder (`repair`) ends it with a newline.
function readStream<A>(dir: string, stream: string, decode: (line: string) => Option.Option<A>, repair: boolean, problems: string[]) {
  const path = `${dir}/chat/${stream}`, out: A[] = [];
  if (!existsSync(path)) return out;
  for (const file of readdirSync(path).filter((f) => f.endsWith(".jsonl")).toSorted()) {
    const raw = readFileSync(`${path}/${file}`, "utf8");
    const lines = raw.split("\n");
    const torn = lines.pop() ?? ""; // "" when the file ends with a newline
    if (torn && repair) appendLine(path, file, "\n");
    for (const [k, line] of lines.entries()) {
      if (!line) continue;
      const rec = decode(line);
      if (Option.isSome(rec)) out.push(rec.value);
      else problems.push(`${stream}/${file}:${k + 1}: not a valid record, skipped`);
    }
    if (!torn) continue;
    const rec = decode(torn);
    if (Option.isSome(rec)) out.push(rec.value);
    else if (repair) problems.push(`${stream}/${file}:${lines.length + 1}: not a valid record, skipped`);
  }
  return out;
}

const decodeMsg = Schema.decodeUnknownOption(Schema.fromJsonString(Msg));
const decodeNode = Schema.decodeUnknownOption(Schema.fromJsonString(Node));

export const loadChat = (
  dir: string,
  o: { readonly budget?: number; readonly repair?: boolean; readonly view?: boolean } = {},
): Effect.Effect<Loaded, StoreError> =>
  Effect.gen(function* () {
    const problems: string[] = [], repair = o.repair ?? true;
    const msgs = yield* io(`cannot read ${dir}/chat/main`, () => readStream(dir, "main", decodeMsg, repair, problems));
    const recs = yield* io(`cannot read ${dir}/chat/tree`, () => readStream(dir, "tree", decodeNode, repair, problems));
    const mem = newMem(o.budget ?? VIEW);
    msgs.sort((a, b) => a.i - b.i);
    for (const [k, m] of msgs.entries()) {
      if (m.i !== k) {
        const what = m.i < k ? `message ${m.i} is logged twice` : `message ${k} is missing`;
        return yield* new StoreError({ message: `${dir}/chat/main: ${what}` });
      }
      mem.root.push({ ...m, size: bytes(msgText(m)) });
    }
    for (const n of recs) setNode(mem, n);
    if (o.view ?? true) refold(mem);
    return { mem, problems };
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
      server.unref(); // the lock alone never keeps the process alive
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
    const path = `${dir}/lock`;
    yield* io(`cannot create ${dir}`, () => mkdirSync(dir, { recursive: true }));
    if (yield* answers(path)) return yield* new Locked({ message: `another optchat is already running on ${dir}` });
    yield* io(`cannot remove the stale lock ${path}`, () => {
      if (existsSync(path)) unlinkSync(path);
    });
    return yield* Effect.acquireRelease(listen(path), release).pipe(Effect.asVoid);
  });
