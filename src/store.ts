// Storage (gist §2): two append-only JSONL streams split by local day, one write + fsync per
// line, torn-line repair at load, and a unix-socket lock for the life of the process. One
// stream dir (E3: streams/<device>/) is a data dir the reference can read as it is.
import { Data, Effect, Option, Schema } from "effect";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { type Kind, Msg, Node } from "./records.ts";
import { bytes, dayOf, type Entry, type Mem, msgText, newMem, setNode } from "./tree.ts";
import { refold } from "./view.ts";

export class StoreError extends Data.TaggedError("StoreError")<{ readonly message: string }> {}
export class Locked extends Data.TaggedError("Locked")<{ readonly message: string }> {}

const fail = (e: unknown) => new StoreError({ message: e instanceof Error ? e.message : String(e) });

function write(path: string, text: string) {
  const buf = Buffer.from(text);
  const isNew = !existsSync(path);
  const fd = openSync(path, "a");
  try {
    if (writeSync(fd, buf) !== buf.length) throw new Error(`short write to ${path}`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!isNew) return;
  const d = openSync(path.slice(0, path.lastIndexOf("/")), "r"); // the new file's directory entry is durable too
  try {
    fsyncSync(d);
  } finally {
    closeSync(d);
  }
}

const append = (dir: string, stream: "main" | "tree", when: Date, record: object) =>
  Effect.try({
    catch: fail,
    try: () => {
      mkdirSync(`${dir}/chat/${stream}`, { recursive: true });
      write(`${dir}/chat/${stream}/${dayOf(when)}.jsonl`, `${JSON.stringify(record)}\n`);
    },
  });

export const appendMessage = (dir: string, m: Entry) => append(dir, "main", new Date(m.date), m);
export const appendNode = (dir: string, n: Node, now = new Date()) => append(dir, "tree", now, n);

// in the reference's field order, so both write the same bytes
/* oxlint-disable perfectionist/sort-objects */
export const newMsg = (i: number, kind: Kind, text: string, date = new Date()): Entry => ({
  i,
  kind,
  text,
  size: bytes(msgText({ kind, text })),
  date: date.toISOString(),
});
export const newNode = (l: number, i: number, text: string): Node => ({ l, i, text, size: bytes(text) });
/* oxlint-enable perfectionist/sort-objects */

const parse = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

// every record of one stream; bad lines are skipped and listed in `problems`. Only the lock holder
// (repair) gives a file without a final newline one; a reader can't tell a torn last line from a
// write in progress, so it stays quiet about it.
function readStream<A>(
  dir: string,
  stream: "main" | "tree",
  decode: (u: unknown) => Option.Option<A>,
  problems: string[],
  repair: boolean,
): A[] {
  const folder = `${dir}/chat/${stream}`;
  if (!existsSync(folder)) return [];
  const out: A[] = [];
  for (const f of readdirSync(folder).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
    const path = `${folder}/${f}`, text = readFileSync(path, "utf8"), lines = text.split("\n");
    const open = text !== "" && !text.endsWith("\n");
    for (const [n, line] of lines.entries()) {
      if (!line) continue;
      const record = decode(parse(line));
      if (Option.isSome(record)) out.push(record.value);
      else if (repair || !open || n < lines.length - 1) problems.push(`${stream}/${f}:${n + 1}: not a valid record, skipped`);
    }
    if (repair && open) write(path, "\n");
  }
  return out;
}

const decodeMsg = Schema.decodeUnknownOption(Msg);
const decodeNode = Schema.decodeUnknownOption(Node);

export type Loaded = { readonly mem: Mem; readonly problems: readonly string[] };

// The chat in memory with its view folded; fails unless the message ids are 0, 1, 2, ...
// `repair: false` for readers (view, browse, the MCP endpoint): they never write. `view: false`
// skips the fold.
export const loadChat = (dir: string, o: { budget?: number; repair?: boolean; view?: boolean } = {}) =>
  Effect.try({
    catch: fail,
    try: (): Loaded => {
      const mem = newMem(o.budget), problems: string[] = [], repair = o.repair ?? true;
      const msgs = readStream(dir, "main", decodeMsg, problems, repair).sort((a, b) => a.i - b.i);
      for (const [k, m] of msgs.entries()) {
        if (m.i !== k) throw new Error(`chat/main: expected message ${k}, found ${m.i}`);
        mem.root.push({ ...m, size: bytes(msgText(m)) });
      }
      for (const n of readStream(dir, "tree", decodeNode, problems, repair)) setNode(mem, n);
      if (o.view ?? true) refold(mem);
      return { mem, problems };
    },
  });

// One writer per stream (gist §2): listen on `lock` for as long as the scope lives. A socket that
// answers means a live owner; one that refuses connections was left by a dead one and is taken over.
export const lock = (dir: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({ catch: (e) => (e instanceof Locked ? e : fail(e)), try: async () => listenOrTakeOver(dir) }),
    (server) =>
      Effect.sync(() => {
        server.close();
      }),
  );

async function listenOrTakeOver(dir: string): Promise<Server> {
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/lock`;
  const listen = async () =>
    new Promise<Server>((resolve, reject) => {
      const s = createServer((c) => {
        c.destroy();
      });
      s.once("error", reject);
      s.listen(path, () => {
        s.off("error", reject);
        s.unref(); // the lock must not keep the process alive
        resolve(s);
      });
    });
  const alive = async () =>
    new Promise<boolean>((resolve) => {
      const c = connect(path);
      c.once("connect", () => {
        c.destroy();
        resolve(true);
      });
      c.once("error", () =>{  resolve(false); });
    });
  try {
    return await listen();
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error;
    if (await alive()) throw new Locked({ message: `another optchat is already running on ${dir}` });
    // ponytail: two processes taking over one stale socket in the same instant can both win
    try {
      unlinkSync(path);
    } catch {
      // gone already
    }
    return listen();
  }
}
