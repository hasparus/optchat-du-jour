// The session's turn loop with scripted engines: how it ends when a turn throws (a defect) or the
// log refuses a message, and what becomes of each message in the inbox: its ack names its own
// entry, and a failover hands on exactly what the engine before never took. Nothing sent may be
// lost or logged twice, and the loop never spins.
import { afterAll, expect, test } from "bun:test";
import { type AGUIEvent, EventType } from "@ag-ui/core";
import { Effect, PubSub } from "effect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import { openStream } from "../server/agui.ts";
import { UsageLimit } from "../src/engines/errors.ts";
import type { Choices } from "../src/choices.ts";
import { type FollowUp, makeSession, noMedia, type SessionEvent } from "../src/session.ts";
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

type Hook = (kind: string, text: string) => Effect.Effect<void>;
type Disk = { full: boolean; bugs: number; before: Hook | null; after: Hook | null };

// a session over a fresh chat whose log can be made to fail; every event it publishes is kept
const rig = (engine: TurnEngine | readonly TurnEngine[], o: { readonly commit?: Effect.Effect<void>; readonly followUp?: FollowUp } = {}) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(`${tmpdir()}/oc-`);
    dirs.push(dir);
    const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
    // bugs: how many of the next writes throw; before and after: a slow disk, around each write
    const disk: Disk = { after: null, bugs: 0, before: null, full: false };
    const log: typeof chat.log = (kind, body, extra) =>
      Effect.gen(function* () {
        if (disk.before) yield* disk.before(kind, body);
        if (disk.bugs > 0) {
          disk.bugs -= 1;
          return yield* Effect.die(new Error("log bug"));
        }
        if (disk.full) return yield* new StoreError({ message: "disk full" });
        const entry = yield* chat.log(kind, body, extra);
        if (disk.after) yield* disk.after(kind, body);
        return entry;
      });
    const counts = { commits: 0 };
    const commit = (o.commit ?? Effect.void).pipe(Effect.andThen(Effect.sync(() => ((counts.commits += 1), null))));
    const session = yield* makeSession({
      chat: { ...chat, log },
      commit,
      defaultDevice: "mini",
      devices: ["mini", "mac"],
      engines: Array.isArray(engine) ? engine : [engine],
      choices: { followUp: o.followUp },
      idle: "1 hour",
      logUsage: () => Effect.void,
      media: noMedia,
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
        if (e.type === "taken-back") return [`taken back ${e.clientId}: ${e.message?.text ?? e.error}`];
        return [];
      });
    const idle = () => events.some((e) => e.type === "state" && e.state.phase === "idle");
    return { chat, counts, disk, events, idle, log: () => chat.mem.root.map((m) => [m.kind, m.text]), said, session };
  });

test("a turn that dies with messages steered into it logs every one of them unanswered, and says why", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;
      const engine: TurnEngine = {
        ref: "fake:x",
        vision: false,
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
      expect(r.session.state().pending).toEqual([]);

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
        vision: false,
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
      const engine: TurnEngine = { ref: "fake:x", run: (_input, out) => out.log("talk", "an answer"), vision: false, warm: () => Effect.void };
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
      const engine: TurnEngine = { ref: "fake:x", run: (_input, out) => out.log("talk", "an answer"), vision: false, warm: () => Effect.void };
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
        vision: false,
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

// E4: the master never fails over by itself. A usage limit stops the turn and holds what it was
// answering until a client picks an engine; the picked one carries on from the log (E16).
test("a usage limit mid-turn stops the turn and waits for a pick: no second engine is called; the pick carries on with what was logged and the untaken messages, once each", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const seen: { earlier: TurnInput["earlier"]; texts: readonly string[]; mid: string[]; from: string | null }[] = [];
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
        vision: false,
        warm: () => Effect.void,
      };
      const second: TurnEngine = {
        ref: "second:x",
        run: (input, out, from) =>
          Effect.gen(function* () {
            const ready = yield* input.mid.ready;
            seen.push({ earlier: input.earlier, from, mid: ready.map((m) => m.text), texts: input.texts });
            for (const m of ready) yield* out.took(m);
            yield* out.log("talk", "done");
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig([first, second]);
      yield* r.session.input("go", undefined, "a1");
      yield* until("the reply", () => r.log().some(([kind]) => kind === "talk"));
      // two clients, the same text, both sent mid-run
      yield* r.session.input("same", undefined, "a2");
      yield* until("the first passed", () => passed.now === 1);
      yield* r.session.input("same", undefined, "b1");
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      yield* Effect.sleep("30 millis");
      expect(seen).toEqual([]); // no failover
      expect(r.session.state().stopped).toEqual({ label: "x (first)", ref: "first:x", why: "usage limit: spent" });
      expect(r.session.state().engines.find((e) => e.ref === "first:x")?.down).toBe("spent");
      expect(r.session.state().pending).toEqual([{ clientId: "b1", queued: false, text: "same" }]);
      // sent while it waits: it runs with the rest once a model is picked
      yield* r.session.input("meanwhile", undefined, "c1");
      yield* r.session.configure({ lead: "second:x" });
      yield* until("idle", r.idle);
      expect(r.log()).toEqual([
        ["user", "go"],
        ["talk", "on it"],
        ["user", "same"],
        ["user", "same"],
        ["user", "meanwhile"],
        ["talk", "done"],
      ]);
      expect(seen).toEqual([
        {
          earlier: [
            { kind: "talk", text: "on it" },
            { kind: "user", text: "same" },
          ],
          from: "first:x",
          mid: ["same", "meanwhile"],
          texts: ["go"],
        },
      ]);
      expect(r.said()).toEqual([
        "ack a1: 0",
        "ack a2: 2",
        "info: x (first) stopped: usage limit: spent. Pick a model to go on, or stop (it logged 2 entries; the next one carries on from them)",
        "end: usage limit: spent",
        "info: x (second) carries on from the 2 logged entries",
        "ack b1: 3",
        "ack c1: 4",
        "end: ok",
      ]);
      expect(r.session.state().pending).toEqual([]);
      expect([r.session.state().stopped, r.session.state().lead]).toEqual([null, "second:x"]);
    }).pipe(Effect.scoped),
  );
});

test("text an engine streamed and never logged is dropped at the stop, so the picked engine's reply is not glued to it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const spent: TurnEngine = {
        ref: "first:x",
        run: (_input, out) => out.text("Starting on").pipe(Effect.andThen(Effect.fail(new UsageLimit({ message: "spent" })))),
        vision: false,
        warm: () => Effect.void,
      };
      const next: TurnEngine = {
        ref: "second:x",
        run: (_input, out) => out.text("Done.").pipe(Effect.andThen(Effect.sleep("100 millis")), Effect.andThen(out.log("talk", "Done."))),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig([spent, next]);
      // a client watching from the start
      const sub = yield* PubSub.subscribe(r.session.events);
      const watched = openStream({ entries: r.chat.mem.root, live: null, state: r.session.state(), thread: "mini", window: 50 });
      const seen: AGUIEvent[] = [];
      yield* PubSub.take(sub).pipe(
        Effect.tap((e) => Effect.sync(() => seen.push(...watched.translate(e)))),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* r.session.input("go");
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      expect(r.session.live()).toBeNull(); // its run is over: one that joins now sees no reply
      yield* r.session.configure({ lead: "second:x" });
      yield* until("the second engine's text", () => r.session.live()?.reply?.text === "Done.");
      // one that joins now gets the second engine's reply only
      const late = openStream({ entries: r.chat.mem.root, live: r.session.live(), state: r.session.state(), thread: "mini", window: 50 });
      expect(late.first.flatMap((e) => (e.type === EventType.TEXT_MESSAGE_CONTENT ? [e.delta] : []))).toEqual(["Done."]);
      yield* until("idle", r.idle);
      expect(r.log()).toEqual([
        ["user", "go"],
        ["talk", "Done."],
      ]);
      // the watching client: the reply started again under the same index, from its first character
      const reply = seen.flatMap((e) => {
        if (e.type === EventType.TEXT_MESSAGE_START) return [`start ${e.messageId}`];
        if (e.type === EventType.TEXT_MESSAGE_CONTENT) return [`${e.messageId}: ${e.delta}`];
        if (e.type === EventType.RUN_STARTED) return ["run"];
        if (e.type === EventType.RUN_ERROR) return [`error: ${e.message}`];
        return [];
      });
      expect(reply).toEqual(["start 0", "0: go", "run", "start 1", "1: Starting on", "error: usage limit: spent", "run", "start 1", "1: Done."]);
    }).pipe(Effect.scoped),
  );
});

// a cancel that lands between a message's write and its leaving the inbox must not log it twice
test("a cancel right after a taken message was written does not log it again", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const engine: TurnEngine = {
        ref: "fake:x",
        run: (input, out) =>
          Effect.gen(function* () {
            yield* out.took(yield* input.mid.next);
            yield* Effect.never;
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig(engine);
      const written = { yes: false };
      r.disk.after = (_kind, text) => (text === "steer" ? Effect.sync(() => (written.yes = true)).pipe(Effect.andThen(Effect.sleep("30 millis"))) : Effect.void);
      yield* r.session.input("go", undefined, "c1");
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("steer", undefined, "c2");
      yield* until("the write", () => written.yes);
      yield* r.session.cancel;
      yield* until("idle", r.idle);
      expect(r.log()).toEqual([
        ["user", "go"],
        ["user", "steer"],
      ]);
      expect(r.said().filter((x) => x === "ack c2: 1")).toHaveLength(1);
      expect(r.session.state().pending).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

test("a log that refuses a taken message is reported once, and the message is logged once when the disk recovers", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let calls = 0;
      const engine: TurnEngine = {
        ref: "fake:x",
        run: (input, out) =>
          Effect.gen(function* () {
            if (++calls === 1) {
              const m = yield* input.mid.next;
              r.disk.full = true;
              yield* out.took(m);
            }
            yield* out.log("talk", `answer ${calls}`);
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig(engine);
      yield* r.session.input("go", undefined, "c1");
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("steer", undefined, "c2");
      yield* until("idle", r.idle);
      expect(r.said().filter((x) => x.startsWith("info: error"))).toEqual(["info: error: disk full"]);
      expect(r.session.state().pending.map((m) => m.clientId)).toEqual(["c2"]);
      r.disk.full = false;
      yield* r.session.input("next", undefined, "c3");
      yield* until("the second run's end", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      expect(r.log().filter(([, t]) => t === "steer")).toHaveLength(1);
      expect(r.said().filter((x) => x.startsWith("ack c2"))).toEqual(["ack c2: disk full", "ack c2: 1"]);
    }).pipe(Effect.scoped),
  );
});

test("a message sent while the turn waits for its first log write is in the state at once, by its client id", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const turns: string[] = [];
      const engine: TurnEngine = {
        ref: "fake:x",
        run: (input, out) =>
          Effect.gen(function* () {
            turns.push(`${input.texts.join("+")}@${input.device}`);
            yield* Effect.sleep("40 millis");
            yield* out.log("talk", "ok");
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig(engine);
      const slow = { on: true };
      r.disk.before = (kind, text) => (kind === "user" && text === "go" && slow.on ? Effect.sleep("40 millis").pipe(Effect.andThen(Effect.sync(() => (slow.on = false)))) : Effect.void);
      yield* r.session.input("go", undefined, "c1");
      yield* Effect.sleep("10 millis");
      // the turn is writing "go": this one waits for the next turn, and the state holds it
      yield* r.session.input("during", "mac", "c2");
      // "go" is the turn's now; "during" is held, so it can still be taken back
      expect(r.session.state().pending).toEqual([
        { clientId: "c1", queued: false, text: "go" },
        { clientId: "c2", queued: true, text: "during" },
      ]);
      yield* until("both turns", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      expect(turns).toEqual(["go@mini", "during@mac"]);
      expect(r.session.state().pending).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

// SPEC "Turn and priming": a message the call never took is logged and answered by the next turn,
// on the device it was sent for, else the one the call ran on
test("messages a successful call never took are answered by the next turn, on the call's device unless sent for another", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const turns: string[] = [];
      const engine: TurnEngine = {
        ref: "fake:x",
        run: (input, out) =>
          Effect.gen(function* () {
            turns.push(`${input.texts.join("+")}@${input.device}`);
            yield* Effect.sleep("40 millis");
            yield* out.log("talk", "ok");
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig(engine);
      yield* r.session.input("go", "mac", "c1");
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("plain", undefined, "c2");
      yield* r.session.input("on mini", "mini", "c3");
      yield* until("both turns", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      expect(turns).toEqual(["go@mac", "plain+on mini@mini"]);
      expect(r.log().filter(([k]) => k === "user")).toEqual([
        ["user", "go"],
        ["user", "plain"],
        ["user", "on mini"],
      ]);
    }).pipe(Effect.scoped),
  );
});

// ---------------------------------------------------------------------------------------------
// follow-ups (SPEC "Turn and priming"): steer or queue, "send now", take-back

// An engine that holds each call until the test opens its gate, then takes every mid-run message
// it was offered by then and answers. `calls`: each call's texts and the mid-run texts it took.
const gated = (ref = "fake:x") => {
  const gate = { open: false };
  type Call = { texts: readonly string[]; device: string; took: string[] };
  const calls: Call[] = [];
  const engine: TurnEngine = {
    ref,
    run: (input, out) =>
      Effect.gen(function* () {
        const call: Call = { device: input.device, texts: input.texts, took: [] };
        calls.push(call);
        yield* until("the gate", () => gate.open);
        for (const m of yield* input.mid.ready) {
          call.took.push(m.text);
          yield* out.took(m);
        }
        yield* out.log("talk", `answer ${calls.length}`);
      }),
    vision: false,
    warm: () => Effect.void,
  };
  return { calls, engine, gate };
};

test("queue: a message sent mid-run waits for the next turn, shown as queued; the running call is offered nothing", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const g = gated();
      const r = yield* rig(g.engine, { followUp: "queue" });
      expect(r.session.state().followUp).toBe("queue");
      yield* r.session.input("go", undefined, "c1");
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("later", undefined, "c2");
      expect(r.session.state().pending).toEqual([{ clientId: "c2", queued: true, text: "later" }]);
      g.gate.open = true;
      yield* until("both turns", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      expect(g.calls).toEqual([
        { device: "mini", texts: ["go"], took: [] },
        { device: "mini", texts: ["later"], took: [] },
      ]);
      expect(r.log()).toEqual([
        ["user", "go"],
        ["talk", "answer 1"],
        ["user", "later"],
        ["talk", "answer 2"],
      ]);
      expect(r.said()).toEqual(["ack c1: 0", "end: ok", "ack c2: 2", "end: ok"]);
    }).pipe(Effect.scoped),
  );
});

test("send now: a message that steers while the session queues joins the call, after what was queued before it, in the order sent", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const g = gated();
      const r = yield* rig(g.engine, { followUp: "queue" });
      yield* r.session.input("go", undefined, "c1");
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("queued first", undefined, "c2");
      yield* r.session.input("now", undefined, "c3", [], "steer");
      expect(r.session.state().pending.map((m) => [m.clientId, m.queued])).toEqual([
        ["c2", false],
        ["c3", false],
      ]);
      g.gate.open = true;
      yield* until("the run's end", () => r.events.some((e) => e.type === "run-finished"));
      yield* until("idle", r.idle);
      expect(g.calls).toEqual([{ device: "mini", texts: ["go"], took: ["queued first", "now"] }]);
      expect(r.log().map(([, t]) => t)).toEqual(["go", "queued first", "now", "answer 1"]);
    }).pipe(Effect.scoped),
  );
});

test("steer with a message that asks to queue: it waits for the next turn; the setting changes at runtime", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const g = gated();
      const r = yield* rig(g.engine);
      yield* r.session.input("go", undefined, "c1");
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("for later", undefined, "c2", [], "queue");
      yield* r.session.input("steered", undefined, "c3");
      // the steered one may not overtake the one queued before it: both join the call
      g.gate.open = true;
      yield* until("the run's end", () => r.events.some((e) => e.type === "run-finished"));
      expect(g.calls.map((c) => c.took)).toEqual([["for later", "steered"]]);

      // queued alone, it waits; switched to queue, plain messages wait too
      yield* r.session.configure({ followUp: "queue" });
      expect(r.session.state().followUp).toBe("queue");
      g.gate.open = false;
      yield* r.session.input("again", undefined, "c4");
      yield* until("the second run", () => r.events.filter((e) => e.type === "run-started").length === 2);
      yield* r.session.input("after that", undefined, "c5");
      g.gate.open = true;
      yield* until("three turns", () => r.events.filter((e) => e.type === "run-finished").length === 3);
      expect(g.calls.slice(1).map((c) => [c.texts, c.took])).toEqual([
        [["again"], []],
        [["after that"], []],
      ]);
    }).pipe(Effect.scoped),
  );
});

test("take-back: a queued message leaves the inbox and comes back to its client, never logged; a second take-back is refused", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const g = gated();
      const r = yield* rig(g.engine, { followUp: "queue" });
      yield* r.session.input("go", undefined, "c1");
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("never mind", undefined, "c2");
      yield* r.session.takeBack("c2");
      yield* r.session.takeBack("c2");
      expect(r.session.state().pending).toEqual([]);
      g.gate.open = true;
      yield* until("idle", r.idle);
      yield* Effect.sleep("50 millis");
      expect(g.calls).toHaveLength(1);
      expect(r.log().map(([, t]) => t)).toEqual(["go", "answer 1"]);
      expect(r.said()).toEqual(["ack c1: 0", "taken back c2: never mind", "taken back c2: the server holds no such message", "end: ok"]);
    }).pipe(Effect.scoped),
  );
});

// the turn picks its messages before it logs them: from then on a take-back is too late, and the
// message is logged and answered exactly once
test("take-back racing the run start: one the turn has picked is refused and logged once; one still held is taken", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const g = gated();
      g.gate.open = true;
      const r = yield* rig(g.engine, { followUp: "queue" });
      const writing = { now: "" };
      r.disk.before = (kind, text) =>
        kind === "user" && (text === "go" || text === "queued")
          ? Effect.sync(() => (writing.now = text)).pipe(Effect.andThen(Effect.sleep("40 millis")), Effect.ensuring(Effect.sync(() => (writing.now = ""))))
          : Effect.void;
      // idle: the message starts a turn at once, which is writing it when the take-back comes
      yield* r.session.input("go", undefined, "c1");
      yield* until("go's write", () => writing.now === "go");
      yield* r.session.takeBack("c1");
      // mid-run, two are queued; the next turn picks both, and one take-back lands as it writes them
      yield* r.session.input("queued", undefined, "c2");
      yield* r.session.input("also queued", undefined, "c3");
      yield* until("the next turn's write", () => writing.now === "queued");
      yield* r.session.takeBack("c3");
      yield* until("two turns", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      yield* until("idle", r.idle);
      expect(r.log().map(([, t]) => t)).toEqual(["go", "answer 1", "queued", "also queued", "answer 2"]);
      expect(r.said().filter((x) => x.startsWith("ack") || x.startsWith("taken"))).toEqual([
        "taken back c1: too late: the model has it",
        "ack c1: 0",
        "taken back c3: too late: the model has it",
        "ack c2: 2",
        "ack c3: 3",
      ]);
      expect(r.session.state().pending).toEqual([]);

      // one held while the turn before still runs is taken in time: the next turn never sees it
      g.gate.open = false;
      yield* r.session.input("third", undefined, "c4");
      yield* until("the third run", () => r.events.filter((e) => e.type === "run-started").length === 3);
      yield* r.session.input("withdrawn", undefined, "c5");
      yield* r.session.takeBack("c5");
      g.gate.open = true;
      yield* until("three turns", () => r.events.filter((e) => e.type === "run-finished").length === 3);
      yield* Effect.sleep("50 millis");
      expect(g.calls.map((c) => c.texts)).toEqual([["go"], ["queued", "also queued"], ["third"]]);
      expect(r.log().some(([, t]) => t === "withdrawn")).toBe(false);
    }).pipe(Effect.scoped),
  );
});

test("queue across a stop: the queued message stays held, is not handed to the picked engine's call, and is answered once by the next turn; a cancel while waiting logs what is held", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const gate = { open: false };
      const seen: { ref: string; texts: readonly string[]; mid: string[] }[] = [];
      let firstCalls = 0;
      const first: TurnEngine = {
        ref: "first:x",
        run: (input, out) =>
          Effect.gen(function* () {
            seen.push({ mid: [], ref: "first:x", texts: input.texts });
            if (++firstCalls > 1) return yield* out.log("talk", "first again");
            yield* out.log("talk", "on it");
            yield* until("the gate", () => gate.open);
            return yield* new UsageLimit({ message: "spent" });
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const second: TurnEngine = {
        ref: "second:x",
        run: (input, out) =>
          Effect.gen(function* () {
            const ready = yield* input.mid.ready;
            seen.push({ mid: ready.map((m) => m.text), ref: "second:x", texts: input.texts });
            for (const m of ready) yield* out.took(m);
            yield* out.log("talk", "done");
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig([first, second], { followUp: "queue" });
      yield* r.session.input("go", undefined, "c1");
      yield* until("the reply", () => r.log().some(([kind]) => kind === "talk"));
      yield* r.session.input("next", undefined, "c2");
      gate.open = true;
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      expect(r.session.state().pending).toEqual([{ clientId: "c2", queued: true, text: "next" }]);
      yield* r.session.configure({ lead: "second:x" });
      yield* until("two turns", () => r.events.filter((e) => e.type === "run-finished").length === 3);
      expect(seen).toEqual([
        { mid: [], ref: "first:x", texts: ["go"] },
        { mid: [], ref: "second:x", texts: ["go"] },
        { mid: [], ref: "second:x", texts: ["next"] },
      ]);
      expect(r.log()).toEqual([
        ["user", "go"],
        ["talk", "on it"],
        ["talk", "done"],
        ["user", "next"],
        ["talk", "done"],
      ]);
      expect(r.said().filter((x) => x.startsWith("ack"))).toEqual(["ack c1: 0", "ack c2: 3"]);
      expect(r.session.state().pending).toEqual([]);

      // back on the first, which is spent again: a cancel while waiting for a pick logs what is
      // held, unanswered, and the session goes idle
      yield* until("idle", r.idle);
      yield* r.session.configure({ lead: "first:x" });
      firstCalls = 0;
      gate.open = true;
      yield* r.session.input("again", undefined, "c3");
      yield* until("the second stop", () => r.session.state().phase === "needs-model");
      yield* r.session.input("held", undefined, "c4");
      yield* r.session.cancel;
      yield* until("idle again", () => r.session.state().phase === "idle");
      expect(r.log().slice(5)).toEqual([
        ["user", "again"],
        ["talk", "on it"],
        ["user", "held"],
      ]);
      expect(r.session.state().stopped).toBeNull();
    }).pipe(Effect.scoped),
  );
});

// SPEC "Turn and priming": a message sent for another device does not interrupt the running turn
test("a message sent mid-run for another device is not offered to the running call; it waits, and the next turn runs there", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const g = gated();
      const r = yield* rig(g.engine);
      yield* r.session.input("go", undefined, "c1");
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("on the mac", "mac", "c2");
      yield* r.session.input("on mini", "mini", "c3");
      yield* r.session.input("anywhere", undefined, "c4");
      expect(r.session.state().pending.map((m) => [m.clientId, m.queued])).toEqual([
        ["c2", true],
        ["c3", false],
        ["c4", false],
      ]);
      g.gate.open = true;
      yield* until("both turns", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      expect(g.calls).toEqual([
        { device: "mini", texts: ["go"], took: ["on mini", "anywhere"] },
        { device: "mac", texts: ["on the mac"], took: [] },
      ]);
    }).pipe(Effect.scoped),
  );
});

test("the lead: turns run on the picked engine only; its usage limit waits for a pick (the same one again is a retry); a ref not in the chain is refused", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ran: string[] = [];
      const limited = new Set(["b:x"]);
      const engine = (ref: string): TurnEngine => ({
        ref,
        run: (_input, out) =>
          Effect.gen(function* () {
            ran.push(ref);
            if (limited.has(ref)) return yield* new UsageLimit({ message: "spent" });
            yield* out.log("talk", ref);
          }),
        vision: false,
        warm: () => Effect.void,
      });
      const r = yield* rig([engine("a:x"), engine("b:x"), engine("c:x")]);
      expect([r.session.state().engines.map((e) => e.ref), r.session.state().lead]).toEqual([["a:x", "b:x", "c:x"], "a:x"]);
      yield* r.session.configure({ lead: "b:x" });
      yield* r.session.configure({ lead: "z:x" });
      expect(r.session.state().lead).toBe("b:x");
      yield* until("the refusal", () => r.said().includes("info: z:x is not an engine of the master's chain (a:x, b:x, c:x)"));
      yield* r.session.input("go");
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      // b is down now, with why, for the picker
      expect(r.session.state().engines.map((e) => [e.label, e.down])).toEqual([
        ["x (a)", null],
        ["x (b)", "spent"],
        ["x (c)", null],
      ]);
      // its limit is over: the same pick again retries it, and it answers
      limited.delete("b:x");
      yield* r.session.configure({ lead: "b:x" });
      yield* until("idle", r.idle);
      expect(ran).toEqual(["b:x", "b:x"]);
      expect(r.log()).toEqual([
        ["user", "go"],
        ["talk", "b:x"],
      ]);
      expect(r.session.state().engines.every((e) => e.down === null)).toBe(true);
    }).pipe(Effect.scoped),
  );
});

// an engine that answers with its own ref
const answering = (ref: string): TurnEngine => ({ ref, run: (_input, out) => out.log("talk", ref), vision: false, warm: () => Effect.void });

test("the clients' choices are saved as they change, and a session starts from the saved ones", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const saved: Choices[] = [];
      const dir = mkdtempSync(`${tmpdir()}/oc-`);
      dirs.push(dir);
      const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
      const session = yield* makeSession({
        chat,
        choices: { followUp: "queue", lead: "b:x" },
        commit: Effect.succeed(null),
        defaultDevice: "mini",
        devices: ["mini"],
        engines: [answering("a:x"), answering("b:x")],
        idle: "1 hour",
        logUsage: () => Effect.void,
        media: noMedia,
        saveChoices: (c) => Effect.sync(() => saved.push(c)),
      });
      expect([session.state().followUp, session.state().lead]).toEqual(["queue", "b:x"]);
      yield* session.configure({ followUp: "steer" });
      yield* session.configure({ lead: "a:x" });
      expect(saved).toEqual([{ followUp: "steer", lead: "b:x" }, { followUp: "steer" }]);
    }).pipe(Effect.scoped),
  );
});
