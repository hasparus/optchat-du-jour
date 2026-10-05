// The session (ref §5.2, E1): the one turn loop the server owns. Messages queue up and start a
// turn; a message sent while a turn runs is steered into it. Every client sees the same events.
// Priming runs only while idle, and a turn never waits for it (E17, SPEC "Turn and priming").
import { Cause, type Duration, Effect, Exit, Fiber, FiberSet, Option, PubSub, Queue, type Scope } from "effect";
import { PRIME_IDLE } from "./config.ts";
import type { Chat } from "./chat.ts";
import { type Down, failover } from "./engines/chain.ts";
import type { EngineError } from "./engines/errors.ts";
import type { StoreError } from "./store.ts";
import type { Entry } from "./tree.ts";
import type { Logged, Sent, TurnEngine, TurnEvents } from "./turn/engine.ts";
import type { UsageRecord } from "./usage.ts";
import { allBuilt, render, settle, unbuilt, viewSize } from "./view.ts";

export type Phase = "idle" | "running" | "waiting";

export type SessionState = {
  readonly phase: Phase;
  readonly device: string; // where the next or current turn runs
  readonly engine: string | null; // the engine of the current turn
  readonly waiting: number; // view lines not summarized yet
  readonly viewBytes: number;
  readonly budget: number;
  readonly messages: number;
  readonly queued: readonly string[]; // sent mid-run, not taken by the call yet
  readonly down: readonly Down[]; // compactor engines down right now, with why (SPEC "Policy": never unseen)
};

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
  // a client's message (`clientId`, its AG-UI id) became log entry `at`, or could not be logged: `error`
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
  // publish the state again: something it shows changed outside the session (a compactor engine)
  readonly tell: Effect.Effect<void>;
};

export type LiveRun = { readonly runId: string; readonly reply: { readonly at: number; readonly text: string } | null };

// "/on macbook ..." picks the device for that turn; the text stays as typed
export const deviceOf = (text: string, devices: readonly string[]) => {
  const m = /^\/on\s+(\S+)/.exec(text);
  return m?.[1] && devices.includes(m[1]) ? m[1] : null;
};

export const makeSession = (o: {
  readonly chat: Chat;
  readonly engines: readonly TurnEngine[]; // the master chain, first choice first
  readonly devices: readonly string[];
  readonly defaultDevice: string;
  readonly commit: Effect.Effect<string | null>; // commit the data dir (its push is not waited for); an error message or null
  readonly logUsage: (record: UsageRecord) => Effect.Effect<void>;
  readonly idle?: Duration.Input; // PRIME_IDLE
  readonly compactorDown?: () => readonly Down[]; // makeSummarize's `down`
  readonly events?: PubSub.PubSub<SessionEvent>; // the server's, made first so it can report into it; else the session's own
}): Effect.Effect<Session, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { chat } = o;
    const events = o.events ?? (yield* PubSub.unbounded<SessionEvent>());
    const publish = (e: SessionEvent) => PubSub.publish(events, e).pipe(Effect.asVoid);
    const info = (message: string) => publish({ message, type: "info" });

    const queue: { text: string; device: string | null }[] = [];
    let phase: Phase = "idle", device = o.defaultDevice, engine: string | null = null;
    let steer: Queue.Queue<string> | null = null;
    let sent: Sent[] = [];
    let running = false; // the turn loop is on: set before its fiber starts, cleared as it ends
    let loop: Fiber.Fiber<void> | null = null; // that fiber, for a cancel
    // the loop stopped on an error (the log refused, or a defect), and why: what is still queued
    // waits for the next message instead of starting the loop again at once
    let halted: string | null = null;
    // the client ids of messages not logged yet, oldest first
    const pending: { id: string; text: string }[] = [];

    // what the running call has been given but not taken yet
    const notTaken = () => sent.flatMap((m) => (m.taken ? [] : [m.text]));

    const state = (): SessionState => ({
      budget: chat.mem.budget,
      device,
      down: o.compactorDown?.() ?? [],
      engine,
      messages: chat.mem.root.length,
      phase,
      queued: notTaken(),
      viewBytes: viewSize(chat.mem),
      waiting: unbuilt(chat.mem),
    });
    const tell = Effect.suspend(() => publish({ state: state(), type: "state" }));
    const enter = (p: Phase) => Effect.suspend(() => ((phase = p), tell));

    // the run whose RUN_STARTED went out, and the text it is streaming at log index `at`
    let current: { runId: string; reply: { at: number; text: string } | null } | null = null;
    const live = (): LiveRun | null => current && { reply: current.reply && { ...current.reply }, runId: current.runId };

    // a logged user entry is the oldest pending message with its text: every path (the queue, the
    // steered messages, the unanswered ones) logs messages in the order they came in
    const claim = (text: string) => {
      const k = pending.findIndex((p) => p.text === text);
      return k === -1 ? null : (pending.splice(k, 1)[0]?.id ?? null);
    };
    const nack = (text: string, error: string) =>
      Effect.suspend(() => {
        const clientId = claim(text);
        return clientId === null ? Effect.void : publish({ at: null, clientId, error, type: "ack" });
      });

    const log = (kind: Entry["kind"], text: string, runId: string | null, on: string | null) =>
      chat.log(kind, text, on ? { device: on } : {}).pipe(
        Effect.tap((entry) =>
          Effect.suspend(() => {
            if (current) current.reply = null; // the streamed text is logged now, or was left behind
            const clientId = kind === "user" ? claim(text) : null;
            const acked = clientId === null ? Effect.void : publish({ at: entry.i, clientId, error: null, type: "ack" });
            return Effect.andThen(acked, publish({ entry, runId, type: "logged" }));
          }),
        ),
      );

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
    const warm = lead?.warm ? lead.warm(o.defaultDevice).pipe(Effect.forkIn(scope), Effect.asVoid) : Effect.void;

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

    // The first n queued messages become user entries, on device `on` or else the one each was
    // sent for. Each leaves the queue only once it is in the log, so a failure finds it logged or
    // still queued. Unanswered, they stay in the log (gist §7: nothing is lost).
    const logFirst = (n: number, on: string | null) =>
      Effect.gen(function* () {
        const entries: Entry[] = [];
        for (let left = n; left > 0; left--) {
          const head = queue[0];
          if (!head) break;
          entries.push(yield* log("user", head.text, null, on ?? head.device));
          queue.shift();
        }
        return entries;
      });

    // the queued texts, logged for a turn; uninterruptible, so a cancel finds each logged or queued
    const logQueued = (on: string) =>
      logFirst(queue.length, on).pipe(
        Effect.map((entries) => ({ runId: String(entries[0]?.i ?? chat.mem.root.length), texts: entries.map((e) => e.text) })),
        Effect.uninterruptible,
      );

    // What the call was given and never took, and what is still on its way to it. `steer` is
    // closed first, so nothing more can be steered into a call that is over.
    const drainLeftovers = Effect.suspend(() => {
      const closed = steer;
      steer = null;
      const untaken = notTaken();
      sent = [];
      return closed ? Queue.clear(closed).pipe(Effect.map((more) => [...untaken, ...more])) : Effect.succeed(untaken);
    });

    const turn = Effect.gen(function* () {
      yield* FiberSet.clear(primes).pipe(Effect.forkIn(scope)); // not waited for: the killed claude may take a moment
      while (queue.length > 0) {
        device = queue.findLast((q) => q.device)?.device ?? o.defaultDevice;
        const on = device;
        if (unbuilt(chat.mem)) {
          yield* enter("waiting");
          yield* settle(chat.mem);
        }
        const view = render(chat.mem); // BEFORE the new messages are logged (gist §7)
        yield* enter("running");
        const { runId, texts } = yield* logQueued(on);
        steer = yield* Queue.unbounded<string>();
        sent = [];
        const earlier: Logged[] = [];
        const input = { device: on, earlier, sent, steer, texts, view };
        const out: TurnEvents = {
          info,
          log: (kind, text) =>
            log(kind, text, runId, on).pipe(
              Effect.tap(() => Effect.sync(() => earlier.push({ kind, text }))), // what a failover mid-turn carries on from
              Effect.asVoid,
            ),
          text: (delta) => stream(delta, runId),
          thinking: (tokens) => publish({ runId, tokens, type: "thinking" }),
          usage: (record) => o.logUsage(record).pipe(Effect.andThen(publish({ record, type: "usage" }))),
        };
        yield* beginRun(runId);
        yield* tell;
        const result = yield* failover(
          o.engines.map((e) => ({
            ref: e.ref,
            run: (from: string | null) => Effect.suspend(() => ((engine = e.ref), tell)).pipe(Effect.andThen(e.run(input, out, from))),
          })),
          // a failover mid-turn keeps what was logged: the next engine is told and carries on from it
          (from, to, why) => info(`${from} → ${to}: ${why}${earlier.length > 0 ? ` (after ${earlier.length} logged entries; ${to} carries on from them)` : ""}`),
        ).pipe(Effect.result);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            engine = null;
            // the leftovers go first in the queue: they came before anything queued since. After a
            // result they get a fresh call with a new view; after a failure they are logged, unanswered.
            const leftover = (yield* drainLeftovers).map((text) => ({ device: on, text }));
            queue.unshift(...leftover);
            if (result._tag === "Success") return yield* endRun(null);
            yield* info(failureText(result.failure));
            yield* endRun(result.failure.message);
            yield* logFirst(leftover.length, null);
          }),
        );
      }
    });

    // The loop is over: the data dir is committed before the session says "idle", so a client that
    // sees idle sees the commit. A message that came in while the loop wound down starts it again,
    // unless the loop stopped on an error: then it waits for the next message, and its sender is told.
    const afterLoop = Effect.gen(function* () {
      engine = null;
      yield* endRun("the turn stopped"); // a run the loop left without an end
      const failed = yield* o.commit;
      if (failed) yield* info(`git: ${failed}`);
      yield* Effect.suspend(() => {
        running = false;
        loop = null;
        if (queue.length > 0 && halted === null) return start;
        const why = halted;
        halted = null;
        phase = "idle";
        const told = why === null ? Effect.void : Effect.forEach(queue, (q) => nack(q.text, why), { discard: true });
        return told.pipe(Effect.andThen(tell), Effect.andThen(primeLater), Effect.andThen(warm));
      });
    });

    // The loop ended early: a cancel (an interrupt only), a store error or a defect. Nothing sent
    // is lost (gist §7). What the call never took goes back to the queue; after a cancel or a
    // defect everything queued is logged unanswered, and whatever the log refuses stays queued.
    // After an error the loop waits for the next message: a defect that comes before the messages
    // are logged would otherwise start it again at once, forever.
    const stopped = (cause: Cause.Cause<StoreError>) =>
      Effect.gen(function* () {
        const cancelled = Cause.hasInterruptsOnly(cause);
        const refused = cancelled || Cause.hasDies(cause) ? Option.none() : Cause.findErrorOption(cause);
        const why = cancelled ? "cancelled" : Option.match(refused, { onNone: () => `the turn stopped: ${thrown(cause)}`, onSome: (e) => e.message });
        queue.unshift(...(yield* drainLeftovers).map((text) => ({ device, text })));
        const inRun = current !== null;
        yield* endRun(why); // the run's end says it
        if (!cancelled) {
          halted = why;
          yield* info(`error: ${why}`);
        }
        if (Option.isSome(refused)) return; // the log refuses: they stay queued
        yield* logFirst(queue.length, null);
        if (cancelled && !inRun) yield* info("cancelled"); // before any run started: waiting for summaries
      }).pipe(Effect.catch((error: StoreError) => Effect.sync(() => (halted = error.message)).pipe(Effect.andThen(info(`error: ${error.message}`)))));

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
        if (clientId !== undefined) pending.push({ id: clientId, text });
        const picked = on && o.devices.includes(on) ? on : deviceOf(text, o.devices);
        if (steer && phase === "running") {
          yield* Queue.offer(steer, text);
          yield* tell;
          return;
        }
        queue.push({ device: picked, text });
        yield* start;
        yield* tell;
      });

    const cancel = Effect.suspend(() => (loop ? Fiber.interrupt(loop) : Effect.void));
    const primeSoon = Effect.asVoid(primeNow);

    return { cancel, events, input, live, primeSoon, state, tell };
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

