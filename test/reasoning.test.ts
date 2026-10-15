// A turn's thinking beside the log (SPEC "Reasoning", E29): each piece is kept under the reply or
// tool call it came before, in chat/reasoning/, never in the log, the view or a request; the caps
// hold; a piece the turn never logged anything after is dropped; a side file that can't be written
// never stops a turn; and clients get it as AG-UI reasoning messages, live and on joining mid-thought.
import { afterAll, expect, test } from "bun:test";
import { type AGUIEvent, EventType } from "@ag-ui/core";
import { Effect, PubSub, Schema, type Scope } from "effect";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openStream } from "../server/agui.ts";
import { openChat } from "../src/chat.ts";
import { REASONING_PIECE, REASONING_TURN } from "../src/config.ts";
import { ModelError } from "../src/engines/errors.ts";
import { openReasoning, ReasoningRecord } from "../src/reasoning.ts";
import { makeSession, noMedia, type SessionEvent } from "../src/session.ts";
import { newMsg, type StoreError } from "../src/store.ts";
import type { TurnEngine, TurnEvents } from "../src/turn/engine.ts";
import { render } from "../src/view.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});
const tmp = () => {
  const d = mkdtempSync(`${tmpdir()}/oc-think-`);
  dirs.push(d);
  return d;
};

const until = (what: string, ok: () => boolean, ms = 4000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("5 millis");
    }
  });

type Play = (out: TurnEvents) => Effect.Effect<void, StoreError | ModelError>;
const engineOf = (play: Play): TurnEngine => ({ ref: "fake:x", run: (_input, out) => play(out), vision: false, warm: () => Effect.void });

// a session on a fresh chat whose engine plays `play` each turn; `keep`: the side file's setting,
// or "none" for a session with no side file at all
const rig = (play: Play, o: { readonly keep?: boolean | "none"; readonly prepare?: (dir: string) => void } = {}) =>
  Effect.gen(function* () {
    const dir = tmp();
    o.prepare?.(dir);
    const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
    const reports: string[] = [];
    const report = (m: string) => Effect.sync(() => void reports.push(m));
    const side = o.keep === "none" ? undefined : yield* openReasoning(dir, { keep: o.keep ?? true, report });
    const session = yield* makeSession({
      chat,
      commit: Effect.succeed(null),
      defaultDevice: "mini",
      devices: ["mini"],
      engines: [engineOf(play)],
      idle: "1 hour",
      logUsage: () => Effect.void,
      media: noMedia,
      reasoning: side,
    });
    const events: SessionEvent[] = [];
    const sub = yield* PubSub.subscribe(session.events);
    yield* PubSub.take(sub).pipe(
      Effect.tap((e) => Effect.sync(() => void events.push(e))),
      Effect.forever,
      Effect.forkScoped,
    );
    const finished = (n: number) =>
      until(`${n} finished runs`, () => events.filter((e) => e.type === "run-finished").length >= n && session.state().phase === "idle");
    return { chat, dir, events, finished, reports, session, side };
  });

const run = async <A, E>(body: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(body));

// every line of a stream's files, oldest first
const lines = (dir: string, stream: string) => {
  const folder = `${dir}/chat/${stream}`;
  let names: string[] = [];
  try {
    names = readdirSync(folder).toSorted();
  } catch {
    return [];
  }
  return names.flatMap((n) => readFileSync(`${folder}/${n}`, "utf8").split("\n").filter((l) => l !== ""));
};
const withoutDate = (line: string) => line.replace(/"date":"[^"]*"/, '"date":""');
// the side file's lines, decoded; and each line's keys in the order written
const decodeRecord = Schema.decodeUnknownSync(Schema.fromJsonString(ReasoningRecord));
const kept = (dir: string) => lines(dir, "reasoning").map((l) => decodeRecord(l));
const keysOf = (line: string) => Object.keys(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)))(line)).join(",");

// one turn: a thought, a tool call and its echo, two more thoughts, the reply
const thoughtful: Play = (out) =>
  Effect.gen(function* () {
    yield* out.reasoning("Plan: ", true);
    yield* out.reasoning("look first.", false);
    yield* out.log("tool", 'Read {"file_path":"a.ts"}');
    yield* out.log("echo", "contents of a.ts");
    yield* out.reasoning("Now answer.", true);
    yield* out.reasoning("Second thought.", true);
    yield* out.log("talk", "Done.");
  });
const plain: Play = (out) =>
  Effect.gen(function* () {
    yield* out.log("tool", 'Read {"file_path":"a.ts"}');
    yield* out.log("echo", "contents of a.ts");
    yield* out.log("talk", "Done.");
  });

test("thinking is kept in chat/reasoning/ under the entry it came before; the log and the view are byte for byte what they are without it", async () => {
  const withIt = await run(
    Effect.gen(function* () {
      const r = yield* rig(thoughtful);
      yield* r.session.input("hello");
      yield* r.finished(1);
      return { dir: r.dir, events: r.events, view: render(r.chat.mem) };
    }),
  );
  const without = await run(
    Effect.gen(function* () {
      const r = yield* rig(plain);
      yield* r.session.input("hello");
      yield* r.finished(1);
      return { dir: r.dir, view: render(r.chat.mem) };
    }),
  );
  // the log and the tree: not a byte apart but the dates
  expect(lines(withIt.dir, "main").map(withoutDate)).toEqual(lines(without.dir, "main").map(withoutDate));
  expect(lines(withIt.dir, "main").join("\n")).not.toContain("Plan");
  expect(lines(withIt.dir, "tree").join("\n")).not.toContain("Plan");
  expect(withIt.view).toBe(without.view);
  // the side file: one line per piece, keyed by the tool call's and the reply's log index
  expect(lines(withIt.dir, "reasoning").map(keysOf)).toEqual(["i,text,engine,date,ms", "i,text,engine,date,ms"]);
  expect(kept(withIt.dir).map((k) => [k.i, k.text, k.engine])).toEqual([
    [1, "Plan: look first.", "fake:x"],
    [3, "Now answer.\n\nSecond thought.", "fake:x"],
  ]);
  // clients: the deltas under the index each piece was expected at, then where it was kept
  const said = withIt.events.flatMap((e) => (e.type === "reasoning" ? [[e.at, e.delta]] : e.type === "reasoning-kept" ? [[e.at, `kept at ${e.i}`]] : []));
  expect(said).toEqual([
    [1, "Plan: "],
    [1, "look first."],
    [1, "kept at 1"],
    [3, "Now answer."],
    [3, "\n\nSecond thought."],
    [3, "kept at 3"],
  ]);
});

test("a piece keeps its head up to REASONING_PIECE, a turn up to REASONING_TURN, and counts the rest as cut; the next turn starts afresh", async () => {
  const big = "t".repeat(REASONING_PIECE + 10);
  const pieces = Math.ceil(REASONING_TURN / REASONING_PIECE) + 1;
  const play: Play = (out) =>
    Effect.gen(function* () {
      for (let k = 0; k < pieces; k++) {
        yield* out.reasoning(big, true);
        yield* out.log("talk", `reply ${k}`);
      }
    });
  await run(
    Effect.gen(function* () {
      const r = yield* rig(play);
      yield* r.session.input("think hard");
      yield* r.finished(1);
      expect(kept(r.dir).map((k) => [k.i, k.text.length, k.cut])).toEqual([
        [1, REASONING_PIECE, 10],
        [2, REASONING_PIECE, 10],
        [3, REASONING_PIECE, 10],
        [4, REASONING_PIECE, 10],
        [5, 0, big.length], // the turn's budget is spent: kept as a note that it thought
      ]);
      // what was streamed is what was kept: nothing past a cap goes out either
      const streamed = r.events.flatMap((e) => (e.type === "reasoning" ? [e.delta.length] : [])).reduce((a, b) => a + b, 0);
      expect(streamed).toBe(REASONING_TURN);
      expect(r.events.flatMap((e) => (e.type === "reasoning-kept" ? [e.cut] : []))).toEqual([10, 10, 10, 10, big.length]);
      yield* r.session.input("again");
      yield* r.finished(2);
      // the second turn's first piece has the whole of its own budget again
      expect(kept(r.dir)[pieces]?.text.length).toBe(REASONING_PIECE);
    }),
  );
});

// a tool call, a thought, its echo and a reply; another thought, then the model breaks
const breaks: Play = (out) =>
    Effect.gen(function* () {
      yield* out.log("tool", "Glob {}");
      yield* out.reasoning("before the echo", true);
      yield* out.log("echo", "a.txt"); // not a piece's entry: it waits for the next reply
      yield* out.log("talk", "Found a.txt.");
      yield* out.reasoning("never said", true);
      return yield* new ModelError({ message: "the model broke" });
    });

test("a piece followed by no reply or tool call is dropped, not kept; an echo or a user entry doesn't take it", async () => {
  await run(
    Effect.gen(function* () {
      const r = yield* rig(breaks);
      yield* r.session.input("look");
      yield* r.finished(1);
      expect(kept(r.dir).map((k) => k.i)).toEqual([3]);
      const ends = r.events.flatMap((e) => (e.type === "reasoning-dropped" ? ["dropped"] : e.type === "run-finished" ? ["end"] : []));
      expect(ends).toEqual(["dropped", "end"]); // before the run's end
    }),
  );
});

// two thoughts, each before a reply
const twice: Play = (out) =>
    Effect.gen(function* () {
      yield* out.reasoning("one", true);
      yield* out.log("talk", "first");
      yield* out.reasoning("two", true);
      yield* out.log("talk", "second");
    });
// where the side file's folder goes, a file: neither reading nor writing it works
const blocked = (dir: string) => {
  mkdirSync(`${dir}/chat`, { recursive: true });
  writeFileSync(`${dir}/chat/reasoning`, "not a folder");
};

test("a side file that can't be written is reported once, and the turn goes on", async () => {
  await run(
    Effect.gen(function* () {
      const r = yield* rig(twice, { prepare: blocked });
      yield* r.session.input("go");
      yield* r.finished(1);
      expect(r.chat.mem.root.map((m) => m.text)).toEqual(["go", "first", "second"]);
      expect(r.reports.filter((m) => m.includes("was not kept"))).toHaveLength(1);
      expect(r.events.filter((e) => e.type === "reasoning-kept")).toHaveLength(2); // clients still saw it live
    }),
  );
});

test("with reasoning.keep off, or no side file, thinking is only streamed", async () => {
  for (const keep of [false, "none"] as const)
    await run(
      Effect.gen(function* () {
        const r = yield* rig(thoughtful, { keep });
        yield* r.session.input("hello");
        yield* r.finished(1);
        expect(lines(r.dir, "reasoning")).toEqual([]);
        expect(r.events.filter((e) => e.type === "reasoning-kept")).toHaveLength(2);
      }),
    );
});

test("the side file is read back by range without the text, a piece with it; a torn last line is set right", async () => {
  await run(
    Effect.gen(function* () {
      const r = yield* rig(thoughtful);
      yield* r.session.input("hello");
      yield* r.finished(1);
      expect(r.side?.heads(0, 10).map((h) => [h.i, h.chars, h.engine])).toEqual([
        [1, 17, "fake:x"],
        [3, 28, "fake:x"],
      ]);
      expect(r.side?.heads(2, 3)).toEqual([]);
      expect(yield* r.side!.piece(3)).toMatchObject({ i: 3, text: "Now answer.\n\nSecond thought." });
      expect(yield* r.side!.piece(2)).toBeNull();
    }),
  );
  // a crash cut a line short: the next writer ends it, reports it, and what follows reads
  const dir = tmp();
  mkdirSync(`${dir}/chat/reasoning`, { recursive: true });
  const day = `${dir}/chat/reasoning/2026-10-15.jsonl`;
  writeFileSync(day, `${JSON.stringify({ i: 1, text: "kept", engine: "e", date: "2026-10-15T10:00:00.000Z", ms: 5 })}\n`);
  appendFileSync(day, '{"i":2,"te');
  const reports: string[] = [];
  const side = await Effect.runPromise(openReasoning(dir, { keep: true, report: (m) => Effect.sync(() => void reports.push(m)) }));
  expect(reports).toEqual([`reasoning: 1 unreadable lines in ${dir}/chat/reasoning, ignored`]);
  await Effect.runPromise(side.keep({ date: "2026-10-15T11:00:00.000Z", engine: "e", i: 4, ms: 9, text: "after the tear" }));
  expect(side.heads(0, 10).map((h) => h.i)).toEqual([1, 4]);
  expect(await Effect.runPromise(side.piece(4))).toMatchObject({ text: "after the tear" });
  const reread = await Effect.runPromise(openReasoning(dir, { keep: true, report: () => Effect.void }));
  expect(await Effect.runPromise(reread.piece(4))).toMatchObject({ i: 4, ms: 9, text: "after the tear" });
});

// ---- the wire ----

const connect = (live: Parameters<typeof openStream>[0]["live"]) => {
  const entries = [newMsg(0, "user", "hello")];
  const state = { budget: 0, device: "mini", down: [], effort: "high", engine: null, engines: [], followUp: "steer", messages: 1, pending: [], phase: "running", stopped: null, viewBytes: 0, waiting: 0 } as const;
  const s = openStream({ entries, live, state, thread: "mini", window: 50 });
  const out: AGUIEvent[] = [...s.first];
  const feed = (...es: SessionEvent[]) => {
    for (const e of es) out.push(...s.translate(e));
  };
  return { feed, out };
};
const think = (at: number, offset: number, delta: string): SessionEvent => ({ at, delta, offset, runId: "0", type: "reasoning" });
const kinds = (es: readonly AGUIEvent[]) => es.filter((e) => e.type.startsWith("REASONING")).map((e) => e.type);

test("live thinking is an AG-UI reasoning message: a client that joins mid-thought gets it so far, then the rest without a repeat, then where it was kept", () => {
  const c = connect({ reasoning: { at: 1, text: "Let me th" }, reply: null, runId: "0" });
  c.feed(think(1, 4, "me th"), think(1, 9, "ink."), { at: 1, cut: 0, i: 1, ms: 1200, runId: "0", type: "reasoning-kept" });
  expect(kinds(c.out)).toEqual([EventType.REASONING_START, EventType.REASONING_MESSAGE_START, EventType.REASONING_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_CONTENT, EventType.REASONING_MESSAGE_END, EventType.REASONING_END]);
  const text = c.out.flatMap((e) => (e.type === EventType.REASONING_MESSAGE_CONTENT ? [e.delta] : [])).join("");
  expect(text).toBe("Let me think.");
  expect(c.out.filter((e) => e.type.startsWith("REASONING")).every((e) => "messageId" in e && e.messageId === "r1")).toBe(true);
  expect(c.out.at(-1)).toEqual({ messageId: "r1", metadata: { i: 1, ms: 1200 }, type: EventType.REASONING_END });
});

test("a piece kept with nothing streamed opens and closes at once, with its cut; one dropped, or left open at the run's end, ends without an entry", () => {
  const c = connect({ reasoning: null, reply: null, runId: "0" });
  c.feed({ at: 1, cut: 500, i: 1, ms: 30, runId: "0", type: "reasoning-kept" });
  expect(kinds(c.out)).toEqual([EventType.REASONING_START, EventType.REASONING_MESSAGE_START, EventType.REASONING_MESSAGE_END, EventType.REASONING_END]);
  expect(c.out.at(-1)).toMatchObject({ metadata: { cut: 500, i: 1, ms: 30 } });
  c.feed(think(2, 0, "hmm"), { at: 2, runId: "0", type: "reasoning-dropped" });
  expect(c.out.at(-1)).toEqual({ messageId: "r2", metadata: { dropped: true }, type: EventType.REASONING_END });
  c.feed(think(3, 0, "cut off"), { error: "cancelled", logged: 2, runId: "0", type: "run-finished" });
  const end = c.out.findIndex((e) => e.type === EventType.RUN_ERROR);
  expect(c.out.slice(end - 2, end)).toEqual([
    { messageId: "r3", type: EventType.REASONING_MESSAGE_END },
    { messageId: "r3", metadata: { dropped: true }, type: EventType.REASONING_END },
  ]);
});
