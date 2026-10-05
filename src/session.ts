// The session (ref §5.2, E1): the one turn loop the server owns. Messages wait in one inbox and
// start a turn; a message sent while a turn runs is offered to its call. Every client sees the
// same events. Priming runs only while idle, and a turn never waits for it (E17, SPEC "Turn and
// priming").
import { Cause, type Duration, Effect, Exit, Fiber, FiberSet, Option, PubSub, Queue, type Scope } from "effect";
import { PRIME_IDLE } from "./config.ts";
import type { Chat } from "./chat.ts";
import { type DownList, failover } from "./engines/chain.ts";
import type { EngineError } from "./engines/errors.ts";
import type { StoreError } from "./store.ts";
import type { Entry } from "./tree.ts";
import type { Mid, TurnEngine, TurnEvents, TurnInput } from "./turn/engine.ts";
import type { UsageRecord } from "./usage.ts";
import { allBuilt, render, settle, unbuilt, viewSize } from "./view.ts";
import type { Phase, SessionState } from "./wire.ts";

// the state every client is shown (STATE_SNAPSHOT, STATE_DELTA, /api/state): src/wire.ts
export type { Phase, SessionState } from "./wire.ts";

export type SessionEvent =
  | { readonly type: "logged"; readonly entry: Entry; readonly runId: string | null }
  // `at`: the log index the reply's talk entry will get, taken when the delta is published;
  // `offset`: where the delta starts in that reply's text so far
  | { readonly type: "text"; readonly delta: string; readonly runId: string; readonly at: number; readonly offset: number }
  | { readonly type: "thinking"; readonly tokens: number; readonly runId: string }
  | { readonly type: "run-started"; readonly runId: string }
  // every run-started gets exactly one, also after a cancel; `logged`: the log's length by then
  | { readonly type: "run-finished"; readonly runId: string; readonly error: string | null; readonly logged: number }
  | { readonly type: "info"; readonly message: string }
  // a client's message (`clientId`, its AG-UI id) became log entry `at`, or could not be logged:
  // `error`. A message the log refused stays in the inbox, and is acked again when it is logged.
  | { readonly type: "ack"; readonly clientId: string; readonly at: number | null; readonly error: string | null }
  | { readonly type: "usage"; readonly record: UsageRecord }
  | { readonly type: "state"; readonly state: SessionState };

export type Session = {
  // a message from a client: it starts a turn, or joins the running one. With a `clientId` the
  // client is told (an "ack") which log entry the message became, or that it could not be logged.
  readonly input: (text: string, device?: string, clientId?: string) => Effect.Effect<void>;
  // the user's cancel: the wait or the turn stops; nothing sent is lost
  readonly cancel: Effect.Effect<void>;
  readonly events: PubSub.PubSub<SessionEvent>;
  readonly state: () => SessionState;
  // a client connected: a message usually follows, so prime the view (SPEC "Turn and priming")
  readonly primeSoon: Effect.Effect<void>;
  // the run going on, and the reply it is streaming (not logged yet), for a client joining now
  readonly live: () => LiveRun | null;
};

export type LiveRun = { readonly runId: string; readonly reply: { readonly at: number; readonly text: string } | null };

// "/on macbook ..." picks the device for that turn; the text stays as typed
export const deviceOf = (text: string, devices: readonly string[]) => {
  const m = /^\/on\s+(\S+)/.exec(text);
  return m?.[1] && devices.includes(m[1]) ? m[1] : null;
};

// A message from a client, the session's until it is logged: waiting for a turn ("queued"), or
// offered to the running call, which may take it (it is logged then) or leave it (it comes back
// "queued" when the call ends). Each carries the id its client sent it with, so its ack names it.
type Incoming = {
  readonly seq: number; // the order messages came in
  readonly text: string;
  device: string | null; // the device it was sent for; one a call left gets that call's device
  readonly clientId: string | null;
  state: "queued" | "offered";
};

export const makeSession = (o: {
  readonly chat: Chat;
  readonly engines: readonly TurnEngine[]; // the master chain, first choice first
  readonly devices: readonly string[];
  readonly defaultDevice: string;
  readonly commit: Effect.Effect<string | null>; // commit the data dir (its push is not waited for); an error message or null
  readonly logUsage: (record: UsageRecord) => Effect.Effect<void>;
  readonly idle?: Duration.Input; // PRIME_IDLE
  readonly compactorDown?: DownList; // makeSummarize's `down`: shown in the state, published again as it changes
  readonly events?: PubSub.PubSub<SessionEvent>; // the server's, made first so it can report into it; else the session's own
}): Effect.Effect<Session, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { chat } = o;
    const events = o.events ?? (yield* PubSub.unbounded<SessionEvent>());
    const publish = (e: SessionEvent) => PubSub.publish(events, e).pipe(Effect.asVoid);
    const info = (message: string) => publish({ message, type: "info" });

    // every message not logged yet, in the order they came in
    const inbox: Incoming[] = [];
    let seq = 0;
    let phase: Phase = "idle", device = o.defaultDevice, engine: string | null = null;
    // a turn's call accepts mid-run messages, and the queue the call running now reads them from
    let accepting = false;
    let offerTo: Queue.Queue<Mid> | null = null;
    let running = false; // the turn loop is on: set before its fiber starts, cleared as it ends
    let loop: Fiber.Fiber<void> | null = null; // that fiber, for a cancel
    // the loop stopped on an error (the log refused, or a defect), why, and the last message in by
    // then: those wait for a newer message instead of starting the loop again at once
    let halted: { readonly why: string; readonly upTo: number } | null = null;

    const queued = () => inbox.filter((m) => m.state === "queued");
    const offered = () => inbox.filter((m) => m.state === "offered");

    const state = (): SessionState => ({
      budget: chat.mem.budget,
      device,
      down: o.compactorDown?.now() ?? [],
      engine,
      messages: chat.mem.root.length,
      phase,
      queued: offered().map((m) => m.text),
      viewBytes: viewSize(chat.mem),
      waiting: unbuilt(chat.mem),
    });
    const tell = Effect.suspend(() => publish({ state: state(), type: "state" }));
    const enter = (p: Phase) => Effect.suspend(() => ((phase = p), tell));
    // a compactor engine went down or came back: clients see it in the state (subscribed here, so
    // no change is missed between now and the fiber's start)
    if (o.compactorDown) {
      const downs = yield* PubSub.subscribe(o.compactorDown.changes);
      yield* PubSub.take(downs).pipe(Effect.andThen(tell), Effect.forever, Effect.forkScoped);
    }

    // the run whose RUN_STARTED went out, and the text it is streaming at log index `at`
    let current: { runId: string; reply: { at: number; text: string } | null } | null = null;
    const live = (): LiveRun | null => current && { reply: current.reply && { ...current.reply }, runId: current.runId };

    const ack = (m: Incoming, at: number | null, error: string | null) =>
      m.clientId === null ? Effect.void : publish({ at, clientId: m.clientId, error, type: "ack" });

    const log = (kind: Entry["kind"], text: string, runId: string | null, on: string | null) =>
      chat.log(kind, text, on ? { device: on } : {}).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (current) current.reply = null; // the streamed text is logged now, or was left behind
          }),
        ),
      );
    const published = (runId: string | null) => (entry: Entry) => publish({ entry, runId, type: "logged" });

    // A message becomes a user entry, on device `on` or else the one it was sent for. It leaves the
    // inbox only once it is in the log, so a failure finds it logged or still there, and its
    // client is told which entry it is before the entry goes out.
    const logMessage = (m: Incoming, runId: string | null, on: string | null) =>
      log("user", m.text, runId, on ?? m.device).pipe(
        Effect.tap((entry) =>
          Effect.suspend(() => {
            inbox.splice(inbox.indexOf(m), 1);
            return ack(m, entry.i, null).pipe(Effect.andThen(published(runId)(entry)));
          }),
        ),
      );
    // these messages, in order, logged unanswered (gist §7: nothing is lost)
    const logEach = (ms: readonly Incoming[]) => Effect.forEach(ms, (m) => logMessage(m, null, null), { discard: true });

    // live reply text: buffered for clients that join mid-reply, each delta with its place in it
    const stream = (delta: string, runId: string) =>
      Effect.suspend(() => {
        const at = chat.mem.root.length;
        if (current && current.reply?.at !== at) current.reply = { at, text: "" };
        const offset = current?.reply?.text.length ?? 0;
        if (current?.reply) current.reply.text += delta;
        return publish({ at, delta, offset, runId, type: "text" });
      });

    // the one start of a run: `current` and RUN_STARTED together, so no end goes out without its start
    const beginRun = (runId: string) =>
      Effect.suspend(() => {
        current = { reply: null, runId };
        return publish({ runId, type: "run-started" });
      }).pipe(Effect.uninterruptible);

    // the one end of a run: published before anything else is logged, so a reply left open
    // (a cancel, a crash) is closed before its log index goes to another entry
    const endRun = (error: string | null) =>
      Effect.suspend(() => {
        if (!current) return Effect.void;
        const { runId } = current;
        current = null;
        return publish({ error, logged: chat.mem.root.length, runId, type: "run-finished" });
      });

    // Priming happens only while idle, in fibers of `primes`. A turn that starts stops them
    // instead of waiting (E17): its own request writes the same prefix to the cache.
    const lead = o.engines[0];
    const primer = lead?.prime;
    const scope = yield* Effect.scope;
    const primes = yield* FiberSet.make();
    const primeNow = Effect.suspend(() =>
      !primer || running || !allBuilt(chat.mem) ? Effect.succeed(null) : FiberSet.run(primes, primer(render(chat.mem), o.defaultDevice)),
    );
    // the next turn's and priming's claude, started ahead on the default device (E18)
    const warm = lead ? lead.warm(o.defaultDevice).pipe(Effect.forkIn(scope), Effect.asVoid) : Effect.void;

    // the view changed (a message, a node): once it has been quiet for PRIME_IDLE and no turn runs,
    // prime it in the background. One fiber debounces every change, so bursts start one timer.
    const changes = yield* Queue.sliding<true>(1);
    const primeLater = Queue.offer(changes, true);
    if (primer) {
      const quiet = o.idle ?? PRIME_IDLE;
      yield* Effect.gen(function* () {
        yield* Queue.take(changes);
        while (Option.isSome(yield* Queue.take(changes).pipe(Effect.timeoutOption(quiet)))) {
          // changed again within PRIME_IDLE: wait for quiet from here
        }
        const priming = yield* primeNow;
        if (priming) yield* Fiber.await(priming); // a turn may stop it; this loop goes on
      }).pipe(Effect.forever, Effect.forkIn(scope));
    }
    yield* warm;
    const onViewChange = () => {
      Effect.runFork(Effect.andThen(tell, primeLater));
    };
    chat.mem.listeners.add(onViewChange);
    yield* Effect.addFinalizer(() => Effect.sync(() => chat.mem.listeners.delete(onViewChange)));

    // the queued messages, logged for a turn on `on`; uninterruptible, so a cancel finds each logged
    // or queued. One that comes in meanwhile waits for the next turn.
    const logQueued = (on: string) =>
      Effect.gen(function* () {
        const entries: Entry[] = [];
        for (const m of queued()) entries.push(yield* logMessage(m, null, on));
        return { runId: String(entries[0]?.i ?? chat.mem.root.length), texts: entries.map((e) => e.text) };
      }).pipe(Effect.uninterruptible);

    // The call is over: nothing more is offered to it, and what it was offered and never took is
    // queued again, on the call's device unless it was sent for one.
    const giveBack = (on: string) =>
      Effect.sync(() => {
        accepting = false;
        offerTo = null;
        const left = offered();
        for (const m of left) {
          m.state = "queued";
          m.device ??= on;
        }
        return left;
      });

    // A call of one link of the chain, with its own queue of mid-run messages: first those offered
    // before it (to a link that failed over), then each one as it comes. `took` logs one it took.
    const call = (e: TurnEngine, base: Omit<TurnInput, "earlier" | "mid">, from: string | null, out: TurnEvents, since: number) =>
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<Mid>();
        const earlier = yield* Effect.sync(() => {
          offerTo = q;
          for (const m of offered()) Queue.offerUnsafe(q, { seq: m.seq, text: m.text });
          engine = e.ref;
          return chat.mem.root.slice(since).map(({ kind, text }) => ({ kind, text }));
        });
        yield* tell;
        return yield* e.run({ ...base, earlier, mid: { next: Queue.take(q), ready: Queue.clear(q) } }, out, from);
      });

    const turn = Effect.gen(function* () {
      yield* FiberSet.clear(primes).pipe(Effect.forkIn(scope)); // not waited for: the killed claude may take a moment
      while (queued().length > 0) {
        device = queued().findLast((m) => m.device)?.device ?? o.defaultDevice;
        const on = device;
        if (unbuilt(chat.mem)) {
          yield* enter("waiting");
          yield* settle(chat.mem);
        }
        const view = render(chat.mem); // BEFORE the new messages are logged (gist §7)
        yield* enter("running");
        const { runId, texts } = yield* logQueued(on);
        const since = chat.mem.root.length; // what this turn's engines log starts here
        accepting = true;
        const out: TurnEvents = {
          info,
          log: (kind, text) => log(kind, text, runId, on).pipe(Effect.flatMap(published(runId))),
          text: (delta) => stream(delta, runId),
          thinking: (tokens) => publish({ runId, tokens, type: "thinking" }),
          took: (taken) =>
            Effect.suspend(() => {
              const m = inbox.find((x) => x.seq === taken.seq && x.state === "offered");
              return m ? logMessage(m, runId, on).pipe(Effect.andThen(tell)) : Effect.void; // taken once
            }),
          usage: (record) => o.logUsage(record).pipe(Effect.andThen(publish({ record, type: "usage" }))),
        };
        yield* beginRun(runId);
        yield* tell;
        const base = { device: on, texts, view };
        const result = yield* failover(
          o.engines.map((e) => ({ ref: e.ref, run: (from: string | null) => call(e, base, from, out, since) })),
          // a failover mid-turn keeps what was logged: the next engine is told and carries on from it
          (from, to, why) =>
            Effect.suspend(() => {
              const done = chat.mem.root.length - since;
              return info(`${from} → ${to}: ${why}${done > 0 ? ` (after ${done} logged entries; ${to} carries on from them)` : ""}`);
            }),
        ).pipe(Effect.result);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            engine = null;
            // after a result what the call left gets a fresh call with a new view; after a failure
            // it is logged, unanswered
            const left = yield* giveBack(on);
            if (result._tag === "Success") return yield* endRun(null);
            yield* info(failureText(result.failure));
            yield* endRun(result.failure.message);
            yield* logEach(left);
          }),
        );
      }
    });

    // The loop is over: the data dir is committed before the session says "idle", so a client that
    // sees idle sees the commit. A message that came in while the loop wound down starts it again.
    // After an error, only one that came in after it does: the ones the loop stopped on wait for
    // the next message, and their senders are told.
    const afterLoop = Effect.gen(function* () {
      engine = null;
      yield* endRun("the turn stopped"); // a run the loop left without an end
      const failed = yield* o.commit;
      if (failed) yield* info(`git: ${failed}`);
      yield* Effect.suspend(() => {
        running = false;
        loop = null;
        const stop = halted;
        halted = null;
        if (inbox.some((m) => stop === null || m.seq > stop.upTo)) return start;
        phase = "idle";
        const told = stop === null ? Effect.void : Effect.forEach(inbox, (m) => ack(m, null, stop.why), { discard: true });
        return told.pipe(Effect.andThen(tell), Effect.andThen(primeLater), Effect.andThen(warm));
      });
    });

    // The loop ended early: a cancel (an interrupt only), a store error or a defect. Nothing sent
    // is lost (gist §7). What the call never took goes back to the inbox; after a cancel or a
    // defect everything there is logged unanswered, and whatever the log refuses stays there.
    // After an error the loop waits for a newer message: a defect that comes before the messages
    // are logged would otherwise start it again at once, forever.
    const stopped = (cause: Cause.Cause<StoreError>) =>
      Effect.gen(function* () {
        const cancelled = Cause.hasInterruptsOnly(cause);
        const refused = cancelled || Cause.hasDies(cause) ? Option.none() : Cause.findErrorOption(cause);
        const why = cancelled ? "cancelled" : Option.match(refused, { onNone: () => `the turn stopped: ${thrown(cause)}`, onSome: (e) => e.message });
        yield* giveBack(device);
        const inRun = current !== null;
        yield* endRun(why); // the run's end says it
        if (!cancelled) {
          halted = { upTo: seq, why };
          yield* info(`error: ${why}`);
        }
        if (Option.isSome(refused)) return; // the log refuses: they stay in the inbox
        yield* logEach([...inbox]);
        if (cancelled && !inRun) yield* info("cancelled"); // before any run started: waiting for summaries
      }).pipe(Effect.catch((error: StoreError) => Effect.sync(() => (halted = { upTo: seq, why: error.message })).pipe(Effect.andThen(info(`error: ${error.message}`)))));

    const start: Effect.Effect<void> = Effect.suspend(() => {
      if (running) return Effect.void;
      running = true;
      phase = "running"; // until the loop says what it waits for: never "idle" while it is on
      return turn.pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? stopped(exit.cause) : Effect.void)),
        Effect.ensuring(afterLoop),
        Effect.ignoreCause,
        Effect.forkIn(scope),
        Effect.tap((fiber) => Effect.sync(() => (loop = fiber))),
        Effect.asVoid,
      );
    });

    const input = (text: string, on?: string, clientId?: string) =>
      Effect.gen(function* () {
        if (text.trim() === "") return; // nothing to answer: no turn, no empty user entry
        const picked = on && o.devices.includes(on) ? on : deviceOf(text, o.devices);
        const m: Incoming = { clientId: clientId ?? null, device: picked, seq: ++seq, state: accepting ? "offered" : "queued", text };
        inbox.push(m);
        if (m.state === "offered") {
          if (offerTo) Queue.offerUnsafe(offerTo, { seq: m.seq, text });
          return yield* tell;
        }
        yield* start;
        yield* tell;
      });

    const cancel = Effect.suspend(() => (loop ? Fiber.interrupt(loop) : Effect.void));
    const primeSoon = Effect.asVoid(primeNow);

    return { cancel, events, input, live, primeSoon, state };
  });

// a defect in one line: what was thrown
const thrown = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

const failureText = (e: EngineError | StoreError) => {
  switch (e._tag) {
    case "Refusal":
      return `declined: ${e.message}`;
    case "DeviceOffline":
      return `device offline: ${e.message}`;
    case "UsageLimit":
      return `usage limit: ${e.message}`;
    case "ModelError":
    case "StoreError":
      return `error: ${e.message}`;
  }
};

