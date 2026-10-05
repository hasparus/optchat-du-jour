// The session (ref §5.2, E1): the one turn loop the server owns. Messages wait in one inbox and
// start a turn; a message sent while a turn runs is offered to its call. Every client sees the
// same events. Priming runs only while idle, and a turn never waits for it (E17, SPEC "Turn and
// priming").
import { Cause, Deferred, type Duration, Effect, Exit, Fiber, FiberSet, Option, PubSub, Queue, type Scope } from "effect";
import { PRIME_IDLE } from "./config.ts";
import type { Chat } from "./chat.ts";
import { type DownList, failover } from "./engines/chain.ts";
import type { EngineError } from "./engines/errors.ts";
import type { StoreError } from "./store.ts";
import type { Entry } from "./tree.ts";
import { type Look, pictureBudget } from "./media/budget.ts";
import type { Part } from "./media/part.ts";
import { BLIND, type Mid, type TurnEngine, type TurnEvents } from "./turn/engine.ts";
import type { UsageRecord } from "./usage.ts";
import { allBuilt, render, settle, unbuilt, viewSize } from "./view.ts";
import { type Asset, MAX_ATTACHMENTS, markerOf, NOT_DESCRIBED, type Phase, type SessionState, withMarkers } from "./wire.ts";

// the state every client is shown (STATE_SNAPSHOT, STATE_DELTA, /api/state): src/wire.ts
export type { Phase, SessionState } from "./wire.ts";

export type SessionEvent =
  | { readonly type: "logged"; readonly entry: Entry; readonly runId: string | null }
  // `at`: the log index the reply's talk entry will get, taken when the delta is published;
  // `offset`: where the delta starts in that reply's text so far
  | { readonly type: "text"; readonly delta: string; readonly runId: string; readonly at: number; readonly offset: number }
  | { readonly type: "thinking"; readonly tokens: number; readonly runId: string }
  // the reply streaming in was dropped unlogged (the engine failed over): the next one streams anew
  | { readonly type: "reply-dropped"; readonly runId: string }
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
  // `media`: its attachments, already in the asset store (SPEC "Media")
  readonly input: (text: string, device?: string, clientId?: string, media?: readonly Asset[]) => Effect.Effect<void>;
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

// A message from a client, the session's until it is logged: "held" for a turn, or "offered" to
// the running call, which may take it (it is logged then) or leave it (it comes back "held" when
// the call ends). Each carries the id its client sent it with, so its ack names it. (The state
// clients see lists all of them as `pending`.)
type Incoming = {
  readonly seq: number; // the order messages came in
  readonly text: string; // as typed; the log gets it with a marker line per attachment
  readonly media: readonly Asset[];
  device: string | null; // the device it was sent for; one a call left gets that call's device
  readonly clientId: string | null;
  state: "held" | "offered";
  // the captions of its attachments, asked for once (`captionsOf`); null until someone needs them
  described: Deferred.Deferred<readonly string[]> | null;
};

// What the session needs of the media service (src/media/media.ts) for attachments: a caption,
// waited for at most a few seconds, and an attachment's pictures as the picture budget planned them.
export type SessionMedia = {
  readonly caption: (a: Asset) => Effect.Effect<string>;
  readonly parts: (a: Asset, look: Look, capped: boolean) => Part[];
};

// no captions and no pictures: for a session that is not tested on attachments
export const noMedia: SessionMedia = { caption: () => Effect.succeed(NOT_DESCRIBED), parts: () => [] };

export const makeSession = (o: {
  readonly chat: Chat;
  readonly media: SessionMedia;
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

    // every message not logged yet, in the order they came in: the offered ones, then the held
    // ones; nothing is offered once anything is held, so the log keeps the order they were sent in
    const inbox: Incoming[] = [];
    let seq = 0;
    let phase: Phase = "idle", device = o.defaultDevice, engine: string | null = null;
    // a turn's call accepts mid-run messages, and the queue the call running now reads them from
    let accepting = false;
    let offerTo: Queue.Queue<Incoming> | null = null;
    let running = false; // the turn loop is on: set before its fiber starts, cleared as it ends
    let loop: Fiber.Fiber<void> | null = null; // that fiber, for a cancel
    // the loop stopped on an error (the log refused, or a defect), why, and the last message in by
    // then: those wait for a newer message instead of starting the loop again at once
    let halted: { readonly why: string; readonly upTo: number } | null = null;
    // the store's refusal the turn's result said already, so the stop it may lead to does not say it twice
    let told: string | null = null;

    const held = () => inbox.filter((m) => m.state === "held");
    // a message sent for no device, or for the one the turn runs on, may join it; one sent for
    // another waits, and the turn after it runs there (SPEC "Turn and priming")
    const forThis = (sentFor: string | null, on = device) => sentFor === null || sentFor === on;
    // The next turn's device and messages: the device of the first held message that has one (sent
    // for it, or left by a call that ran there), else the default; and the held messages up to the
    // first one for another device, which waits for the turn after, with all sent after it.
    const nextTurn = () => {
      const waiting = held();
      const on = waiting.find((m) => m.device)?.device ?? o.defaultDevice;
      const other = waiting.findIndex((m) => !forThis(m.device, on));
      return { batch: other === -1 ? waiting : waiting.slice(0, other), on };
    };
    const offered = () => inbox.filter((m) => m.state === "offered");

    const state = (): SessionState => ({
      budget: chat.mem.budget,
      device,
      down: o.compactorDown?.now() ?? [],
      engine,
      messages: chat.mem.root.length,
      phase,
      pending: inbox.map((m) => (m.media.length > 0 ? { attachments: m.media.length, clientId: m.clientId, text: m.text } : { clientId: m.clientId, text: m.text })),
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

    // A write and its bookkeeping are one step a cancel cannot split: an entry in the log is
    // always known to the session, never half-told.
    const log = (kind: Entry["kind"], text: string, on: string | null) =>
      chat.log(kind, text, on ? { device: on } : {}).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (current) current.reply = null; // the streamed text is logged now, or was left behind
          }),
        ),
        Effect.uninterruptible,
      );
    const published = (runId: string | null) => (entry: Entry) => publish({ entry, runId, type: "logged" });
    // an entry of the turn's engine: written and published, or neither is cut short by a cancel
    const logPublished = (kind: Entry["kind"], text: string, runId: string | null, on: string | null) =>
      log(kind, text, on).pipe(Effect.flatMap(published(runId)), Effect.uninterruptible);

    const scope = yield* Effect.scope;

    // A message's attachments' captions, each waited for at most media.captionWait, asked for once:
    // what the log keeps of the message and what an engine is sent of it come from this one answer,
    // so they agree, and a marker is never written without having waited for its caption.
    const captionsOf = (m: Incoming): Effect.Effect<readonly string[]> =>
      Effect.suspend(() => {
        if (m.described) return Deferred.await(m.described);
        const done = Deferred.makeUnsafe<readonly string[]>();
        m.described = done;
        return Effect.forEach(m.media, (a) => o.media.caption(a), { concurrency: "unbounded" }).pipe(
          Effect.flatMap((said) => Deferred.succeed(done, said)),
          Effect.forkIn(scope),
          Effect.andThen(Deferred.await(done)),
        );
      });
    // these messages' captions, asked for together: a turn waits once for the lot
    const captioned = (ms: readonly Incoming[]) => Effect.forEach(ms, captionsOf, { concurrency: "unbounded", discard: true });

    // A message's text as the log keeps it: what was typed, then a marker line per attachment with
    // its caption (SPEC "Media")
    const logText = (m: Incoming, said: readonly string[]) =>
      withMarkers(
        m.text,
        m.media.map((a, k) => markerOf(a, said[k] ?? NOT_DESCRIBED)),
      );

    // A message becomes a user entry, on device `on` or else the one it was sent for, once its
    // captions are in (the one place a marker is written). It leaves the inbox only once it is in
    // the log, so a failure finds it logged or still there, and its client is told which entry it
    // is before the entry goes out. The write is uninterruptible: a cancel between the write and
    // the inbox would log it twice. null: it was logged already (a second report of the same one).
    const logMessage = (m: Incoming, runId: string | null, on: string | null) =>
      captionsOf(m).pipe(
        Effect.flatMap((said) =>
          Effect.suspend(() => {
            if (!inbox.includes(m)) return Effect.succeed(null);
            return log("user", logText(m, said), on ?? m.device).pipe(
              Effect.tap((entry) =>
                Effect.suspend(() => {
                  inbox.splice(inbox.indexOf(m), 1);
                  return ack(m, entry.i, null).pipe(Effect.andThen(published(runId)(entry)));
                }),
              ),
              Effect.uninterruptible,
            );
          }),
        ),
      );
    // these messages, in order, logged unanswered (gist §7: nothing is lost)
    const logEach = (ms: readonly Incoming[]) => captioned(ms).pipe(Effect.andThen(Effect.forEach(ms, (m) => logMessage(m, null, null), { discard: true })));

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

    // the turn's messages, logged on `on`; uninterruptible, so a cancel finds each logged or held.
    // Their captions are in by now (the turn waited for them together).
    const logQueued = (batch: readonly Incoming[], on: string) =>
      Effect.gen(function* () {
        const entries: Entry[] = [];
        for (const m of batch) {
          const entry = yield* logMessage(m, null, on);
          if (entry !== null) entries.push(entry);
        }
        return String(entries[0]?.i ?? chat.mem.root.length);
      }).pipe(Effect.uninterruptible);

    // The call is over: nothing more is offered to it, and what it was offered and never took is
    // held again, on the call's device unless it was sent for one.
    const giveBack = (on: string) =>
      Effect.sync(() => {
        accepting = false;
        offerTo = null;
        const left = offered();
        for (const m of left) {
          m.state = "held";
          m.device ??= on;
        }
        return left;
      });

    // A call of one link of the chain, with its own queue of mid-run messages: first those offered
    // before it (to a link that failed over), then each one as it comes. `took` logs one it took.
    // An engine that is not sent images gets the marker lines only, and a note saying so. What
    // pictures a call is sent, the opening message's and each mid-run message's, is decided in
    // one place: `forEngine`, against the call's picture budget.
    // `taken`: the mid-run messages this turn's calls took so far; after a failover the next link
    // gets their pictures too, as they are in `earlier` only by their marker lines
    const call = (e: TurnEngine, batch: readonly Incoming[], base: { readonly device: string; readonly view: string }, from: string | null, out: TurnEvents, since: number, taken: readonly Incoming[]) =>
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<Incoming>();
        const budget = pictureBudget();
        // Messages as this engine is sent them: their texts as logged (with the captions the log
        // got) and their pictures, or for an engine not sent images a note instead.
        const forEngine = (ms: readonly Incoming[]) =>
          Effect.gen(function* () {
            const texts = yield* Effect.forEach(ms, (m) => Effect.map(captionsOf(m), (said) => logText(m, said)));
            const attached = ms.flatMap((m) => m.media);
            if (attached.length === 0) return { media: [], texts };
            if (!e.vision) return { media: [], texts: [...texts, BLIND] };
            const { capped, looks } = budget.take(attached);
            return { media: attached.flatMap((a, k) => o.media.parts(a, looks[k] ?? { how: "none" }, capped)), texts };
          });
        const midOf = (m: Incoming): Effect.Effect<Mid> => forEngine([m]).pipe(Effect.map(({ media, texts }) => ({ media, seq: m.seq, text: texts.join("\n") })));
        const { before, earlier } = yield* Effect.sync(() => {
          offerTo = q;
          for (const m of offered()) Queue.offerUnsafe(q, m);
          engine = e.ref;
          return { before: [...taken], earlier: chat.mem.root.slice(since).map(({ kind, text }) => ({ kind, text })) };
        });
        yield* tell;
        // the opening's pictures, then those of the mid-run messages a link before took, against
        // the same budget; their texts are in `earlier` already, so only a blind engine's note is added
        const asked = yield* forEngine(batch);
        const carried = yield* forEngine(before);
        const blind = carried.texts.includes(BLIND) && !asked.texts.includes(BLIND);
        const opening = { media: [...asked.media, ...carried.media], texts: blind ? [...asked.texts, BLIND] : asked.texts };
        const mid = {
          next: Queue.take(q).pipe(Effect.flatMap(midOf)),
          ready: Queue.clear(q).pipe(Effect.flatMap((ms) => captioned(ms).pipe(Effect.andThen(Effect.forEach(ms, midOf))))),
        };
        return yield* e.run({ ...base, ...opening, earlier, mid }, out, from);
      });

    const turn = Effect.gen(function* () {
      yield* FiberSet.clear(primes).pipe(Effect.forkIn(scope)); // not waited for: the killed claude may take a moment
      while (held().length > 0) {
        told = null;
        if (unbuilt(chat.mem)) {
          device = nextTurn().on; // shown while it waits; read again after, with what came in meanwhile
          yield* enter("waiting");
          yield* settle(chat.mem);
        }
        // This turn's device and messages are read once the summaries are in; their captions are
        // waited for together, briefly, before any is logged. One that comes in meanwhile waits for
        // the call below, where it is offered unless it, or one sent before it, is for another device.
        const { batch, on } = nextTurn();
        device = on;
        yield* captioned(batch);
        const view = render(chat.mem); // BEFORE the new messages are logged (gist §7)
        yield* enter("running");
        const runId = yield* logQueued(batch, on);
        const since = chat.mem.root.length; // what this turn's engines log starts here
        const taken: Incoming[] = []; // the mid-run messages its calls took, in the order they were logged
        accepting = true;
        // the ones that came in while the captions or the log were awaited, up to the first sent for
        // another device: it waits for the next turn, and so does everything sent after it
        for (const m of held()) {
          if (!forThis(m.device)) break;
          m.state = "offered";
        }
        const out: TurnEvents = {
          info,
          log: (kind, text) => logPublished(kind, text, runId, on),
          text: (delta) => stream(delta, runId),
          thinking: (tokens) => publish({ runId, tokens, type: "thinking" }),
          // the call passed this one to the model: logged now; a second report finds it gone (taken once)
          took: (mid) =>
            Effect.suspend(() => {
              const m = inbox.find((x) => x.seq === mid.seq && x.state === "offered");
              if (!m) return Effect.void;
              return logMessage(m, runId, on).pipe(
                Effect.tap((entry) =>
                  Effect.sync(() => {
                    if (entry !== null) taken.push(m);
                  }),
                ),
                Effect.andThen(tell),
              );
            }),
          usage: (record) => o.logUsage(record).pipe(Effect.andThen(publish({ record, type: "usage" }))),
        };
        yield* beginRun(runId);
        yield* tell;
        const base = { device: on, view };
        const result = yield* failover(
          o.engines.map((e) => ({ ref: e.ref, run: (from: string | null) => call(e, batch, base, from, out, since, taken) })),
          {
            // A failover mid-turn keeps what was logged: the next engine is told and carries on from
            // it. Text the engine before streamed and never logged is dropped, so the next engine's
            // reply is not glued to it.
            moved: (from, to, why) =>
              Effect.suspend(() => {
                const done = chat.mem.root.length - since;
                const dropped = current?.reply ? publish({ runId, type: "reply-dropped" }) : Effect.void;
                if (current) current.reply = null;
                return dropped.pipe(Effect.andThen(info(`${from} → ${to}: ${why}${done > 0 ? ` (after ${done} logged entries; ${to} carries on from them)` : ""}`)));
              }),
          },
        ).pipe(Effect.result);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            engine = null;
            // after a result what the call left gets a fresh call with a new view; after a failure
            // it is logged, unanswered
            const left = yield* giveBack(on);
            if (result._tag === "Success") return yield* endRun(null);
            told = result.failure._tag === "StoreError" ? result.failure.message : null;
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
        const already = told === why;
        told = null;
        if (!cancelled) {
          halted = { upTo: seq, why };
          if (!already) yield* info(`error: ${why}`);
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

    const input = (text: string, on?: string, clientId?: string, attached: readonly Asset[] = []) =>
      Effect.gen(function* () {
        const media = attached.slice(0, MAX_ATTACHMENTS);
        if (attached.length > media.length) yield* info(`at most ${MAX_ATTACHMENTS} attachments per message: ${attached.length - media.length} left out`);
        if (text.trim() === "" && media.length === 0) return; // nothing to answer: no turn, no empty user entry
        const picked = on && o.devices.includes(on) ? on : deviceOf(text, o.devices);
        // offered to the running call only when it runs where the message was sent for, and nothing
        // sent before it waits for the next turn: the log keeps the order they were sent in
        const offer = accepting && forThis(picked) && held().length === 0;
        const m: Incoming = { clientId: clientId ?? null, described: null, device: picked, media, seq: ++seq, state: offer ? "offered" : "held", text };
        inbox.push(m);
        if (m.state === "offered") {
          if (offerTo) Queue.offerUnsafe(offerTo, m);
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

