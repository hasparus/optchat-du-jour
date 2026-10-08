// The session (ref §5.2, E1): the one turn loop the server owns. Messages wait in one inbox and
// start a turn; a message sent while a turn runs is offered to its call (steer) or held for the
// next turn (queue), and a held one can be taken back. Each message names the engine of the
// master's chain it is for, and a turn runs on its messages' engine: a usage limit or an offline
// device stops it until a client resumes it on an engine (E4). Every client sees the same events.
// Priming runs only while idle, and a turn never waits for it (E17, SPEC "Turn and priming").
import { Cause, Deferred, type Duration, Effect, Exit, Fiber, FiberSet, Option, PubSub, Queue, type Scope } from "effect";
import type { Choices } from "./choices.ts";
import { PRIME_IDLE } from "./config.ts";
import type { Chat } from "./chat.ts";
import type { DownList } from "./engines/chain.ts";
import type { EngineError } from "./engines/errors.ts";
import type { StoreError } from "./store.ts";
import type { Entry } from "./tree.ts";
import { giveBack as returned, handOver, held, type Incoming, nextTurn, offered, steerIn as joining, takeBack as takenFrom, type Where } from "./inbox.ts";
import { makeMaster, type Master } from "./master.ts";
import { type Look, pictureBudget } from "./media/budget.ts";
import type { Part } from "./media/part.ts";
import { BLIND, type Mid, type TurnEngine, type TurnEvents } from "./turn/engine.ts";
import type { UsageRecord } from "./usage.ts";
import { allBuilt, render, settle, unbuilt, viewSize } from "./view.ts";
import { type Asset, engineLabel, type FollowUp, MAX_ATTACHMENTS, markerOf, NOT_DESCRIBED, type Phase, type SessionState, withMarkers } from "./wire.ts";

// the state every client is shown (STATE_SNAPSHOT, STATE_DELTA, /api/state): src/wire.ts
export type { FollowUp, Phase, SessionState } from "./wire.ts";

export type SessionEvent =
  | { readonly type: "logged"; readonly entry: Entry; readonly runId: string | null }
  // `at`: the log index the reply's talk entry will get, taken when the delta is published;
  // `offset`: where the delta starts in that reply's text so far
  | { readonly type: "text"; readonly delta: string; readonly runId: string; readonly at: number; readonly offset: number }
  | { readonly type: "thinking"; readonly tokens: number; readonly runId: string }
  // the reply streaming in was dropped unlogged (a usage limit stopped it): the next one streams anew
  | { readonly type: "reply-dropped"; readonly runId: string }
  | { readonly type: "run-started"; readonly runId: string }
  // every run-started gets exactly one, also after a cancel; `logged`: the log's length by then
  | { readonly type: "run-finished"; readonly runId: string; readonly error: string | null; readonly logged: number }
  | { readonly type: "info"; readonly message: string }
  // a client's message (`clientId`, its AG-UI id) became log entry `at`, or could not be logged:
  // `error`. A message the log refused stays in the inbox, and is acked again when it is logged.
  | { readonly type: "ack"; readonly clientId: string; readonly at: number | null; readonly error: string | null }
  // A client asked for a held message back (`clientId`, its sender's id for it): it left the inbox
  // and is `message` again, never logged; or it could not be taken back (`error`: a turn has it,
  // or the server holds no such message).
  | {
      readonly type: "taken-back";
      readonly clientId: string;
      readonly message: { readonly text: string; readonly media: readonly Asset[] } | null;
      readonly error: string | null;
    }
  | { readonly type: "usage"; readonly record: UsageRecord }
  | { readonly type: "state"; readonly state: SessionState };

export type Session = {
  // a message from a client: it starts a turn, or joins the running one (InputOptions say how)
  readonly input: (text: string, o?: InputOptions) => Effect.Effect<void>;
  // a client wants a held message back: a "taken-back" event says whether it got it
  readonly takeBack: (clientId: string) => Effect.Effect<void>;
  // the session's settings, shared by every client: what a mid-run message does
  readonly configure: (change: Choices) => Effect.Effect<void>;
  // a turn waiting in "needs-model" goes on, on this engine of the master's chain (the one that
  // stopped it again is a retry); at any other time it is answered with an info
  readonly resume: (engine: string) => Effect.Effect<void>;
  // the user's cancel: the wait or the turn stops; nothing sent is lost
  readonly cancel: Effect.Effect<void>;
  readonly events: PubSub.PubSub<SessionEvent>;
  readonly state: () => SessionState;
  // a client connected: a message usually follows, so prime the view (SPEC "Turn and priming")
  readonly primeSoon: Effect.Effect<void>;
  // the run going on, and the reply it is streaming (not logged yet), for a client joining now
  readonly live: () => LiveRun | null;
};

// A message's options, shaped like the RunAgentInput's forwardedProps it came with: `device` and
// `engine` (a ref of the master's chain; the chain's first when none) it is for, and `followUp`,
// what it does if a turn runs, when not the session's setting. With a `clientId` the client is
// told (an "ack") which log entry it became, or that it could not be logged. `media`: its
// attachments, already in the asset store (SPEC "Media").
export type InputOptions = {
  readonly device?: string;
  readonly engine?: string;
  readonly followUp?: FollowUp;
  readonly clientId?: string;
  readonly media?: readonly Asset[];
};

export type LiveRun = { readonly runId: string; readonly reply: { readonly at: number; readonly text: string } | null };

// "/on macbook ..." picks the device for that turn; the text stays as typed
export const deviceOf = (text: string, devices: readonly string[]) => {
  const m = /^\/on\s+(\S+)/.exec(text);
  return m?.[1] && devices.includes(m[1]) ? m[1] : null;
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
  // the clients' choices it starts with (follow-ups "steer" unless set), and where each change
  // goes, so a restart keeps them (src/choices.ts)
  readonly choices?: Choices;
  readonly saveChoices?: (c: Choices) => Effect.Effect<void>;
  // the chain's down marks and the engine warm processes follow (src/master.ts), when the server
  // made it first for its engines to ask; else the session's own
  readonly master?: Master;
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

    // every message not logged yet, in the order they came in (src/inbox.ts has its rules)
    const inbox: Incoming[] = [];
    let seq = 0;
    let phase: Phase = "idle", device = o.defaultDevice, engine: string | null = null;
    // the setting every client shares (`configure`): what a mid-run message does
    let followUp: FollowUp = o.choices?.followUp ?? "steer";
    const master = o.master ?? (yield* makeMaster(o.engines.map((e) => e.ref)));
    const engineOf = (ref: string) => o.engines.find((e) => e.ref === ref);
    // the engine whose spawns are kept warm and primed: the most recent turn's (E18)
    const latest = () => engineOf(master.latest());
    // where the call that accepts mid-run messages runs, and the queue it reads them from
    let accepting: Where | null = null;
    let offerTo: Queue.Queue<Incoming> | null = null;
    // a turn a usage limit or an offline device stopped: its engine and why, and what a resume settles
    let stalled: { readonly ref: string; readonly why: string; readonly resume: Deferred.Deferred<string> } | null = null;
    let running = false; // the turn loop is on: set before its fiber starts, cleared as it ends
    let loop: Fiber.Fiber<void> | null = null; // that fiber, for a cancel
    // the loop stopped on an error (the log refused, or a defect), why, and the last message in by
    // then: those wait for a newer message instead of starting the loop again at once
    let halted: { readonly why: string; readonly upTo: number } | null = null;


    const state = (): SessionState => ({
      budget: chat.mem.marks.high,
      device,
      down: o.compactorDown?.now() ?? [],
      engine,
      messages: chat.mem.root.length,
      phase,
      pending: inbox.map((m) => {
        const queued = m.state === "held";
        const one = { clientId: m.clientId, engine: m.engine, queued, text: m.text };
        return m.media.length > 0 ? { ...one, media: m.media } : one;
      }),
      viewBytes: viewSize(chat.mem),
      waiting: unbuilt(chat.mem),
      followUp,
      engines: master.engines(),
      stopped: stalled && { label: engineLabel(stalled.ref), ref: stalled.ref, why: stalled.why },
    });
    const tell = Effect.suspend(() => publish({ state: state(), type: "state" }));
    const enter = (p: Phase) => Effect.suspend(() => ((phase = p), tell));
    // an engine's down mark lapsed: clients see it in the state
    const lapses = yield* PubSub.subscribe(master.changes);
    yield* PubSub.take(lapses).pipe(Effect.andThen(tell), Effect.forever, Effect.forkScoped);
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

    // The one end of a run: published before the session logs anything outside it (what a failed
    // or cancelled turn leaves unanswered), so a reply left open (a cancel, a crash) is closed
    // before its log index goes to another entry. The run's own last entries come before it, also
    // on a cancel: our tool loop answers a call cut short with `not run: cancelled` as that call
    // unwinds (src/turn/loop.ts), under the run's id, before the loop gets here.
    const endRun = (error: string | null) =>
      Effect.suspend(() => {
        if (!current) return Effect.void;
        const { runId } = current;
        current = null;
        return publish({ error, logged: chat.mem.root.length, runId, type: "run-finished" });
      });

    // Priming happens only while idle, in fibers of `primes`. A turn that starts stops them
    // instead of waiting (E17): its own request writes the same prefix to the cache. Priming and
    // the warm process are the most recent turn's engine's, the chain's first before any (E18).
    const primes = yield* FiberSet.make();
    // An engine marked down is not primed: after a cancel in "needs-model" the most recent turn's
    // engine is the one that just hit its limit.
    const primeNow = Effect.suspend(() => {
      const e = latest();
      const primer = e && !master.isDown(e.ref) ? e.prime : undefined;
      return !primer || running || !allBuilt(chat.mem) ? Effect.succeed(null) : FiberSet.run(primes, primer(render(chat.mem), o.defaultDevice));
    });
    // the next turn's and priming's claude, started ahead on the default device (E18)
    const warm = Effect.suspend(() => latest()?.warm(o.defaultDevice).pipe(Effect.forkIn(scope), Effect.asVoid) ?? Effect.void);

    // the view changed (a message, a node): once it has been quiet for PRIME_IDLE and no turn runs,
    // prime it in the background. One fiber debounces every change, so bursts start one timer.
    const changes = yield* Queue.sliding<true>(1);
    const primeLater = Queue.offer(changes, true);
    if (o.engines.some((e) => e.prime)) {
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
    // the view changed (the memory's listener, a plain callback): the state goes out and priming is
    // asked for, in a fiber of the session's own scope and services, not a detached one
    const runFork = yield* FiberSet.makeRuntime();
    const onViewChange = () => {
      runFork(Effect.andThen(tell, primeLater));
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

    // The call is over, or its turn stopped: nothing more is offered to it, and what it was
    // offered and never took is held again (src/inbox.ts giveBack). Returns the offered ones.
    const giveBack = (on: string) =>
      Effect.sync(() => {
        accepting = null;
        offerTo = null;
        return returned(inbox, on);
      });

    // a call accepts mid-run messages again: the held ones that join it (src/inbox.ts steerIn)
    const steerIn = (at: Where) => {
      for (const m of joining(inbox, at)) if (offerTo) Queue.offerUnsafe(offerTo, m);
    };

    // A turn stopped by a usage limit or an offline device waits for a resume. What it logged
    // stays, the text it streamed and never logged is dropped (the next engine's reply is not glued
    // to it), what its call never took is held again, and no call accepts mid-run messages while it
    // waits: a message sent meanwhile is held, so it can be taken back. Clients learn why from the
    // state (`stopped`, phase "needs-model"), set before the run's end, so they show it once, as the
    // prompt to resume; the resume's notice is the record. The data dir is committed, since a
    // resume may take hours. On a resume, the held messages for the stopped engine (src/inbox.ts
    // handOver) go to the engine resumed on, and join its call (if they steer); one for another
    // engine waits behind them. The resumed run has a run id of its own. A cancel while it waits
    // ends the loop like any cancel.
    let resumes = 0; // runs resumed, for their run ids
    const stall = (ref: string, why: string, runId: string, since: number, on: string) =>
      Effect.gen(function* () {
        engine = null;
        if (current?.reply) yield* publish({ runId, type: "reply-dropped" });
        if (current) current.reply = null;
        yield* giveBack(on);
        const done = chat.mem.root.length - since;
        // waiting for a resume before the run's end goes out: a client that resumes on seeing it is heard
        const resume = Deferred.makeUnsafe<string>();
        stalled = { ref, resume, why };
        yield* enter("needs-model");
        yield* endRun(why);
        const failed = yield* o.commit;
        if (failed) yield* info(`git: ${failed}`);
        const next = yield* Deferred.await(resume);
        const resumed = `${runId.split("+")[0] ?? runId}+${++resumes}`;
        yield* Effect.sync(() => {
          stalled = null;
          handOver(inbox, { engine: ref, on }, next);
          phase = "running";
          accepting = { engine: next, on };
          steerIn(accepting);
        });
        yield* beginRun(resumed);
        const goesOn = next === ref ? "tried again" : `${engineLabel(next)} carries on`;
        yield* info(`${engineLabel(ref)} stopped (${why}); ${goesOn}${done > 0 ? ` from the ${done} logged entries` : ""}`);
        return { next, runId: resumed };
      });

    // A call of one engine, with its own queue of mid-run messages: first those offered before it
    // (to a call a usage limit stopped), then each one as it comes. `took` logs one it took.
    // An engine that is not sent images gets the marker lines only, and a note saying so. What
    // pictures a call is sent, the opening message's and each mid-run message's, is decided in
    // one place: `forEngine`, against the call's picture budget.
    // `taken`: the mid-run messages this turn's calls took so far; after a stop, the engine it is
    // resumed on gets their pictures too, as they are in `earlier` only by their marker lines
    const call = (e: TurnEngine, batch: readonly Incoming[], base: { readonly device: string; readonly view: string }, from: string | null, out: TurnEvents, since: number, taken: readonly Incoming[]) =>
      Effect.gen(function* () {
        const q = yield* Queue.unbounded<Incoming>();
        const budget = pictureBudget();
        // The pictures of these messages' attachments, as the budget plans them; an engine not sent
        // images gets none, and `blind`: the note saying so is due.
        const picturesOf = (ms: readonly Incoming[]) => {
          const attached = ms.flatMap((m) => m.media);
          if (attached.length === 0 || !e.vision) return { blind: attached.length > 0, media: [] };
          const { capped, looks } = budget.take(attached);
          return { blind: false, media: attached.flatMap((a, k) => o.media.parts(a, looks[k] ?? { how: "none" }, capped)) };
        };
        // Messages as this engine is sent them: their texts as logged (with the captions the log
        // got), and their pictures or the note. `carried`: messages whose text it has already (in
        // `earlier`), sent only their pictures.
        const forEngine = (ms: readonly Incoming[], carried: readonly Incoming[] = []) =>
          Effect.gen(function* () {
            const texts = yield* Effect.forEach(ms, (m) => Effect.map(captionsOf(m), (said) => logText(m, said)));
            const { blind, media } = picturesOf([...ms, ...carried]);
            return { media, texts: blind ? [...texts, BLIND] : texts };
          });
        const midOf = (m: Incoming): Effect.Effect<Mid> => forEngine([m]).pipe(Effect.map(({ media, texts }) => ({ media, seq: m.seq, text: texts.join("\n") })));
        const { before, earlier } = yield* Effect.sync(() => {
          offerTo = q;
          for (const m of offered(inbox)) Queue.offerUnsafe(q, m);
          engine = e.ref;
          master.ran(e.ref);
          return { before: [...taken], earlier: chat.mem.root.slice(since).map(({ kind, text }) => ({ kind, text })) };
        });
        yield* tell;
        // the opening's pictures, then those of the mid-run messages a call before took
        const opening = yield* forEngine(batch, before);
        const mid = {
          next: Queue.take(q).pipe(Effect.flatMap(midOf)),
          ready: Queue.clear(q).pipe(Effect.flatMap((ms) => captioned(ms).pipe(Effect.andThen(Effect.forEach(ms, midOf))))),
        };
        return yield* e.run({ ...base, ...opening, again: from === e.ref, earlier, mid }, out, from);
      });

    const turn = Effect.gen(function* () {
      yield* FiberSet.clear(primes).pipe(Effect.forkIn(scope)); // not waited for: the killed claude may take a moment
      while (held(inbox).length > 0) {
        if (unbuilt(chat.mem)) {
          device = nextTurn(inbox, o.defaultDevice).on; // shown while it waits; read again after, with what came in meanwhile
          yield* enter("waiting");
          yield* settle(chat.mem);
        }
        // This turn's device, engine and messages are read once the summaries are in, and picked at
        // once, so none can be taken back any more; their captions are waited for together,
        // briefly, before any is logged. One that comes in meanwhile waits for the call below, where
        // it is offered if it steers (`steerIn`). All taken back while waiting: no turn.
        const { batch, engine: ref0, on } = nextTurn(inbox, o.defaultDevice);
        if (batch.length === 0) continue;
        device = on;
        for (const m of batch) m.state = "picked";
        yield* captioned(batch);
        const view = render(chat.mem); // BEFORE the new messages are logged (gist §7)
        yield* enter("running");
        let runId = yield* logQueued(batch, on); // a resumed run gets one of its own (`stall`)
        const since = chat.mem.root.length; // what this turn's engines log starts here
        const taken: Incoming[] = []; // the mid-run messages its calls took, in the order they were logged
        accepting = { engine: ref0, on };
        steerIn(accepting); // came in while the captions or the log were awaited
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
        // The turn runs on its messages' engine only: the master never fails over by itself (E4),
        // since the user chooses which plan pays. A usage limit or an offline device stops it
        // until a client resumes it on an engine (`stall`), which then carries on (E16).
        const attempt = (ref: string, from: string | null) =>
          Effect.suspend(() => {
            const e = engineOf(ref);
            if (!e) return Effect.die(new Error(`${ref || "an empty engine chain"}: no such engine in the master's chain`));
            return call(e, batch, base, from, out, since, taken).pipe(
              Effect.tapError((error) => (error._tag === "UsageLimit" ? master.wentDown(e.ref, error.message).pipe(Effect.andThen(tell)) : Effect.void)),
              Effect.tap(() => (master.cameBack(e.ref) ? tell : Effect.void)),
              Effect.result,
            );
          });
        let ref = ref0;
        let result = yield* attempt(ref, null);
        while (result._tag === "Failure" && waitsForResume(result.failure)) {
          const resumed = yield* stall(ref, failureText(result.failure), runId, since, on);
          runId = resumed.runId;
          result = yield* attempt(resumed.next, ref);
          ref = resumed.next;
        }
        const refused = yield* Effect.uninterruptible(
          Effect.gen(function* () {
            engine = null;
            // after a result what the call left gets a fresh call with a new view; after a failure
            // it is logged, unanswered
            const left = yield* giveBack(on);
            if (result._tag === "Success") return yield* endRun(null).pipe(Effect.as(false));
            const { failure } = result;
            yield* info(failureText(failure));
            yield* endRun(failure.message);
            // The log refuses what the call left: it stays in the inbox, and the loop stops as on
            // any refusal (`stopped`), saying why unless the turn's own failure just said it.
            return yield* logEach(left).pipe(
              Effect.as(false),
              Effect.catch((error: StoreError) =>
                Effect.gen(function* () {
                  halted = { upTo: seq, why: error.message };
                  if (failure._tag !== "StoreError" || failure.message !== error.message) yield* info(`error: ${error.message}`);
                  return true;
                }),
              ),
            );
          }),
        );
        if (refused) return;
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
        stalled = null; // no longer waiting for a resume
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

    // A message is held; while a call accepts mid-run messages it joins that call if it steers
    // (`steerIn`), else it waits for the next turn, which the loop starts when the call ends.
    // A message for no engine, or for one the chain doesn't have (said), is for the chain's first.
    const input = (text: string, { clientId, device: on, engine: asked, followUp: how, media: attached = [] }: InputOptions = {}) =>
      Effect.gen(function* () {
        const media = attached.slice(0, MAX_ATTACHMENTS);
        if (attached.length > media.length) yield* info(`at most ${MAX_ATTACHMENTS} attachments per message: ${attached.length - media.length} left out`);
        if (text.trim() === "" && media.length === 0) return; // nothing to answer: no turn, no empty user entry
        const head = o.engines[0]?.ref ?? "";
        const named = asked === undefined ? undefined : engineOf(asked);
        if (asked !== undefined && !named) yield* info(`${asked} is not an engine of the master's chain: the message is for ${engineLabel(head)}`);
        const sentFor = on && o.devices.includes(on) ? on : deviceOf(text, o.devices);
        const steer = (how ?? followUp) === "steer";
        inbox.push({ clientId: clientId ?? null, described: null, device: sentFor, engine: named?.ref ?? head, media, seq: ++seq, state: "held", steer, text });
        if (accepting) steerIn(accepting);
        yield* start; // nothing to do while the loop is on: it takes held messages as it goes
        yield* tell;
      });

    // Only a held message can be taken back (src/inbox.ts takeBack), by any client. Out of the
    // inbox and told in one step, so no turn picks it in between.
    const takeBack = (clientId: string) =>
      Effect.suspend(() => {
        const out = takenFrom(inbox, clientId);
        if ("error" in out) return publish({ clientId, error: out.error, message: null, type: "taken-back" });
        const { media, text } = out.taken;
        return publish({ clientId, error: null, message: { media, text }, type: "taken-back" }).pipe(Effect.andThen(tell));
      }).pipe(Effect.uninterruptible);

    // Each change is saved, so a restart keeps it.
    const configure = (change: Choices) =>
      Effect.gen(function* () {
        if (change.followUp) followUp = change.followUp;
        if (o.saveChoices) yield* o.saveChoices({ followUp });
        yield* tell;
      });

    // the turn waiting in "needs-model" goes on, on `ref` (`stall`). A resume that finds none
    // waiting, or the stop settled already (two clients at once), is told so: its picker has moved.
    const resume = (ref: string) =>
      Effect.suspend(() => {
        if (!engineOf(ref)) return info(`${ref} is not an engine of the master's chain (${o.engines.map((e) => e.ref).join(", ")})`);
        const late = info(`not resumed on ${engineLabel(ref)}: no turn waits for a model (another client may have resumed it)`);
        if (stalled === null) return late;
        return Deferred.succeed(stalled.resume, ref).pipe(Effect.flatMap((first) => (first ? Effect.void : late)));
      });

    const cancel = Effect.suspend(() => (loop ? Fiber.interrupt(loop) : Effect.void));
    const primeSoon = Effect.asVoid(primeNow);

    return { cancel, configure, events, input, live, primeSoon, resume, state, takeBack };
  });

// A message's text as the log keeps it: what was typed, then a marker line per attachment with
// its caption (SPEC "Media")
const logText = (m: Incoming, said: readonly string[]) =>
  withMarkers(
    m.text,
    m.media.map((a, k) => markerOf(a, said[k] ?? NOT_DESCRIBED)),
  );

// a defect in one line: what was thrown
const thrown = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

// what stops a turn until a client resumes it on an engine, rather than ending it (E4)
const waitsForResume = (e: EngineError | StoreError) => e._tag === "UsageLimit" || e._tag === "DeviceOffline";

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

