// The session's turn loop with scripted engines: how it ends when a turn throws (a defect) or the
// log refuses a message. Nothing sent may be lost, and the loop never spins.
import { afterAll, expect, test } from "bun:test";
import { Effect, PubSub, Queue } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import { makeSession, type SessionEvent } from "../src/session.ts";
import { StoreError } from "../src/store.ts";
import type { TurnEngine } from "../src/turn/engine.ts";

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
const rig = (engine: TurnEngine) =>
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
    const commit = Effect.sync(() => ((counts.commits += 1), null));
    const session = yield* makeSession({
      chat: { ...chat, log },
      commit,
      defaultDevice: "mini",
      devices: ["mini"],
      engines: [engine],
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
        run: (input) =>
          Effect.gen(function* () {
            if (++calls > 1) return;
            // the first call takes one message, then dies while a second still waits on `steer`
            input.sent.push({ taken: false, text: yield* Queue.take(input.steer) });
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
      const engine: TurnEngine = { ref: "fake:x", run: (_input, out) => out.log("talk", "an answer") };
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
