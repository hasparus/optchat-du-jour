// The session's turn loop with scripted engines: how it ends when a turn throws (a defect) or the
// log refuses a message, and what becomes of each message in the inbox: its ack names its own
// entry, and a failover hands on exactly what the engine before never took. Nothing sent may be
// lost or logged twice, and the loop never spins.
import { afterAll, expect, test } from "bun:test";
import { type AGUIEvent, EventType } from "@ag-ui/core";
import { type Duration, Effect, PubSub } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openChat } from "../src/chat.ts";
import { CompactError } from "../src/compactor.ts";
import { openStream } from "../server/agui.ts";
import { UsageLimit } from "../src/engines/errors.ts";
import { type Choices, loadChoices, startingChoices } from "../src/choices.ts";
import { type FollowUp, makeSession, noMedia, type SessionEvent } from "../src/session.ts";
import { StoreError } from "../src/store.ts";
import type { Provider } from "../src/providers/provider.ts";
import { type Mid, openingText, type TurnEngine, type TurnInput } from "../src/turn/engine.ts";
import { toolLoop } from "../src/turn/loop.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});

const until = (what: string, ok: () => boolean, ms = 4000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("5 millis");
    }
  });

type Hook = (kind: string, text: string) => Effect.Effect<void>;
type Disk = { full: boolean; bugs: number; before: Hook | null; after: Hook | null };

// a session over a fresh chat whose log can be made to fail; every event it publishes is kept
const rig = (
  engine: TurnEngine | readonly TurnEngine[],
  o: {
    readonly commit?: Effect.Effect<void>;
    readonly followUp?: FollowUp;
    readonly summarize?: Effect.Effect<void, CompactError>;
    readonly waitRetry?: Duration.Input;
  } = {},
) =>
  Effect.gen(function* () {
    const dir = mkdtempSync(`${tmpdir()}/oc-`);
    dirs.push(dir);
    const chat = yield* openChat(dir, { summarize: (job) => (o.summarize ?? Effect.void).pipe(Effect.as(`summary ${job.l}.${job.i}`)) });
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
      waitRetry: o.waitRetry ?? "1 hour",
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
      yield* r.session.input("first", { clientId: "c1" });
      yield* until("the run", () => r.session.state().phase === "running" && r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("steered", { clientId: "c2" });
      yield* Effect.sleep("10 millis");
      yield* r.session.input("steered-2", { clientId: "c3" });
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
      yield* r.session.input("hello", { clientId: "c1" });
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
      yield* r.session.input("lost?", { clientId: "c1" });
      yield* until("idle", () => r.events.some((e) => e.type === "state" && e.state.phase === "idle"));
      expect(r.log()).toEqual([]);
      expect(r.said()).toEqual(["info: error: disk full", "ack c1: disk full"]);

      r.disk.full = false;
      yield* r.session.input("and now?", { clientId: "c2" });
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
      yield* r.session.input("same", { clientId: "a1" });
      yield* until("idle", () => r.events.some((e) => e.type === "state" && e.state.phase === "idle"));
      r.disk.full = false;
      // b's message has a's text; the next turn logs a's first, then b's
      yield* r.session.input("same", { clientId: "b1" });
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
      yield* r.session.input("first", { clientId: "c1" });
      yield* until("the commit after the defect", () => committing.now);
      yield* r.session.input("second", { clientId: "c2" });
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
// answering until a client resumes it on an engine, which carries on from the log (E16).
test("a usage limit mid-turn stops the turn and waits for a resume: no second engine is called; the engine resumed on carries on with what was logged and the untaken messages, once each", async () => {
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
      yield* r.session.input("go", { clientId: "a1" });
      yield* until("the reply", () => r.log().some(([kind]) => kind === "talk"));
      // two clients, the same text, both sent mid-run
      yield* r.session.input("same", { clientId: "a2" });
      yield* until("the first passed", () => passed.now === 1);
      yield* r.session.input("same", { clientId: "b1" });
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      yield* Effect.sleep("30 millis");
      expect(seen).toEqual([]); // no failover
      expect(r.session.state().stopped).toEqual({ label: "x (first)", ref: "first:x", why: "usage limit: spent" });
      expect(r.session.state().engines.find((e) => e.ref === "first:x")?.down).toBe("spent");
      // what the stopped call never took is held again while no call runs: it can be taken back
      expect(r.session.state().pending).toEqual([{ clientId: "b1", engine: "first:x", queued: true, text: "same" }]);
      // sent while it waits, for the stopped engine (the chain's first): it goes with the rest to
      // the engine the turn is resumed on
      yield* r.session.input("meanwhile", { clientId: "c1" });
      yield* r.session.resume("second:x");
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
        "end: usage limit: spent",
        "info: x (first) stopped (usage limit: spent); x (second) carries on from the 2 logged entries",
        "ack b1: 3",
        "ack c1: 4",
        "end: ok",
      ]);
      expect(r.session.state().pending).toEqual([]);
      expect(r.session.state().stopped).toBeNull();
    }).pipe(Effect.scoped),
  );
});

test("text an engine streamed and never logged is dropped at the stop, so the resumed engine's reply is not glued to it", async () => {
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
      yield* r.session.resume("second:x");
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
            return yield* Effect.never;
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig(engine);
      const written = { yes: false };
      r.disk.after = (_kind, text) => (text === "steer" ? Effect.sync(() => (written.yes = true)).pipe(Effect.andThen(Effect.sleep("30 millis"))) : Effect.void);
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("steer", { clientId: "c2" });
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
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("steer", { clientId: "c2" });
      yield* until("idle", r.idle);
      expect(r.said().filter((x) => x.startsWith("info: error"))).toEqual(["info: error: disk full"]);
      expect(r.session.state().pending.map((m) => m.clientId)).toEqual(["c2"]);
      r.disk.full = false;
      yield* r.session.input("next", { clientId: "c3" });
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
      yield* r.session.input("go", { clientId: "c1" });
      yield* Effect.sleep("10 millis");
      // the turn is writing "go": this one waits for the next turn, and the state holds it
      yield* r.session.input("during", { clientId: "c2", device: "mac" });
      // "go" is the turn's now; "during" is held, so it can still be taken back
      expect(r.session.state().pending).toEqual([
        { clientId: "c1", engine: "fake:x", queued: false, text: "go" },
        { clientId: "c2", engine: "fake:x", queued: true, text: "during" },
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
      yield* r.session.input("go", { clientId: "c1", device: "mac" });
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("plain", { clientId: "c2" });
      yield* r.session.input("on mini", { clientId: "c3", device: "mini" });
      yield* until("three turns", () => r.events.filter((e) => e.type === "run-finished").length === 3);
      // "plain" was left by the mac call: its turn runs there; "on mini" waits for the one after
      expect(turns).toEqual(["go@mac", "plain@mac", "on mini@mini"]);
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
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("later", { clientId: "c2" });
      expect(r.session.state().pending).toEqual([{ clientId: "c2", engine: "fake:x", queued: true, text: "later" }]);
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
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("queued first", { clientId: "c2" });
      yield* r.session.input("now", { clientId: "c3", followUp: "steer" });
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
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("for later", { clientId: "c2", followUp: "queue" });
      yield* r.session.input("steered", { clientId: "c3" });
      // the steered one may not overtake the one queued before it: both join the call
      g.gate.open = true;
      yield* until("the run's end", () => r.events.some((e) => e.type === "run-finished"));
      expect(g.calls.map((c) => c.took)).toEqual([["for later", "steered"]]);

      // queued alone, it waits; switched to queue, plain messages wait too
      yield* r.session.configure({ followUp: "queue" });
      expect(r.session.state().followUp).toBe("queue");
      g.gate.open = false;
      yield* r.session.input("again", { clientId: "c4" });
      yield* until("the second run", () => r.events.filter((e) => e.type === "run-started").length === 2);
      yield* r.session.input("after that", { clientId: "c5" });
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
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("never mind", { clientId: "c2" });
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
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("go's write", () => writing.now === "go");
      yield* r.session.takeBack("c1");
      // mid-run, two are queued; the next turn picks both, and one take-back lands as it writes them
      yield* r.session.input("queued", { clientId: "c2" });
      yield* r.session.input("also queued", { clientId: "c3" });
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
      yield* r.session.input("third", { clientId: "c4" });
      yield* until("the third run", () => r.events.filter((e) => e.type === "run-started").length === 3);
      yield* r.session.input("withdrawn", { clientId: "c5" });
      yield* r.session.takeBack("c5");
      g.gate.open = true;
      yield* until("three turns", () => r.events.filter((e) => e.type === "run-finished").length === 3);
      yield* Effect.sleep("50 millis");
      expect(g.calls.map((c) => c.texts)).toEqual([["go"], ["queued", "also queued"], ["third"]]);
      expect(r.log().some(([, t]) => t === "withdrawn")).toBe(false);
    }).pipe(Effect.scoped),
  );
});

test("queue across a stop: the queued message stays held, is not handed to the resumed engine's call, and is answered once by the next turn; a cancel while waiting logs what is held", async () => {
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
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the reply", () => r.log().some(([kind]) => kind === "talk"));
      yield* r.session.input("next", { clientId: "c2" });
      gate.open = true;
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      // queued for the stopped engine: it goes to the engine the turn is resumed on, for the next turn
      expect(r.session.state().pending).toEqual([{ clientId: "c2", engine: "first:x", queued: true, text: "next" }]);
      yield* r.session.resume("second:x");
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

      // back on the first (no engine named: the chain's first), which is spent again: a cancel while
      // waiting for a resume logs what is held, unanswered, and the session goes idle
      yield* until("idle", r.idle);
      firstCalls = 0;
      gate.open = true;
      yield* r.session.input("again", { clientId: "c3" });
      yield* until("the second stop", () => r.session.state().phase === "needs-model");
      yield* r.session.input("held", { clientId: "c4" });
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
test("a steered message behind one for another device is not offered either: they wait, and run in send order, each on its device", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const g = gated();
      const r = yield* rig(g.engine);
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("on the mac", { clientId: "c2", device: "mac" });
      yield* r.session.input("on mini", { clientId: "c3", device: "mini" });
      yield* r.session.input("anywhere", { clientId: "c4" });
      // the mac one waits, and so does everything sent after it (send order); all are queued
      expect(r.session.state().pending.map((m) => [m.clientId, m.queued])).toEqual([
        ["c2", true],
        ["c3", true],
        ["c4", true],
      ]);
      g.gate.open = true;
      yield* until("three turns", () => r.events.filter((e) => e.type === "run-finished").length === 3);
      expect(g.calls).toEqual([
        { device: "mini", texts: ["go"], took: [] },
        { device: "mac", texts: ["on the mac"], took: [] },
        { device: "mini", texts: ["on mini", "anywhere"], took: [] },
      ]);
    }).pipe(Effect.scoped),
  );
});

test("a turn runs on its messages' engine; its usage limit waits for a resume (the same one again is a retry); a resume on a ref not in the chain, or with no turn stopped, is refused", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const ran: string[] = [];
      const notes: string[] = [];
      const limited = new Set(["b:x"]);
      const engine = (ref: string): TurnEngine => ({
        ref,
        run: (input, out) =>
          Effect.gen(function* () {
            ran.push(ref);
            notes.push(openingText({ ...input, earlier: [{ kind: "talk", text: "partly" }] }).split("\n\n")[1]?.slice(0, 40) ?? "");
            if (limited.has(ref)) return yield* new UsageLimit({ message: "spent" });
            yield* out.log("talk", ref);
          }),
        vision: false,
        warm: () => Effect.void,
      });
      const r = yield* rig([engine("a:x"), engine("b:x"), engine("c:x")]);
      expect(r.session.state().engines.map((e) => e.ref)).toEqual(["a:x", "b:x", "c:x"]);
      yield* r.session.resume("b:x");
      yield* until("the refusal", () => r.said().includes("info: not resumed on x (b): no turn waits for a model (another client may have resumed it)"));
      yield* r.session.input("go", { clientId: "c1", engine: "b:x" });
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      // b is down now, with why, for the pickers
      expect(r.session.state().engines.map((e) => [e.label, e.down])).toEqual([
        ["x (a)", null],
        ["x (b)", "spent"],
        ["x (c)", null],
      ]);
      yield* r.session.resume("z:x");
      yield* until("the refusal", () => r.said().includes("info: z:x is not an engine of the master's chain (a:x, b:x, c:x)"));
      expect(r.session.state().phase).toBe("needs-model");
      // its limit is over: a resume on it again retries it, and it answers
      limited.delete("b:x");
      yield* r.session.resume("b:x");
      yield* until("idle", r.idle);
      expect(ran).toEqual(["b:x", "b:x"]);
      // the retry's note doesn't say another engine began the turn
      expect(notes).toEqual(["[optchat: Another engine began this turn", "[optchat: This turn began earlier and st"]);
      expect(r.log()).toEqual([
        ["user", "go"],
        ["talk", "b:x"],
      ]);
      expect(r.said().at(-2)).toBe("info: x (b) stopped (usage limit: spent); tried again");
      expect(r.session.state().engines.every((e) => e.down === null)).toBe(true);
    }).pipe(Effect.scoped),
  );
});

// an engine that answers with its own ref
const answering = (ref: string): TurnEngine => ({ ref, run: (_input, out) => out.log("talk", ref), vision: false, warm: () => Effect.void });

// SPEC "Turn and priming": a message names the engine it is for, and the device rule holds for
// engines too: a message for another engine than the running turn's is not offered to its call,
// even when it steers; it waits with every one sent after it, and each turn runs on its own engine
test("two engines run as two turns in send order: a mid-run message for another engine is held, not offered, with every one after it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const a = gated("a:x"), b = gated("b:x");
      const r = yield* rig([a.engine, b.engine]);
      yield* r.session.input("go", { clientId: "c1", engine: "a:x" });
      yield* until("the run", () => r.events.some((e) => e.type === "run-started"));
      yield* r.session.input("for b", { clientId: "c2", engine: "b:x" });
      yield* r.session.input("for a", { clientId: "c3", engine: "a:x" }); // steers, but behind one for b
      expect(r.session.state().pending.map((m) => [m.clientId, m.engine, m.queued])).toEqual([
        ["c2", "b:x", true],
        ["c3", "a:x", true],
      ]);
      a.gate.open = b.gate.open = true;
      yield* until("three turns", () => r.events.filter((e) => e.type === "run-finished").length === 3);
      expect([a.calls, b.calls]).toEqual([
        [
          { device: "mini", texts: ["go"], took: [] },
          { device: "mini", texts: ["for a"], took: [] },
        ],
        [{ device: "mini", texts: ["for b"], took: [] }],
      ]);
      expect(r.log().map(([, t]) => t)).toEqual(["go", "answer 1", "for b", "answer 1", "for a", "answer 2"]);
      expect(r.said().filter((x) => x.startsWith("ack"))).toEqual(["ack c1: 0", "ack c2: 2", "ack c3: 4"]);
    }).pipe(Effect.scoped),
  );
});

test("a message that names no engine is for the chain's first; one that names an engine the chain doesn't have is too, and is said", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const r = yield* rig([answering("a:x"), answering("b:x")]);
      yield* r.session.input("plain", { clientId: "c1" });
      yield* until("idle", r.idle);
      yield* r.session.input("odd", { clientId: "c2", engine: "z:x" });
      yield* until("two turns", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      expect(r.log()).toEqual([
        ["user", "plain"],
        ["talk", "a:x"],
        ["user", "odd"],
        ["talk", "a:x"],
      ]);
      expect(r.said()).toContain("info: z:x is not an engine of the master's chain: the message is for x (a)");
    }).pipe(Effect.scoped),
  );
});

// SPEC "Engines": a resume hands the stopped turn's held messages (what its call never took, and
// what was sent for its engine since) to the engine it names; a message sent meanwhile for another
// engine waits behind them, and gets a turn of its own on its engine
test("needs-model, then a resume on another engine: the stopped turn's held messages go there; one sent meanwhile for a third engine waits behind them", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const seen: { ref: string; texts: readonly string[]; took: string[] }[] = [];
      let firstCalls = 0;
      // offered a mid-run message, it never takes it, and hits its limit (the first call only)
      const first: TurnEngine = {
        ref: "first:x",
        run: (input, out) =>
          Effect.gen(function* () {
            seen.push({ ref: "first:x", texts: input.texts, took: [] });
            if (++firstCalls > 1) return yield* out.log("talk", "first");
            yield* out.log("talk", "on it");
            yield* input.mid.next;
            return yield* new UsageLimit({ message: "spent" });
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const taking = (ref: string): TurnEngine => ({
        ref,
        run: (input, out) =>
          Effect.gen(function* () {
            const call: (typeof seen)[number] = { ref, texts: input.texts, took: [] };
            seen.push(call);
            for (const m of yield* input.mid.ready) {
              call.took.push(m.text);
              yield* out.took(m);
            }
            yield* out.log("talk", ref.split(":")[0] ?? ref);
          }),
        vision: false,
        warm: () => Effect.void,
      });
      const r = yield* rig([first, taking("second:x"), taking("third:x")]);
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the reply", () => r.log().some(([kind]) => kind === "talk"));
      yield* r.session.input("untaken", { clientId: "c2" });
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      yield* r.session.input("for third", { clientId: "c3", engine: "third:x" });
      yield* r.session.input("for first", { clientId: "c4", engine: "first:x" });
      expect(r.session.state().pending.map((m) => [m.clientId, m.engine, m.queued])).toEqual([
        ["c2", "first:x", true],
        ["c3", "third:x", true],
        ["c4", "first:x", true],
      ]);
      yield* r.session.resume("second:x");
      yield* until("three runs after the stop", () => r.events.filter((e) => e.type === "run-finished").length === 4);
      expect(seen).toEqual([
        { ref: "first:x", texts: ["go"], took: [] },
        { ref: "second:x", texts: ["go"], took: ["untaken"] },
        { ref: "third:x", texts: ["for third"], took: [] },
        { ref: "first:x", texts: ["for first"], took: [] },
      ]);
      expect(r.log().map(([, t]) => t)).toEqual(["go", "on it", "untaken", "second", "for third", "third", "for first", "first"]);
      expect(r.said().filter((x) => x.startsWith("ack"))).toEqual(["ack c1: 0", "ack c2: 2", "ack c3: 4", "ack c4: 6"]);
    }).pipe(Effect.scoped),
  );
});

test("the clients' choices are saved as they change, and a session starts from the saved ones", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const saved: Choices[] = [];
      const dir = mkdtempSync(`${tmpdir()}/oc-`);
      dirs.push(dir);
      const chat = yield* openChat(dir, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
      const session = yield* makeSession({
        chat,
        choices: { followUp: "queue" },
        commit: Effect.succeed(null),
        defaultDevice: "mini",
        devices: ["mini"],
        engines: [answering("a:x"), answering("b:x")],
        idle: "1 hour",
        logUsage: () => Effect.void,
        media: noMedia,
        saveChoices: (c) => Effect.sync(() => saved.push(c)),
      });
      expect(session.state().followUp).toBe("queue");
      yield* session.configure({ followUp: "steer" });
      expect(saved).toEqual([{ followUp: "steer" }]);
      expect(session.state().followUp).toBe("steer");
    }).pipe(Effect.scoped),
  );
});

// session.json: a file an older server wrote (a `lead`, no follow-up) or one that names no
// follow-up never unsets the config's `master.followUp`; a saved one wins
test("a saved session.json without a follow-up keeps the config's; one with it wins; one that can't be read is said", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const dir = mkdtempSync(`${tmpdir()}/oc-`);
      dirs.push(dir);
      const reports: string[] = [];
      const report = (m: string) => Effect.sync(() => void reports.push(m));
      const start = (text: string | null) =>
        Effect.gen(function* () {
          const path = `${dir}/session-${reports.length}-${text?.length ?? 0}.json`;
          if (text !== null) writeFileSync(path, text);
          return startingChoices({ followUp: "queue" }, yield* loadChoices(path, report));
        });
      expect(yield* start(null)).toEqual({ followUp: "queue" });
      expect(yield* start('{"lead":"openai-plan:gpt-6.1-sol"}\n')).toEqual({ followUp: "queue" });
      expect(yield* start("{}\n")).toEqual({ followUp: "queue" });
      expect(yield* start('{"followUp":"steer"}\n')).toEqual({ followUp: "steer" });
      expect(reports).toEqual([]);
      expect(yield* start("not json")).toEqual({ followUp: "queue" });
      expect(reports).toHaveLength(1);
    }),
  );
});

// SPEC "Turn and priming": a message sent for another device than the running turn's does not join
// it; it waits, the turn after it runs there, and what was sent after it waits too, so the log
// keeps the order the messages were sent in
test("a message sent for another device mid-run is not offered to the call; the next turn runs there, in send order", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const turns: string[] = [];
      const offered: string[] = [];
      const go = { now: false };
      const engine: TurnEngine = {
        ref: "fake:x",
        run: (input, out) =>
          Effect.gen(function* () {
            turns.push(`${input.texts.join("+")}@${input.device}`);
            if (turns.length === 1) yield* until("the go", () => go.now);
            for (const m of yield* input.mid.ready) {
              offered.push(m.text);
              yield* out.took(m);
            }
            yield* out.log("talk", `reply ${turns.length}`);
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig(engine);
      yield* r.session.input("A", { clientId: "c1" });
      yield* until("the run", () => turns.length === 1);
      yield* r.session.input("same device", { clientId: "c2" });
      yield* r.session.input("/on mac look there", { clientId: "c3" });
      yield* r.session.input("after it", { clientId: "c4" });
      go.now = true;
      yield* until("both turns", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      expect(offered).toEqual(["same device"]);
      expect(turns).toEqual(["A@mini", "/on mac look there+after it@mac"]);
      expect(r.chat.mem.root.map((m) => [m.kind, m.text, m.device])).toEqual([
        ["user", "A", "mini"],
        ["user", "same device", "mini"],
        ["talk", "reply 1", "mini"],
        ["user", "/on mac look there", "mac"],
        ["user", "after it", "mac"],
        ["talk", "reply 2", "mac"],
      ]);
    }).pipe(Effect.scoped),
  );
});

// SPEC "Turn and priming": a turn runs on the device of the first held message that has one, and
// takes the held messages up to the first one for another device, which waits for the turn after
test("held messages for two devices run in the order sent, each on its own device", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const turns: string[] = [];
      const go = { now: false };
      const engine: TurnEngine = {
        ref: "fake:x",
        run: (input, out) =>
          Effect.gen(function* () {
            turns.push(`${input.texts.join("+")}@${input.device}`);
            if (turns.length === 1) yield* until("the go", () => go.now);
            yield* out.log("talk", `reply ${turns.length}`);
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig(engine);
      yield* r.session.input("A", { clientId: "c1" });
      yield* until("the run", () => turns.length === 1);
      yield* r.session.input("look there", { clientId: "c2", device: "mac" });
      yield* r.session.input("and here", { clientId: "c3", device: "mini" });
      go.now = true;
      yield* until("three turns", () => r.events.filter((e) => e.type === "run-finished").length === 3);
      expect(turns).toEqual(["A@mini", "look there@mac", "and here@mini"]);
      expect(r.chat.mem.root.map((m) => [m.text, m.device])).toEqual([
        ["A", "mini"],
        ["reply 1", "mini"],
        ["look there", "mac"],
        ["reply 2", "mac"],
        ["and here", "mini"],
        ["reply 3", "mini"],
      ]);
    }).pipe(Effect.scoped),
  );
});

// the device is read with the batch, after the wait for summaries: a message for another device
// sent during that wait does not join the batch
test("a message for another device sent while the turn waits for summaries gets a turn of its own there", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const turns: string[] = [];
      const engine: TurnEngine = {
        ref: "fake:x",
        run: (input, out) =>
          Effect.gen(function* () {
            turns.push(`${input.texts.join("+")}@${input.device}`);
            yield* out.log("talk", `reply ${turns.length}`);
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const gate = { open: true };
      const r = yield* rig(engine, { summarize: until("the summaries", () => gate.open, 10_000) });
      yield* r.session.input("A", { clientId: "c1" });
      yield* until("the first turn", () => r.idle());
      // a message over a line's 512 bytes is shown by its summary, which does not come: the turn
      // after it waits
      gate.open = false;
      const long = "B".repeat(600);
      yield* r.session.input(long, { clientId: "c2" });
      yield* until("the second turn", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      yield* r.session.input("on mini", { clientId: "c3", device: "mini" });
      yield* until("the wait for summaries", () => r.session.state().phase === "waiting");
      yield* r.session.input("on mac", { clientId: "c4", device: "mac" });
      gate.open = true;
      yield* until("four turns", () => r.events.filter((e) => e.type === "run-finished").length === 4);
      expect(turns).toEqual(["A@mini", `${long}@mini`, "on mini@mini", "on mac@mac"]);
    }).pipe(Effect.scoped),
  );
});

test("a turn waiting for a summary whose call keeps failing goes on once a retry gets through, with no new message (WAIT_RETRY)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const turns: string[] = [];
      const engine: TurnEngine = {
        ref: "fake:x",
        // a long reply: its summary needs a call, and the next turn waits for it
        run: (input, out) => Effect.andThen(Effect.sync(() => void turns.push(input.texts.join("+"))), out.log("talk", "r".repeat(600))),
        vision: false,
        warm: () => Effect.void,
      };
      const calls = { failing: 0, made: 0 };
      const summarize = Effect.suspend(() => {
        calls.made++;
        return calls.failing-- > 0 ? Effect.fail(new CompactError({ message: "overloaded" })) : Effect.void;
      });
      const r = yield* rig(engine, { summarize, waitRetry: "50 millis" });
      // the reply's call fails; the next message tries it again, and it fails once more while the
      // turn waits, which tries it again by itself
      calls.failing = 3;
      yield* r.session.input("A", { clientId: "c1" });
      yield* until("the first turn", () => r.events.some((e) => e.type === "run-finished") && calls.made === 1);
      yield* r.session.input("B", { clientId: "c2" });
      yield* until("two turns", () => r.events.filter((e) => e.type === "run-finished").length === 2);
      expect(turns).toEqual(["A", "B"]);
      expect(calls.made).toBeGreaterThanOrEqual(4); // three failures, then the one that got through (and B's own reply)
    }).pipe(Effect.scoped),
  );
});

// SPEC "Engines", a turn stopped for a resume: clients get the state (phase needs-model, `stopped`)
// before the run's end, nothing else says it, and the resume's notice is the record; while it waits
// no call runs, so a message sent meanwhile is held (it can be taken back) and joins the resumed
// call in send order; the resumed run has a run id of its own
test("a stop for a resume: the state comes before the run's end; messages sent while waiting are held, can be taken back, and join the resumed run in send order", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const took: string[] = [];
      const spent: TurnEngine = {
        ref: "first:x",
        run: (_input, out) => out.log("talk", "on it").pipe(Effect.andThen(Effect.fail(new UsageLimit({ message: "spent" })))),
        vision: false,
        warm: () => Effect.void,
      };
      const next: TurnEngine = {
        ref: "second:x",
        run: (input, out) =>
          Effect.gen(function* () {
            for (const m of yield* input.mid.ready) {
              took.push(m.text);
              yield* out.took(m);
            }
            yield* out.log("talk", "done");
          }),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig([spent, next]);
      const sub = yield* PubSub.subscribe(r.session.events);
      const watched = openStream({ entries: r.chat.mem.root, live: null, state: r.session.state(), thread: "mini", window: 50 });
      const seen: AGUIEvent[] = [];
      yield* PubSub.take(sub).pipe(
        Effect.tap((e) => Effect.sync(() => seen.push(...watched.translate(e)))),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      yield* until("the run's end", () => seen.some((e) => e.type === EventType.RUN_ERROR));
      // the state that says why comes first; no info says it again
      const phaseAt = seen.findIndex((e) => e.type === EventType.STATE_DELTA && e.delta.some((op) => op.path === "/phase" && "value" in op && op.value === "needs-model"));
      const errorAt = seen.findIndex((e) => e.type === EventType.RUN_ERROR);
      expect(phaseAt).toBeGreaterThan(-1);
      expect(phaseAt).toBeLessThan(errorAt);
      expect(r.said().filter((x) => x.startsWith("info"))).toEqual([]);

      yield* r.session.input("never mind", { clientId: "c2" }); // steers, but no call runs
      yield* r.session.input("and this", { clientId: "c3" });
      expect(r.session.state().pending.map((m) => [m.clientId, m.queued])).toEqual([
        ["c2", true],
        ["c3", true],
      ]);
      yield* r.session.takeBack("c2");
      yield* r.session.resume("second:x");
      yield* until("idle", r.idle);
      expect(took).toEqual(["and this"]);
      expect(r.log().map(([, t]) => t)).toEqual(["go", "on it", "and this", "done"]);
      expect(r.said()).toEqual([
        "ack c1: 0",
        "end: usage limit: spent",
        "taken back c2: never mind",
        "info: x (first) stopped (usage limit: spent); x (second) carries on from the 1 logged entries",
        "ack c3: 2",
        "end: ok",
      ]);
      const runs = seen.flatMap((e) => (e.type === EventType.RUN_STARTED ? [e.runId] : []));
      expect(runs).toEqual(["0", "0+1"]);
    }).pipe(Effect.scoped),
  );
});

// SPEC "Turn and priming": our tool loop answers a call a cancel cut short with `not run:
// cancelled` as the call unwinds, so that echo is the run's last entry, logged before the run's
// end; what the session logs after a cancel comes after it
test("a cancel during a tool call: the not-run echo is logged under the run, before its end; a held message is logged after it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const calling: Provider = {
        auth: "api-key",
        call: (c) =>
          Effect.gen(function* () {
            yield* c.onItem?.({ id: "1", input: "{}", name: "Glob", type: "call" }) ?? Effect.void;
            return { items: [{ id: "1", input: "{}", name: "Glob", type: "call" as const }], model: "m", usage: { cacheRead: 0, cacheWrite: 0, input: 1, output: 1 } };
          }),
        engine: "api-key",
      };
      const running = { now: false };
      const engine = toolLoop({
        instructions: "MASTER",
        provider: calling,
        ref: "api-key:x",
        toolsFor: () => ({ defs: [], run: () => Effect.sync(() => (running.now = true)).pipe(Effect.andThen(Effect.never)) }),
        vision: false,
      });
      const r = yield* rig(engine, { followUp: "queue" });
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the tool call", () => running.now);
      yield* r.session.input("later", { clientId: "c2" });
      yield* r.session.cancel;
      yield* until("idle", r.idle);
      const order = r.events.flatMap((e) => (e.type === "logged" ? [`${e.entry.kind}: ${e.entry.text} (${e.runId ?? "no run"})`] : e.type === "run-finished" ? [`end: ${e.error}`] : []));
      expect(order).toEqual(["user: go (no run)", "tool: Glob {} (0)", "echo: not run: cancelled (0)", "end: cancelled", "user: later (no run)"]);
    }).pipe(Effect.scoped),
  );
});

// SPEC "Engines": two clients resume one stop at once: the first goes on, the second is told
test("two resumes of one stop: the first goes on, the second is told it came too late", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const spent: TurnEngine = { ref: "a:x", run: () => Effect.fail(new UsageLimit({ message: "spent" })), vision: false, warm: () => Effect.void };
      const r = yield* rig([spent, answering("b:x"), answering("c:x")]);
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      yield* Effect.all([r.session.resume("b:x"), r.session.resume("c:x")]);
      yield* until("idle", r.idle);
      expect(r.log()).toEqual([
        ["user", "go"],
        ["talk", "b:x"],
      ]);
      expect(r.said()).toContain("info: not resumed on x (c): no turn waits for a model (another client may have resumed it)");
    }).pipe(Effect.scoped),
  );
});

// E17 and E4: after a cancel in "needs-model" the most recent turn's engine is the one that hit its
// limit; it is marked down, so the idle priming leaves it alone
test("an engine marked down is not primed: a cancel while waiting for a model leaves no priming on it", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      let primed = 0;
      const spent: TurnEngine = {
        prime: () => Effect.sync(() => void primed++),
        ref: "a:x",
        run: () => Effect.fail(new UsageLimit({ message: "spent" })),
        vision: false,
        warm: () => Effect.void,
      };
      const r = yield* rig([spent, answering("b:x")]);
      yield* r.session.primeSoon;
      yield* until("the first priming", () => primed === 1);
      yield* r.session.input("go", { clientId: "c1" });
      yield* until("the stop", () => r.session.state().phase === "needs-model");
      yield* r.session.cancel;
      yield* until("idle", r.idle);
      yield* r.session.primeSoon;
      yield* Effect.sleep("50 millis");
      expect(primed).toBe(1);
    }).pipe(Effect.scoped),
  );
});
