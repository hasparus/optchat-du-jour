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
import { makeSession, noMedia, type SessionEvent } from "../src/session.ts";
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
const rig = (engine: TurnEngine | readonly TurnEngine[], o: { readonly commit?: Effect.Effect<void> } = {}) =>
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
        vision: false,
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
      expect(r.session.state().pending).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

test("text an engine streamed and never logged is dropped at a failover, so the next engine's reply is not glued to it", async () => {
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
      yield* until("the second engine's text", () => r.session.live()?.reply?.text === "Done.");
      // one that joins now gets the second engine's reply only
      const late = openStream({ entries: r.chat.mem.root, live: r.session.live(), state: r.session.state(), thread: "mini", window: 50 });
      expect(late.first.flatMap((e) => (e.type === EventType.TEXT_MESSAGE_CONTENT ? [e.delta] : []))).toEqual(["Done."]);
      yield* until("the run's end", () => r.events.some((e) => e.type === "run-finished"));
      expect(r.log()).toEqual([
        ["user", "go"],
        ["talk", "Done."],
      ]);
      // the watching client: the reply started again under the same index, from its first character
      const reply = seen.flatMap((e) => {
        if (e.type === EventType.TEXT_MESSAGE_START) return [`start ${e.messageId}`];
        if (e.type === EventType.TEXT_MESSAGE_CONTENT) return [`${e.messageId}: ${e.delta}`];
        return [];
      });
      expect(reply).toEqual(["start 0", "0: go", "start 1", "1: Starting on", "start 1", "1: Done."]);
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
      expect(r.session.state().pending).toEqual([
        { clientId: "c1", text: "go" },
        { clientId: "c2", text: "during" },
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
      yield* r.session.input("A", undefined, "c1");
      yield* until("the run", () => turns.length === 1);
      yield* r.session.input("same device", undefined, "c2");
      yield* r.session.input("/on mac look there", undefined, "c3");
      yield* r.session.input("after it", undefined, "c4");
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
