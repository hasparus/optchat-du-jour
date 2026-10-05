// The session (ref §5.2, E1): the one turn loop the server owns. Messages wait in one inbox and
// start a turn; a message sent while a turn runs is offered to its call (steer) or held for the
// next turn (queue), and a held one can be taken back. Turns run on one engine, the user's pick:
// a usage limit or an offline device stops a turn until a client picks one (E4). Every client
// sees the same events. Priming runs only while idle, and a turn never waits for it (E17, SPEC "Turn and
// priming").
import { Cause, Deferred, type Duration, Effect, Exit, Fiber, FiberSet, Option, PubSub, Queue, type Scope } from "effect";
import type { Choices } from "./choices.ts";
import { MASTER_DOWN_FOR, PRIME_IDLE } from "./config.ts";
import type { Chat } from "./chat.ts";
import type { DownList } from "./engines/chain.ts";
import type { EngineError } from "./engines/errors.ts";
import type { StoreError } from "./store.ts";
import type { Entry } from "./tree.ts";
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
  // a message from a client: it starts a turn, or joins the running one. With a `clientId` the
  // client is told (an "ack") which log entry the message became, or that it could not be logged.
  // `media`: its attachments, already in the asset store (SPEC "Media"); `followUp`: what it does
  // if a turn runs, when not the session's setting
  readonly input: (text: string, device?: string, clientId?: string, media?: readonly Asset[], followUp?: FollowUp) => Effect.Effect<void>;
  // a client wants a held message back: a "taken-back" event says whether it got it
  readonly takeBack: (clientId: string) => Effect.Effect<void>;
  // the session's settings, shared by every client: what a mid-run message does, and which engine
  // of the master's chain turns run on (a ref of that chain). A pick while a turn waits for one
  // (phase "needs-model") lets it go on, on the picked engine.
  readonly configure: (change: Choices) => Effect.Effect<void>;
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

// A message from a client, the session's until it is logged: "held" for a turn, "picked" by the
// turn that is logging it now, or "offered" to the running call, which may take it (it is logged
// then) or leave it (it comes back "held" when the call ends). Only a held one can be taken back.
// Each carries the id its client sent it with, so its ack names it. (The state clients see lists
// all of them as `pending`.)
type Incoming = {
  readonly seq: number; // the order messages came in
  readonly text: string; // as typed; the log gets it with a marker line per attachment
  readonly media: readonly Asset[];
  device: string | null; // the device it was sent for; one a call left gets that call's device
  readonly clientId: string | null;
  state: "held" | "picked" | "offered";
  readonly steer: boolean; // sent mid-run, it joins the running call; else it waits for the next turn
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
  // the clients' choices it starts with (follow-ups "steer" and the chain's own lead unless set),
  // and where each change goes, so a restart keeps them (src/choices.ts)
  readonly choices?: Choices;
  readonly saveChoices?: (c: Choices) => Effect.Effect<void>;
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
    // the settings every client shares (`configure`): what a mid-run message does, and the engine
    // turns run on
    let followUp: FollowUp = o.choices?.followUp ?? "steer";
    const first = o.engines[0];
    // the engine turns run on: the one a client picked, else the chain's first (none in a session
    // that is not tested on turns)
    let picked: TurnEngine | null = o.engines.slice(1).find((e) => e.ref === o.choices?.lead) ?? null;
    const master = () => picked ?? first;
    // engines of the chain that hit a usage limit (signed out, no key, a spent plan or budget):
    // why, until one answers again or MASTER_DOWN_FOR passes, so the picker shows it and a
    // spent plan that renewed meanwhile can be picked again
    const down = new Map<string, { readonly why: string; readonly mark: number }>();
    let marks = 0;
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
    const offered = () => inbox.filter((m) => m.state === "offered");

    const state = (): SessionState => ({
      budget: chat.mem.budget,
      device,
      down: o.compactorDown?.now() ?? [],
      engine,
      messages: chat.mem.root.length,
      phase,
      pending: inbox.map((m) => {
        const queued = m.state === "held";
        return m.media.length > 0 ? { clientId: m.clientId, media: m.media, queued, text: m.text } : { clientId: m.clientId, queued, text: m.text };
      }),
      viewBytes: viewSize(chat.mem),
      waiting: unbuilt(chat.mem),
      followUp,
      engines: o.engines.map((e) => ({ down: down.get(e.ref)?.why ?? null, label: engineLabel(e.ref), ref: e.ref })),
      lead: master()?.ref ?? "",
      stopped: stoppedOn && { ...stoppedOn, label: engineLabel(stoppedOn.ref) },
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
    // instead of waiting (E17): its own request writes the same prefix to the cache. Priming and
    // the warm process are the picked engine's, which the next turn runs on.
    const primes = yield* FiberSet.make();
    const primeNow = Effect.suspend(() => {
      const primer = master()?.prime;
      return !primer || running || !allBuilt(chat.mem) ? Effect.succeed(null) : FiberSet.run(primes, primer(render(chat.mem), o.defaultDevice));
    });
    // the next turn's and priming's claude, started ahead on the default device (E18)
    const warm = Effect.suspend(() => master()?.warm(o.defaultDevice).pipe(Effect.forkIn(scope), Effect.asVoid) ?? Effect.void);

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
    // held again, as is what a turn that stopped had picked. Every message still here, follow-ups
    // queued meanwhile too, goes on the call's device unless it was sent for one. Returns the
    // offered ones.
    const giveBack = (on: string) =>
      Effect.sync(() => {
        accepting = false;
        offerTo = null;
        const left = offered();
        for (const m of inbox) {
          m.state = "held";
          m.device ??= on;
        }
        return left;
      });

    // An engine of the chain hit a usage limit, or answered: the picker is told. A mark goes away by
    // itself after MASTER_DOWN_FOR, unless a newer one replaced it.
    const wentDown = (ref: string, why: string) =>
      Effect.suspend(() => {
        const mark = ++marks;
        down.set(ref, { mark, why });
        const lapse = Effect.sleep(MASTER_DOWN_FOR).pipe(
          Effect.andThen(Effect.suspend(() => (down.get(ref)?.mark === mark && down.delete(ref) ? tell : Effect.void))),
        );
        return Effect.forkIn(lapse, scope).pipe(Effect.andThen(tell));
      });
    const cameBack = (ref: string) => Effect.suspend(() => (down.delete(ref) ? tell : Effect.void));

    // the engine that stopped the turn and why, while it waits for a client to pick one
    let stoppedOn: { readonly ref: string; readonly why: string } | null = null;
    let picking: Deferred.Deferred<true> | null = null;

    // A turn stopped by a usage limit or an offline device waits for a pick. What it logged stays,
    // the text it streamed and never logged is dropped (the next engine's reply is not glued to
    // it), and its run ends with the reason, so every client sees it. The messages its call was
    // offered and never took stay offered, for the next call; messages sent meanwhile are held or
    // offered as usual. The data dir is committed, since a pick may take hours. A cancel while it
    // waits ends the loop like any cancel (`stopped`).
    const stall = (ref: string, why: string, runId: string, since: number) =>
      Effect.gen(function* () {
        engine = null;
        offerTo = null;
        if (current?.reply) yield* publish({ runId, type: "reply-dropped" });
        if (current) current.reply = null;
        const done = chat.mem.root.length - since;
        // waiting for a pick before the run's end goes out: a client that picks on seeing it is heard
        const pick = Deferred.makeUnsafe<true>();
        stoppedOn = { ref, why };
        picking = pick;
        yield* info(`${engineLabel(ref)} stopped: ${why}. Pick a model to go on, or stop${done > 0 ? ` (it logged ${done} entries; the next one carries on from them)` : ""}`);
        yield* endRun(why);
        yield* enter("needs-model");
        const failed = yield* o.commit;
        if (failed) yield* info(`git: ${failed}`);
        yield* Deferred.await(pick);
        yield* Effect.sync(() => {
          stoppedOn = null;
          picking = null;
          phase = "running";
        });
        yield* beginRun(runId);
        yield* info(`${engineLabel(master()?.ref ?? "")} carries on${done > 0 ? ` from the ${done} logged entries` : ""}`);
      });

    // Held messages that join the call running on `on`: every one up to the last that was sent to
    // steer, oldest first, so a message sent now never overtakes one queued before it and the log
    // keeps the order they were sent in. One sent for another device does not interrupt the call:
    // it waits for the next turn, which runs there (SPEC "Turn and priming").
    const steerIn = (on: string) => {
      const joins = (m: Incoming) => m.device === null || m.device === on;
      const waiting = held();
      const last = waiting.findLastIndex((m) => m.steer && joins(m));
      for (const m of waiting.slice(0, last + 1).filter(joins)) {
        m.state = "offered";
        if (offerTo) Queue.offerUnsafe(offerTo, m);
      }
    };

    // A call of one engine, with its own queue of mid-run messages: first those offered before it
    // (to a call a usage limit stopped), then each one as it comes. `took` logs one it took.
    // An engine that is not sent images gets the marker lines only, and a note saying so. What
    // pictures a call is sent, the opening message's and each mid-run message's, is decided in
    // one place: `forEngine`, against the call's picture budget.
    const call = (e: TurnEngine, batch: readonly Incoming[], base: { readonly device: string; readonly view: string }, from: string | null, out: TurnEvents, since: number) =>
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
        const earlier = yield* Effect.sync(() => {
          offerTo = q;
          for (const m of offered()) Queue.offerUnsafe(q, m);
          engine = e.ref;
          return chat.mem.root.slice(since).map(({ kind, text }) => ({ kind, text }));
        });
        yield* tell;
        const opening = yield* forEngine(batch);
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
        device = held().findLast((m) => m.device)?.device ?? o.defaultDevice;
        const on = device;
        if (unbuilt(chat.mem)) {
          yield* enter("waiting");
          yield* settle(chat.mem);
        }
        // This turn's messages are the ones held now, picked so none can be taken back any more;
        // their captions are waited for together, briefly, before any is logged. One that comes in
        // meanwhile is offered to the call below (unless it was queued), ahead of any sent later,
        // so the log keeps the order they were sent in. All taken back while waiting: no turn.
        const batch = held();
        if (batch.length === 0) continue;
        for (const m of batch) m.state = "picked";
        yield* captioned(batch);
        const view = render(chat.mem); // BEFORE the new messages are logged (gist §7)
        yield* enter("running");
        const runId = yield* logQueued(batch, on);
        const since = chat.mem.root.length; // what this turn's engines log starts here
        accepting = true;
        steerIn(on); // came in while the captions or the log were awaited
        const out: TurnEvents = {
          info,
          log: (kind, text) => logPublished(kind, text, runId, on),
          text: (delta) => stream(delta, runId),
          thinking: (tokens) => publish({ runId, tokens, type: "thinking" }),
          // the call passed this one to the model: logged now; a second report finds it gone (taken once)
          took: (taken) =>
            Effect.suspend(() => {
              const m = inbox.find((x) => x.seq === taken.seq && x.state === "offered");
              return m ? logMessage(m, runId, on).pipe(Effect.andThen(tell)) : Effect.void;
            }),
          usage: (record) => o.logUsage(record).pipe(Effect.andThen(publish({ record, type: "usage" }))),
        };
        yield* beginRun(runId);
        yield* tell;
        const base = { device: on, view };
        // The turn runs on the current engine only: the master never fails over by itself (E4),
        // since the user chooses which plan pays. A usage limit or an offline device stops it
        // until a client picks an engine (`stall`), then the picked one carries on (E16).
        // `ref`: the engine the attempt ran on (a pick made meanwhile counts from the next one)
        const attempt = (from: string | null) =>
          Effect.suspend(() => {
            const e = master();
            if (!e) return Effect.die(new Error("an empty engine chain"));
            return call(e, batch, base, from, out, since).pipe(
              Effect.tapError((error) => (error._tag === "UsageLimit" ? wentDown(e.ref, error.message) : Effect.void)),
              Effect.tap(() => cameBack(e.ref)),
              Effect.result,
              Effect.map((result) => ({ ref: e.ref, result })),
            );
          });
        let { ref, result } = yield* attempt(null);
        while (result._tag === "Failure" && waitsForPick(result.failure)) {
          yield* stall(ref, failureText(result.failure), runId, since);
          ({ ref, result } = yield* attempt(ref));
        }
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
        stoppedOn = null; // no longer waiting for a pick
        picking = null;
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

    // A message is held; while a call accepts mid-run messages it joins that call if it steers
    // (`steerIn`), else it waits for the next turn, which the loop starts when the call ends.
    const input = (text: string, on?: string, clientId?: string, attached: readonly Asset[] = [], how?: FollowUp) =>
      Effect.gen(function* () {
        const media = attached.slice(0, MAX_ATTACHMENTS);
        if (attached.length > media.length) yield* info(`at most ${MAX_ATTACHMENTS} attachments per message: ${attached.length - media.length} left out`);
        if (text.trim() === "" && media.length === 0) return; // nothing to answer: no turn, no empty user entry
        const sentFor = on && o.devices.includes(on) ? on : deviceOf(text, o.devices);
        const steer = (how ?? followUp) === "steer";
        inbox.push({ clientId: clientId ?? null, described: null, device: sentFor, media, seq: ++seq, state: "held", steer, text });
        if (accepting) steerIn(device);
        yield* start; // nothing to do while the loop is on: it takes held messages as it goes
        yield* tell;
      });

    // Only a held message can be taken back: one a turn picked or a call was offered is the
    // turn's. Out of the inbox and told in one step, so no turn picks it in between.
    const takeBack = (clientId: string) =>
      Effect.suspend(() => {
        const m = inbox.find((x) => x.clientId === clientId);
        if (m?.state !== "held") {
          const error = m ? "too late: the model has it" : "the server holds no such message";
          return publish({ clientId, error, message: null, type: "taken-back" });
        }
        inbox.splice(inbox.indexOf(m), 1);
        return publish({ clientId, error: null, message: { media: m.media, text: m.text }, type: "taken-back" }).pipe(Effect.andThen(tell));
      }).pipe(Effect.uninterruptible);

    // A pick counts from the next turn; while idle the picked engine is warmed and primed at once,
    // so that turn starts warm. Each change is saved, so a restart keeps it.
    const configure = (change: Choices) =>
      Effect.gen(function* () {
        if (change.lead !== undefined) {
          const chosen = o.engines.find((e) => e.ref === change.lead);
          if (!chosen) return yield* info(`${change.lead} is not an engine of the master's chain (${o.engines.map((e) => e.ref).join(", ")})`);
          picked = chosen === first ? null : chosen;
          if (!running) yield* warm.pipe(Effect.andThen(primeLater));
          // a turn waiting for a pick goes on, on this one (the same again is a retry)
          if (picking) yield* Deferred.succeed(picking, true);
        }
        if (change.followUp) followUp = change.followUp;
        if (o.saveChoices) yield* o.saveChoices(picked ? { followUp, lead: picked.ref } : { followUp });
        yield* tell;
      });

    const cancel = Effect.suspend(() => (loop ? Fiber.interrupt(loop) : Effect.void));
    const primeSoon = Effect.asVoid(primeNow);

    return { cancel, configure, events, input, live, primeSoon, state, takeBack };
  });

// a defect in one line: what was thrown
const thrown = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

// what stops a turn until a client picks an engine, rather than ending it (E4)
const waitsForPick = (e: EngineError | StoreError) => e._tag === "UsageLimit" || e._tag === "DeviceOffline";

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

