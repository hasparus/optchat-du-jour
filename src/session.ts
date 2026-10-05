// The session (ref §5.2, E1): the one turn loop the server owns. Messages queue up and start a
// turn; a message sent while a turn runs is steered into it. Every client sees the same events.
import { type Duration, Effect, Fiber, Option, PubSub, Queue, type Scope } from "effect";
import { PRIME_IDLE } from "./config.ts";
import type { Chat } from "./chat.ts";
import { failover } from "./engines/chain.ts";
import type { EngineError } from "./engines/errors.ts";
import type { StoreError } from "./store.ts";
import type { Entry } from "./tree.ts";
import type { Logged, Sent, TurnEngine, TurnEvents } from "./turn/engine.ts";
import type { UsageRecord } from "./usage.ts";
import { allBuilt, render, settle, unbuilt, viewSize } from "./view.ts";

export type Phase = "idle" | "priming" | "running" | "waiting";

export type SessionState = {
  readonly phase: Phase;
  readonly device: string; // where the next or current turn runs
  readonly engine: string | null; // the engine of the current turn
  readonly waiting: number; // view lines not summarized yet
  readonly viewBytes: number;
  readonly budget: number;
  readonly messages: number;
  readonly queued: readonly string[]; // sent mid-run, not taken by the call yet
};

export type SessionEvent =
  | { readonly type: "logged"; readonly entry: Entry; readonly runId: string | null }
  // `at`: the log index the reply's talk entry will get, taken when the delta is published
  | { readonly type: "text"; readonly delta: string; readonly runId: string; readonly at: number }
  | { readonly type: "thinking"; readonly tokens: number; readonly runId: string }
  | { readonly type: "run-started"; readonly runId: string }
  | { readonly type: "run-finished"; readonly runId: string; readonly error: string | null }
  | { readonly type: "info"; readonly message: string }
  | { readonly type: "usage"; readonly record: UsageRecord }
  | { readonly type: "state"; readonly state: SessionState };

export type Session = {
  // a message from a client: it starts a turn, or joins the running one
  readonly input: (text: string, device?: string) => Effect.Effect<void>;
  // the user's cancel: the wait or the turn stops; nothing sent is lost
  readonly cancel: Effect.Effect<void>;
  readonly events: PubSub.PubSub<SessionEvent>;
  readonly state: () => SessionState;
  // a client connected: a message usually follows, so prime the view (SPEC "Turn and priming")
  readonly primeSoon: Effect.Effect<void>;
};

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
  readonly commit: Effect.Effect<string | null>; // persist the data dir; an error message or null
  readonly logUsage: (record: UsageRecord) => Effect.Effect<void>;
  readonly idle?: Duration.Input; // PRIME_IDLE
}): Effect.Effect<Session, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { chat } = o;
    const events = yield* PubSub.unbounded<SessionEvent>();
    const publish = (e: SessionEvent) => PubSub.publish(events, e).pipe(Effect.asVoid);
    const info = (message: string) => publish({ message, type: "info" });

    let queue: { text: string; device: string | null }[] = [];
    let phase: Phase = "idle", device = o.defaultDevice, engine: string | null = null;
    let steer: Queue.Queue<string> | null = null;
    let sent: Sent[] = [];
    let running = false; // the turn loop is on: set before its fiber starts, cleared as it ends
    let loop: Fiber.Fiber<void> | null = null; // that fiber, for a cancel
    let storeFailed = false; // the loop ended on a store error: what is still queued waits for the next message

    // what the running call has been given but not taken yet
    const notTaken = () => sent.flatMap((m) => (m.taken ? [] : [m.text]));

    const state = (): SessionState => ({
      budget: chat.mem.budget,
      device,
      engine,
      messages: chat.mem.root.length,
      phase,
      queued: notTaken(),
      viewBytes: viewSize(chat.mem),
      waiting: unbuilt(chat.mem),
    });
    const tell = Effect.suspend(() => publish({ state: state(), type: "state" }));
    const enter = (p: Phase) => Effect.suspend(() => ((phase = p), tell));

    const log = (kind: Entry["kind"], text: string, runId: string | null, on: string | null) =>
      chat.log(kind, text, on ? { device: on } : {}).pipe(Effect.tap((entry) => publish({ entry, runId, type: "logged" })));

    // the view changed (a message, a node): once it has been quiet for PRIME_IDLE and no turn runs,
    // prime it in the background. One fiber debounces every change, so bursts start one timer.
    const primer = o.engines[0]?.prime;
    const scope = yield* Effect.scope;
    const changes = yield* Queue.sliding<true>(1);
    const primeLater = Queue.offer(changes, true);
    if (primer) {
      const quiet = o.idle ?? PRIME_IDLE;
      yield* Effect.gen(function* () {
        yield* Queue.take(changes);
        while (Option.isSome(yield* Queue.take(changes).pipe(Effect.timeoutOption(quiet)))) {
          // changed again within PRIME_IDLE: wait for quiet from here
        }
        if (!running && allBuilt(chat.mem)) yield* primer(render(chat.mem), o.defaultDevice);
      }).pipe(Effect.forever, Effect.forkIn(scope));
    }
    const onViewChange = () => {
      Effect.runFork(Effect.andThen(tell, primeLater));
    };
    chat.mem.listeners.add(onViewChange);
    yield* Effect.addFinalizer(() => Effect.sync(() => chat.mem.listeners.delete(onViewChange)));

    // the messages nobody answered stay in the log (gist §7: nothing is lost)
    const logUnanswered = (texts: readonly { text: string; device: string | null }[]) =>
      Effect.forEach(texts, (t) => log("user", t.text, null, t.device), { discard: true });

    // The queued texts become user entries. Each leaves the queue only once it is in the log, and
    // the whole pass is uninterruptible, so a cancel finds every message logged or still queued.
    const logQueued = (on: string) =>
      Effect.gen(function* () {
        const texts: string[] = [];
        let first: number | null = null;
        for (let n = queue.length; n > 0; n--) {
          const head = queue[0];
          if (!head) break;
          const entry = yield* log("user", head.text, null, on);
          queue.shift();
          texts.push(head.text);
          first ??= entry.i;
        }
        return { runId: String(first ?? chat.mem.root.length), texts };
      }).pipe(Effect.uninterruptible);

    const turn = Effect.gen(function* () {
      while (queue.length > 0) {
        device = queue.findLast((q) => q.device)?.device ?? o.defaultDevice;
        const on = device;
        if (unbuilt(chat.mem)) {
          yield* enter("waiting");
          yield* settle(chat.mem);
        }
        const view = render(chat.mem); // BEFORE the new messages are logged (gist §7)
        const lead = o.engines[0];
        if (lead?.prime) {
          yield* enter("priming");
          // a fiber of the session's own: a cancel stops this wait, the priming call itself finishes (ref §6)
          yield* Fiber.join(yield* Effect.forkIn(lead.prime(view, on), scope));
        }
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
              Effect.tap(() => Effect.sync(() => earlier.push({ kind, text }))),
              Effect.asVoid,
            ),
          text: (delta) => publish({ at: chat.mem.root.length, delta, runId, type: "text" }),
          thinking: (tokens) => publish({ runId, tokens, type: "thinking" }),
          usage: (record) => o.logUsage(record).pipe(Effect.andThen(publish({ record, type: "usage" }))),
        };
        yield* publish({ runId, type: "run-started" });
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
            // messages the call never took, and those still on their way to it; closed first, so
            // nothing more can be steered into a call that is over
            const closed = steer;
            steer = null;
            const untaken = notTaken();
            sent = [];
            const leftover = [...untaken, ...(closed ? yield* Queue.clear(closed) : [])].map((text) => ({ device: on, text }));
            // after a result they get a fresh call with a new view; after a failure they stay in the log, unanswered
            if (result._tag === "Success") queue.unshift(...leftover);
            else {
              yield* info(failureText(result.failure));
              yield* logUnanswered(leftover);
            }
            yield* publish({ error: result._tag === "Success" ? null : result.failure.message, runId, type: "run-finished" });
          }),
        );
      }
    });

    // The loop is over: the data dir is committed before the session says "idle", so a client that
    // sees idle sees the commit. A message that came in while the loop wound down starts it again.
    const afterLoop = Effect.gen(function* () {
      engine = null;
      const failed = yield* o.commit;
      if (failed) yield* info(`git: ${failed}`);
      yield* Effect.suspend(() => {
        running = false;
        loop = null;
        if (queue.length > 0 && !storeFailed) return start;
        storeFailed = false;
        phase = "idle";
        return tell.pipe(Effect.andThen(primeLater));
      });
    });

    // a cancel: the queued and the untaken messages are logged unanswered, the call is killed
    const onCancel = Effect.suspend(() => {
      const left = [...queue, ...notTaken().map((text) => ({ device, text }))];
      queue = [];
      sent = [];
      const pending = steer;
      steer = null;
      return Effect.gen(function* () {
        const more = pending ? yield* Queue.clear(pending) : [];
        yield* logUnanswered([...left, ...more.map((text) => ({ device, text }))]);
        yield* info("cancelled");
      });
    });

    const start: Effect.Effect<void> = Effect.suspend(() => {
      if (running) return Effect.void;
      running = true;
      phase = "running"; // until the loop says what it waits for: never "idle" while it is on
      return turn.pipe(
        Effect.catch((error: StoreError) => Effect.sync(() => (storeFailed = true)).pipe(Effect.andThen(info(`error: ${error.message}`)))),
        Effect.onInterrupt(() => onCancel.pipe(Effect.ignore)),
        Effect.ensuring(afterLoop),
        Effect.forkIn(scope),
        Effect.tap((fiber) => Effect.sync(() => (loop = fiber))),
        Effect.asVoid,
      );
    });

    const input = (text: string, on?: string) =>
      Effect.gen(function* () {
        if (text.trim() === "") return; // nothing to answer: no turn, no empty user entry
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
    const primeSoon = Effect.suspend(() =>
      !primer || running || !allBuilt(chat.mem) ? Effect.void : primer(render(chat.mem), o.defaultDevice).pipe(Effect.forkIn(scope), Effect.asVoid),
    );

    return { cancel, events, input, primeSoon, state };
  });

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

