// The session's turn loop with scripted engines: how it ends when a turn throws (a defect) or the
// log refuses a message, and what becomes of each message in the inbox: its ack names its own
// entry, and a failover hands on exactly what the engine before never took. Nothing sent may be
// lost or logged twice, and the loop never spins.
import { afterAll, expect, test } from "bun:test";
import { Effect, PubSub } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import { UsageLimit } from "../src/engines/errors.ts";
import { makeSession, type SessionEvent } from "../src/session.ts";
import { StoreError } from "../src/store.ts";
import type { Mid, TurnEngine, TurnInput } from "../src/turn/engine.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

const until = (what: string, ok: () => boolean, ms = 4000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("5 millis");
    }
  });

// a session over a fresh chat whose log can be made to fail; every event it publishes is kept
const rig = (engine: TurnEngine | readonly TurnEngine[], o: { readonly commit?: Effect.Effect<void> } = {}) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(`${tmpdir()}/oc-`);
    dirs.push(dir);
    const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
    const disk = { full: false, bugs: 0 }; // bugs: how many of the next writes throw
    const log: typeof chat.log = (kind, body, extra) => {
      if (disk.bugs > 0) {
        disk.bugs -= 1;
        return Effect.die(new Error("log bug"));
      }
      return disk.full ? Effect.fail(new StoreError({ message: "disk full" })) : chat.log(kind, body, extra);
    };
    const counts = { commits: 0 };
    const commit = (o.commit ?? Effect.void).pipe(Effect.andThen(Effect.sync(() => ((counts.commits += 1), null))));
    const session = yield* makeSession({
      chat: { ...chat, log },
      commit,
      defaultDevice: "mini",
      devices: ["mini"],
      engines: Array.isArray(engine) ? engine : [engine],
      idle: "1 hour",
      logUsage: () => Effect.void,
    });
    const events: SessionEvent[] = [];
    const sub = yield* PubSub.subscribe(session.events);
    yield* PubSub.take(sub).pipe(
      Effect.tap((e) => Effect.sync(() => events.push(e))),
      Effect.forever,
      Effect.forkScoped,
    );
    // what the session told its clients: infos, run ends and acks
    const said = () =>
      events.flatMap((e) => {
        if (e.type === "info") return [`info: ${e.message}`];
        if (e.type === "run-finished") return [`end: ${e.error ?? "ok"}`];
        if (e.type === "ack") return [`ack ${e.clientId}: ${e.at ?? e.error}`];
        return [];
      });
    return { chat, counts, disk, events, log: () => chat.mem.root.map((m) => [m.kind, m.text]), said, session };
  });

test("a turn that dies with messages steered into it logs every one of them unanswered, and says why", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;
      const engine: TurnEngine = {
        ref: "fake:x",
        warm: () => Effect.void,
        run: (input) =>
          Effect.gen(function* () {
            if (++calls > 1) return;
            // the first call is passed one message and never takes it, then dies while a second
            // is still on its way
            yield* input.mid.next;
            yield* Effect.sleep("50 millis");
            return yield* Effect.die(new Error("boom in engine"));
          }),
      };
      const r = yield* rig(engine);
      yield* r.session.input("first", undefined, "c1");
      yield* until("the run", () => r.session.state().phase === "running" && r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("steered", undefined, "c2");
      yield* Effect.sleep("10 millis");
      yield* r.session.input("steered-2", undefined, "c3");
      yield* until("idle", () => r.events.some((e) => e.type === "state" && e.state.phase === "idle"));
      expect(r.log()).toEqual([
        ["user", "first"],
        ["user", "steered"],
        ["user", "steered-2"],
      ]);
      expect(r.said()).toEqual([
        "ack c1: 0",
        "end: the turn stopped: boom in engine",
        "info: error: the turn stopped: boom in engine",
        "ack c2: 1",
        "ack c3: 2",
      ]);
      expect(r.session.state().queued).toEqual([]);

      // the next message gets its turn as usual
      yield* r.session.input("again");
      yield* until("the next run's end", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      expect(r.log().at(-1)).toEqual(["user", "again"]);
    }).pipe(Effect.scoped),
  );
});

test("a defect before the messages are logged stops the loop once, and logs them unanswered", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let runs = 0;
      const engine: TurnEngine = {
        ref: "fake:x",
        run: () => Effect.sync(() => (runs += 1)),
        warm: () => Effect.void,
      };
      const r = yield* rig(engine);
      r.disk.bugs = 1; // the first write, the message's, throws; the next one logs it unanswered
      yield* r.session.input("hello", undefined, "c1");
      yield* until("idle", () => r.events.some((e) => e.type === "state" && e.state.phase === "idle"));
      yield* Effect.sleep("100 millis"); // no restart, no further commits
      expect(runs).toBe(0);
      expect(r.counts.commits).toBe(1);
      expect(r.log()).toEqual([["user", "hello"]]);
      expect(r.said()).toEqual(["info: error: the turn stopped: log bug", "ack c1: 0"]);
      expect(r.events.some((e) => e.type === "run-started")).toBe(false);
    }).pipe(Effect.scoped),
  );
});

test("a message the log refuses stays queued, its sender is told, and the next message logs it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine: TurnEngine = { ref: "fake:x", run: (_input, out) => out.log("talk", "an answer"), warm: () => Effect.void };
      const r = yield* rig(engine);
      r.disk.full = true;
      yield* r.session.input("lost?", undefined, "c1");
      yield* until("idle", () => r.events.some((e) => e.type === "state" && e.state.phase === "idle"));
      expect(r.log()).toEqual([]);
      expect(r.said()).toEqual(["info: error: disk full", "ack c1: disk full"]);

      r.disk.full = false;
      yield* r.session.input("and now?", undefined, "c2");
      yield* until("the run's end", () => r.events.some((e) => e.type === "run-finished"));
      expect(r.log()).toEqual([
        ["user", "lost?"],
        ["user", "and now?"],
        ["talk", "an answer"],
      ]);
      expect(r.said().at(-2)).toBe("ack c2: 1");
    }).pipe(Effect.scoped),
  );
});

test("two clients sending the same text get acks naming their own entries, also once the log refused one", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine: TurnEngine = { ref: "fake:x", run: (_input, out) => out.log("talk", "an answer"), warm: () => Effect.void };
      const r = yield* rig(engine);
      r.disk.full = true;
      yield* r.session.input("same", undefined, "a1");
      yield* until("idle", () => r.events.some((e) => e.type === "state" && e.state.phase === "idle"));
      r.disk.full = false;
      // b's message has a's text; the next turn logs a's first, then b's
      yield* r.session.input("same", undefined, "b1");
      yield* until("the run's end", () => r.events.some((e) => e.type === "run-finished"));
      expect(r.log()).toEqual([
        ["user", "same"],
        ["user", "same"],
        ["talk", "an answer"],
      ]);
      expect(r.said()).toEqual(["info: error: disk full", "ack a1: disk full", "ack a1: 0", "ack b1: 1", "end: ok"]);
    }).pipe(Effect.scoped),
  );
});

test("a message that comes in while the loop winds down after a defect gets its turn, not an error", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;
      const engine: TurnEngine = {
        ref: "fake:x",
        run: (_input, out) => (++calls === 1 ? Effect.die(new Error("boom")) : out.log("talk", "an answer")),
        warm: () => Effect.void,
      };
      const committing = { now: false };
      const commit = Effect.sync(() => (committing.now = true)).pipe(Effect.andThen(Effect.sleep("100 millis")), Effect.ensuring(Effect.sync(() => (committing.now = false))));
      const r = yield* rig(engine, { commit });
      yield* r.session.input("first", undefined, "c1");
      yield* until("the commit after the defect", () => committing.now);
      yield* r.session.input("second", undefined, "c2");
      yield* until("the second run's end", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      expect(r.log()).toEqual([
        ["user", "first"],
        ["user", "second"],
        ["talk", "an answer"],
      ]);
      expect(r.said()).toEqual(["ack c1: 0", "end: the turn stopped: boom", "info: error: the turn stopped: boom", "ack c2: 1", "end: ok"]);
    }).pipe(Effect.scoped),
  );
});

test("a failover mid-turn hands the next engine what the first never took, once, with the log so far; each ack names its own entry", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const seen: { earlier: TurnInput["earlier"]; mid: string[] }[] = [];
      const passed = { now: 0 };
      // takes the first mid-run message it is passed, is passed a second, then hits its limit
      const first: TurnEngine = {
        ref: "first:x",
        run: (input, out) =>
          Effect.gen(function* () {
            yield* out.log("talk", "on it");
            const m: Mid = yield* input.mid.next;
            passed.now += 1;
            yield* out.took(m);
            yield* out.took(m); // a second report of the same message logs nothing
            yield* input.mid.next;
            passed.now += 1;
            return yield* new UsageLimit({ message: "spent" });
          }),
        warm: () => Effect.void,
      };
      const second: TurnEngine = {
        ref: "second:x",
        run: (input, out) =>
          Effect.gen(function* () {
            const ready = yield* input.mid.ready;
            seen.push({ earlier: input.earlier, mid: ready.map((m) => m.text) });
            for (const m of ready) yield* out.took(m);
            yield* out.log("talk", "done");
          }),
        warm: () => Effect.void,
      };
      const r = yield* rig([first, second]);
      yield* r.session.input("go", undefined, "a1");
      yield* until("the reply", () => r.log().some(([kind]) => kind === "talk"));
      // two clients, the same text, both sent mid-run
      yield* r.session.input("same", undefined, "a2");
      yield* until("the first passed", () => passed.now === 1);
      yield* r.session.input("same", undefined, "b1");
      yield* until("the run's end", () => r.events.some((e) => e.type === "run-finished"));
      expect(r.log()).toEqual([
        ["user", "go"],
        ["talk", "on it"],
        ["user", "same"],
        ["user", "same"],
        ["talk", "done"],
      ]);
      expect(seen).toEqual([
        {
          earlier: [
            { kind: "talk", text: "on it" },
            { kind: "user", text: "same" },
          ],
          mid: ["same"],
        },
      ]);
      expect(r.said()).toEqual(["ack a1: 0", "ack a2: 2", "info: first:x → second:x: spent (after 2 logged entries; second:x carries on from them)", "ack b1: 3", "end: ok"]);
      expect(r.session.state().queued).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
