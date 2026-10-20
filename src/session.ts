// The session (ref §5.2, E1): the one turn loop the server owns. Messages wait in one inbox and
// start a turn; a message sent while a turn runs is offered to its call (steer) or held for the
// next turn (queue), and a held one can be taken back. Each message names the engine of the
// master's chain it is for, and a turn runs on its messages' engine: a usage limit or an offline
// device stops it until a client resumes it on an engine (E4). Every client sees the same events.
// Priming runs only while idle, and a turn never waits for it (E17, SPEC "Turn and priming").
import { Cause, Clock, Deferred, type Duration, Effect, Exit, Fiber, FiberSet, Option, PubSub, Queue, type Scope } from "effect";
import { makeDrafts } from "./artifacts/draft.ts";
import { loggedText } from "./artifacts/tools.ts";
import type { Choices } from "./choices.ts";
import { ACTS, PRIME_IDLE, WAIT_RETRY } from "./config.ts";
import type { Chat, LogExtra } from "./chat.ts";
import type { DownList } from "./engines/chain.ts";
import type { EngineError } from "./engines/errors.ts";
import type { StoreError } from "./store.ts";
import type { Entry } from "./tree.ts";
import { giveBack as returned, handOver, held, type Incoming, nextTurn, offered, steerIn as joining, takeBack as takenFrom, type Where } from "./inbox.ts";
import { makeMaster, type Master } from "./master.ts";
import { makeSeen, type Receipt, receiptOf } from "./once.ts";
import type { LiveRun, SessionEvent } from "./session-events.ts";
import { type Look, pictureBudget } from "./media/budget.ts";
import type { Part } from "./media/part.ts";
import { makePieces, noReasoning, type Pieces, type Reasoning } from "./reasoning.ts";
import { BLIND, type Mid, type TurnEngine, type TurnEvents } from "./turn/engine.ts";
import type { UsageRecord } from "./usage.ts";
import { allBuilt, render, settle, unbuilt, viewSize } from "./view.ts";
import { type Asset, canonicalRef, engineLabel, type FollowUp, MAX_ATTACHMENTS, markerOf, NOT_DESCRIBED, type Phase, type SessionState, type SubagentInfo, withMarkers } from "./wire.ts";

// the state every client is shown (STATE_SNAPSHOT, STATE_DELTA, /api/state): src/wire.ts
export type { FollowUp, Phase, SessionState } from "./wire.ts";

// what the session tells every client, and what a client joining mid-run is shown
export type { LiveRun, SessionEvent } from "./session-events.ts";

export type Session = {
  // a message from a client: it starts a turn, or joins the running one (InputOptions say how).
  // One whose `clientId` the session has seen is answered and not taken again (E41, src/once.ts)
  readonly input: (text: string, o?: InputOptions) => Effect.Effect<Receipt>;
  // a client wants a held message back: a "taken-back" event says whether it got it
  readonly takeBack: (clientId: string) => Effect.Effect<void>;
  // the session's settings, shared by every client: what a mid-run message does
  readonly configure: (change: Choices) => Effect.Effect<void>;
  // a turn waiting in "needs-model" goes on, on this engine of the master's chain (the one that
  // stopped it again is a retry); at any other time it is answered with an info. With `loop`, only
  // in that run of the turn loop (the state's `loop`, E41): one a client sent again after a
  // reconnect never settles a later stop
  readonly resume: (engine: string, loop?: number) => Effect.Effect<void>;
  // A client's Stop: the wait or the turn stops, and nothing sent is lost. It names the run of the
  // turn loop it saw (the state's `loop`, E41), or none (the REPL, a client from before it): then
  // whatever runs. One that finds that run over stops nothing, and says why: a Stop sent again after
  // a reconnect or a restart never cancels a later turn.
  readonly stop: (loop?: number) => Effect.Effect<string | null>;
  // whether `loop` is the newest run of the turn loop, running or ended (none named: yes), so an
  // action the user took on the state they saw is not applied to a later one (Stop all)
  readonly newestLoop: (loop?: number) => boolean;
  readonly events: PubSub.PubSub<SessionEvent>;
  readonly state: () => SessionState;
  // a client connected: a message usually follows, so prime the view (SPEC "Turn and priming")
  readonly primeSoon: Effect.Effect<void>;
  // the run going on, and the reply it is streaming (not logged yet), for a client joining now
  readonly live: () => LiveRun | null;
  // A subagent's report (SPEC "Subagents"): logged as a user entry, never while a turn runs. With
  // `wake` (E39), one that reaches an idle master starts a turn, with the others that come within
  // the debounce, as the turn's own messages; one that comes while a turn runs goes into the next
  // turn's view, or wakes the master once the loop winds down with no turn due. Without it (M7a),
  // it starts no turn: logged at once when the session is idle, else before the next turn renders
  // its view, or once the loop winds down. A report never wakes the master on messages parked
  // after an error: then it is logged as M7a logs it. Resolves when it is in the log.
  // `wake: false` (a run the user stopped): never wakes the master, logged as without `wake`.
  readonly report: (text: string, o?: { readonly wake?: boolean }) => Effect.Effect<void>;
  // Stop all (server/routes/ws.ts): reports wake the master no more until the next user message
  readonly hush: Effect.Effect<void>;
  // the turn running now: its engine, the view it was sent (what a subagent it spawns starts
  // from) and its device; null between turns
  readonly turnNow: () => { readonly ref: string; readonly view: string; readonly on: string } | null;
  // the view the most recent turn was sent, whatever runs now; null before any turn
  readonly lastView: () => string | null;
};

// What the session shows of the subagents (src/subagents.ts): the list in the state, and a ping
// each time it changes
export type SubagentList = { readonly list: () => readonly SubagentInfo[]; readonly changes: PubSub.PubSub<true> };

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
  // what is to be said of attachments it named that the store doesn't hold: said once it is taken
  readonly leftOut?: readonly string[];
};

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
  readonly waitRetry?: Duration.Input; // WAIT_RETRY
  readonly compactorDown?: DownList; // makeSummarize's `down`: shown in the state, published again as it changes
  readonly events?: PubSub.PubSub<SessionEvent>; // the server's, made first so it can report into it; else the session's own
  readonly reasoning?: Reasoning; // the side file thinking is kept in (src/reasoning.ts); none: only streamed
  readonly subagents?: SubagentList; // shown in the state (SPEC M7a); none: the state has no list
  // a report that reaches an idle master wakes it after this debounce (E39, WAKE_DEBOUNCE); none: M7a's waiting
  readonly wake?: Duration.Input | null;
  // woken turns in a row, with no user message between them, before reports stop waking it (WAKE_LIMIT; 0: no limit)
  readonly wakeLimit?: number;
  // an artifact's latest HTML, for an edit's live draft (SPEC "Artifacts"); none: edits show none
  readonly artifactBase?: (name: string) => Effect.Effect<string | null>;
}): Effect.Effect<Session, never, Scope.Scope> =>
  Effect.gen(function* () {
    const { chat } = o;
    const events = o.events ?? (yield* PubSub.unbounded<SessionEvent>());
    const publish = (e: SessionEvent) => PubSub.publish(events, e).pipe(Effect.asVoid);
    const info = (message: string) => publish({ message, type: "info" });

    // every message not logged yet, in the order they came in (src/inbox.ts has its rules)
    const inbox: Incoming[] = [];
    // the client ids of messages taken back, never logged, the newest ACTS: one sent again after a
    // reconnect is answered, not taken again (E41; the inbox and the log know the rest, src/once.ts)
    const taken = makeSeen(ACTS);
    // subagents' reports not logged yet, oldest first, each with what its sender waits on (SPEC M7a)
    const reports: { readonly text: string; readonly logged: Deferred.Deferred<true>; readonly wake: boolean }[] = [];
    // the view the most recent turn was sent (`turnNow`, `lastView`), and the device it ran on
    let sentView: string | null = null;
    let lastOn: string | null = null;
    let seq = 0;
    let phase: Phase = "idle", device = o.defaultDevice, engine: string | null = null;
    // the setting every client shares (`configure`): what a mid-run message does
    let followUp: FollowUp = o.choices?.followUp ?? "steer";
    const master = o.master ?? (yield* makeMaster(o.engines.map((e) => ({ label: engineLabel(e.ref), ref: e.ref }))));
    // an engine of the chain by its ref, read as the config reads one: "@high" in a master at high
    // is the bare ref, so a pick kept from before that effort changed still finds its engine
    const engineOf = (ref: string) => {
      const canonical = canonicalRef(ref, master.effort);
      return o.engines.find((e) => e.ref === canonical);
    };
    // the engine whose spawns are kept warm and primed: the most recent turn's (E18)
    const latest = () => engineOf(master.latest());
    // where the call that accepts mid-run messages runs, and the queue it reads them from
    let accepting: Where | null = null;
    let offerTo: Queue.Queue<Incoming> | null = null;
    // a turn a usage limit or an offline device stopped: its engine and why, and what a resume settles
    let stalled: { readonly ref: string; readonly why: string; readonly resume: Deferred.Deferred<string> } | null = null;
    let running = false; // the turn loop is on: set before its fiber starts, cleared as it ends
    // the run of the turn loop, which a Stop names (E41): counted from this boot's clock, so a Stop
    // a client sends again after a restart never names a run of the new server's
    let loops = Date.now();
    let loop: Fiber.Fiber<void> | null = null; // that fiber, for a cancel
    // the loop stopped on an error (the log refused, or a defect), why, and the last message in by
    // then: those wait for a newer message instead of starting the loop again at once
    let halted: { readonly why: string; readonly upTo: number } | null = null;
    // once that loop has ended, the last message in by then: the ones up to it start no turn until a
    // newer one comes, also when a subagent's report starts the loop to be logged (null: none waits)
    let parked: number | null = null;
    // reports that may wake the master (E39): woken turns in a row since the user's last message,
    // their limit (0: none), and whether Stop all hushed them until that message
    const wakeLimit = o.wakeLimit ?? 0;
    let woken = 0;
    let hushed = false;
    const fused = () => wakeLimit > 0 && woken >= wakeLimit;
    // a turn is due: a held message, and not only ones parked after an error
    const turnsDue = () => held(inbox).length > 0 && (parked === null || inbox.some((m) => m.seq > (parked ?? 0)));


    // when the phase clients see began, on this server's clock: stamped as a state with a new phase
    // is first told. Clients get how long it has run (`elapsed`), never this time itself, so a
    // phone whose clock is off still counts right.
    const clock = yield* Clock.Clock;
    let since: number | null = null, sincePhase: Phase | null = null;
    const state = (): SessionState => {
      const told: SessionState = {
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
        effort: master.effort,
        stopped: stalled && { label: master.label(stalled.ref), ref: stalled.ref, why: stalled.why },
        compactions: chat.activity(),
        loop: loops,
      };
      const withAgents = o.subagents ? { ...told, subagents: o.subagents.list() } : told;
      const withWake = fused() ? { ...withAgents, wakePaused: woken } : withAgents;
      return since === null ? withWake : { ...withWake, elapsed: Math.max(0, clock.currentTimeMillisUnsafe() - since) };
    };
    const stamp = Effect.sync(() => {
      if (phase === sincePhase) return;
      sincePhase = phase;
      since = clock.currentTimeMillisUnsafe();
    });
    const tell = Effect.andThen(stamp, Effect.suspend(() => publish({ state: state(), type: "state" })));
    const enter = (p: Phase) => Effect.suspend(() => ((phase = p), tell));
    // an engine's down mark lapsed: clients see it in the state
    const lapses = yield* PubSub.subscribe(master.changes);
    yield* PubSub.take(lapses).pipe(Effect.andThen(tell), Effect.forever, Effect.forkScoped);
    // the compactor's work changed (a call started or ended): clients see it in the state, at most
    // four times a second (the pump's changes slide, so a burst of calls is one tell)
    const compacting = yield* PubSub.subscribe(chat.changes);
    yield* PubSub.take(compacting).pipe(Effect.andThen(Effect.sleep("250 millis")), Effect.andThen(tell), Effect.forever, Effect.forkScoped);
    // a compactor engine went down or came back: clients see it in the state (subscribed here, so
    // no change is missed between now and the fiber's start)
    if (o.compactorDown) {
      const downs = yield* PubSub.subscribe(o.compactorDown.changes);
      yield* PubSub.take(downs).pipe(Effect.andThen(tell), Effect.forever, Effect.forkScoped);
    }
    // a subagent started, logged a line or ended: clients see it in the state, at most ten times a
    // second (its changes slide, so a burst of lines is one tell)
    if (o.subagents) {
      const agents = yield* PubSub.subscribe(o.subagents.changes);
      yield* PubSub.take(agents).pipe(Effect.andThen(Effect.sleep("100 millis")), Effect.andThen(tell), Effect.forever, Effect.forkScoped);
    }

    // the run whose RUN_STARTED went out, the text it is streaming at log index `at`, and its
    // thinking (src/reasoning.ts makePieces: a run's own, so its budget starts with it)
    // and the artifacts' drafts it is streaming (src/artifacts/draft.ts)
    let current: { runId: string; reply: { at: number; text: string } | null; pieces: Pieces; drafts: ReturnType<typeof makeDrafts> } | null = null;
    const live = (): LiveRun | null =>
      current && { drafts: current.drafts.now(), reasoning: current.pieces.live(), reply: current.reply && { ...current.reply }, runId: current.runId };
    const sideFile = o.reasoning ?? noReasoning;

    const ack = (m: Incoming, at: number | null, error: string | null) =>
      m.clientId === null ? Effect.void : publish({ at, clientId: m.clientId, error, type: "ack" });

    // A write and its bookkeeping are one step a cancel cannot split: an entry in the log is
    // always known to the session, never half-told.
    const log = (kind: Entry["kind"], text: string, extra: LogExtra) =>
      chat.log(kind, text, extra).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (current) current.reply = null; // the streamed text is logged now, or was left behind
          }),
        ),
        Effect.uninterruptible,
      );
    const published = (runId: string | null) => (entry: Entry) => publish({ entry, runId, type: "logged" });

    // The subagents' reports waiting, logged in order, outside any run (SPEC M7a): each is a user
    // entry starting "[Name] " (E23). Each write and its leaving the queue are one step; one the log
    // refuses stays first in the queue, and the loop stops on the refusal like any other.
    const logReports = Effect.gen(function* () {
      for (let next = reports[0]; next !== undefined; next = reports[0]) {
        const { logged, text } = next;
        yield* log("user", text, {}).pipe(
          Effect.tap((entry) =>
            Effect.suspend(() => {
              reports.shift();
              return published(null)(entry).pipe(Effect.andThen(Deferred.succeed(logged, true)));
            }),
          ),
          Effect.uninterruptible,
        );
      }
    });

    const scope = yield* Effect.scope;

    // Waking the master (E39). A report that reaches an idle master waits WAKE_DEBOUNCE for others,
    // then they become one turn's messages: held in the inbox for the most recent turn's engine
    // and device, steering nothing, never taken back (no client sent them). Only while nothing is
    // parked after an error, and no loop runs: one that runs logs them before the next turn's view,
    // or wakes the master as it winds down.
    // A report of a run the user stopped never wakes it, nor does any after Stop all (`hushed`) until
    // the user's next message, nor any once it was woken `wakeLimit` turns in a row with no user
    // message between them (the fuse: a master that spawns at every woken turn would run all night).
    const wakes = o.wake === undefined || o.wake === null ? null : yield* Queue.sliding<true>(1);
    const mayWake = () => wakes !== null && halted === null && parked === null && !hushed && !fused();
    const wakeable = () => mayWake() && !running;
    const wanted = () => reports.some((r) => r.wake);
    // the reports that wake it become a turn's messages; the others wait in `reports` and are logged
    // before that turn's view
    const wakeWith = Effect.gen(function* () {
      const waking = reports.filter((r) => r.wake);
      for (const r of waking) reports.splice(reports.indexOf(r), 1);
      for (const { logged, text } of waking)
        inbox.push({ clientId: null, described: null, device: lastOn, engine: master.latest() || (o.engines[0]?.ref ?? ""), logged, media: [], seq: ++seq, state: "held", steer: false, text });
      woken += 1;
      if (fused()) yield* info(`reports woke OptChat ${woken} turns in a row: waking is paused until your next message, and reports wait for it`);
      yield* start;
    });
    // the loop logs reports before a turn's view; with no turn due, only those that won't wake the master
    const logReportsDue = Effect.suspend(() => (turnsDue() || !mayWake() || !wanted() ? logReports : Effect.void));

    // A message's attachments' captions, each waited for at most media.captionWait, asked for once:
    // what the log keeps of the message and what an engine is sent of it come from this one answer,
    // so they agree, and a marker is never written without having waited for its caption.
    const captionsOf = (m: Incoming): Effect.Effect<readonly string[]> =>
      Effect.suspend(() => {
        if (m.described) return Deferred.await(m.described);
        const done = Deferred.makeUnsafe<readonly string[]>();
        m.described = done;
        // Uninterruptible, so `done` is settled whoever stops: a fiber interrupted before it starts
        // (the scope closing, as the server stops) would never run, and every await of it hang. A
        // caption waits at most media.captionWait.
        return Effect.forEach(m.media, (a) => o.media.caption(a), { concurrency: "unbounded" }).pipe(
          Effect.flatMap((said) => Deferred.succeed(done, said)),
          Effect.forkIn(scope, { uninterruptible: true }),
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
            return log("user", logText(m, said), extraOf({ client: m.clientId, on: on ?? m.device })).pipe(
              Effect.tap((entry) =>
                Effect.suspend(() => {
                  inbox.splice(inbox.indexOf(m), 1);
                  return ack(m, entry.i, null).pipe(
                    Effect.andThen(published(runId)(entry)),
                    Effect.andThen(m.logged ? Deferred.succeed(m.logged, true) : Effect.void),
                  );
                }),
              ),
              Effect.uninterruptible,
            );
          }),
        ),
      );
    // these messages, in order, logged unanswered (docs/optchat.md §6: nothing is lost)
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

    // Thinking as it streams (SPEC "Reasoning"): the run's pieces (src/reasoning.ts) say what of it
    // goes out, under the caps; once the reply or tool call it came before is logged, its piece is
    // kept in the side file under that index, then clients are told. A write that fails is the side
    // file's to report; the turn goes on. A piece the run logged nothing after is dropped.
    const think = (delta: string, fresh: boolean, runId: string) =>
      Effect.suspend(() => {
        const out = current?.pieces.add({ at: chat.mem.root.length, delta, engine: engine ?? "", fresh, now: clock.currentTimeMillisUnsafe() });
        return out ? publish({ at: out.at, delta: out.taken, offset: out.offset, runId, type: "reasoning" }) : Effect.void;
      });
    const keepThought = (entry: Entry, runId: string) =>
      Effect.suspend(() => {
        const taken = entry.kind === "talk" || entry.kind === "tool" ? current?.pieces.take(entry.i, clock.currentTimeMillisUnsafe()) : null;
        if (!taken) return Effect.void;
        const { at, record } = taken;
        return sideFile.keep(record).pipe(Effect.andThen(publish({ at, cut: record.cut ?? 0, i: record.i, ms: record.ms, runId, type: "reasoning-kept" })));
      });
    const dropThought = (runId: string) =>
      Effect.suspend(() => {
        const at = current?.pieces.drop() ?? null;
        return at === null ? Effect.void : publish({ at, runId, type: "reasoning-dropped" });
      });

    // the one start of a run: `current` and RUN_STARTED together, so no end goes out without its start
    const beginRun = (runId: string) =>
      Effect.suspend(() => {
        const drafts = makeDrafts({
          base: (name) => o.artifactBase?.(name) ?? Effect.succeed(null),
          runId,
          scope,
          send: (draft) => publish({ draft, type: "artifact-draft" }),
        });
        current = { drafts, pieces: makePieces(), reply: null, runId };
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
        const { drafts, runId } = current;
        return dropThought(runId).pipe(
          Effect.andThen(drafts.stop),
          Effect.andThen(
            Effect.suspend(() => {
              current = null;
              return publish({ error, logged: chat.mem.root.length, runId, type: "run-finished" });
            }),
          ),
        );
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
        yield* dropThought(runId);
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
        const goesOn = next === ref ? "tried again" : `${master.label(next)} carries on`;
        yield* info(`${master.label(ref)} stopped (${why}); ${goesOn}${done > 0 ? ` from the ${done} logged entries` : ""}`);
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
      // A failed call is tried again at the next message (docs/optchat.md §4); while the turn
      // waits for one, none comes, so it is also tried every WAIT_RETRY, only while it waits (E24)
      const retrying = chat.retry.pipe(Effect.delay(o.waitRetry ?? WAIT_RETRY), Effect.forever);
      const summaries = Effect.suspend(() => (unbuilt(chat.mem) ? enter("waiting").pipe(Effect.andThen(Effect.raceFirst(settle(chat.mem), retrying))) : Effect.void));
      // reports that came in are logged first, so the next turn's view has them
      for (yield* logReportsDue; turnsDue(); yield* logReportsDue) {
        if (unbuilt(chat.mem)) device = nextTurn(inbox, o.defaultDevice).on; // shown while it waits; read again after, with what came in meanwhile
        yield* summaries;
        // This turn's device, engine and messages are read once the summaries are in, and picked at
        // once, so none can be taken back any more; their captions are waited for together,
        // briefly, before any is logged. One that comes in meanwhile waits for the call below, where
        // it is offered if it steers (`steerIn`). All taken back while waiting: no turn.
        const { batch, engine: ref0, on } = nextTurn(inbox, o.defaultDevice);
        if (batch.length === 0) continue;
        device = on;
        lastOn = on;
        for (const m of batch) m.state = "picked";
        yield* captioned(batch);
        // a report that came in meanwhile goes before the view too, once summarized like any message
        if (reports.length > 0) yield* logReports.pipe(Effect.andThen(summaries));
        const view = render(chat.mem); // BEFORE the new messages are logged (docs/optchat.md §6)
        sentView = view;
        yield* enter("running");
        let runId = yield* logQueued(batch, on); // a resumed run gets one of its own (`stall`)
        const since = chat.mem.root.length; // what this turn's engines log starts here
        const taken: Incoming[] = []; // the mid-run messages its calls took, in the order they were logged
        accepting = { engine: ref0, on };
        steerIn(accepting); // came in while the captions or the log were awaited
        const out: TurnEvents = {
          info,
          // a reply or tool call is logged with the thinking before it kept beside it, in one step;
          // an artifact's HTML never goes in (E31): its call and a read's answer are logged as stubs
          log: (kind, text, flags) =>
            log(kind, loggedText(kind, text, flags?.tool), extraOf({ failed: kind === "echo" && flags?.error === true, on })).pipe(
              Effect.tap(published(runId)),
              Effect.flatMap((entry) => keepThought(entry, runId)),
              Effect.uninterruptible,
            ),
          text: (delta) => stream(delta, runId),
          thinking: (tokens) => publish({ runId, tokens, type: "thinking" }),
          reasoning: (delta, fresh) => think(delta, fresh, runId),
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
          // an artifact call's input as it streams: its live draft (SPEC "Artifacts")
          toolInput: {
            delta: (call, piece) => Effect.suspend(() => current?.drafts.delta(call, piece) ?? Effect.void),
            end: (id) => Effect.suspend(() => current?.drafts.end(id) ?? Effect.void),
          },
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
        if (stop !== null) parked = stop.upTo;
        // Again only for a turn that is due (`turnsDue`: a held message newer than any parked one),
        // or for a report that came in meanwhile, unless the log just refused. Messages parked after
        // an error are no reason: the loop would find nothing to do, end and start again, for ever.
        if (turnsDue()) return start;
        if (stop === null && reports.length > 0) return wakeable() && wanted() ? wakeWith : start;
        phase = "idle";
        const told = stop === null ? Effect.void : Effect.forEach(inbox, (m) => ack(m, null, stop.why), { discard: true });
        return told.pipe(Effect.andThen(tell), Effect.andThen(primeLater), Effect.andThen(warm));
      });
    });

    // The loop ended early: a cancel (an interrupt only), a store error or a defect. Nothing sent
    // is lost (docs/optchat.md §6). What the call never took goes back to the inbox; after a cancel or a
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
      loops += 1;
      // until the loop says what it waits for: never "idle" while it is on, unless all it has to do
      // is log reports, which is no turn
      if (turnsDue()) phase = "running";
      // The fiber starts uninterruptible and the turn alone is interruptible: a Stop that comes
      // before the fiber has run (an unstarted fiber interrupted never runs, so neither would
      // `stopped` nor `afterLoop`) is taken where the turn begins, and the loop still ends.
      return turn.pipe(
        Effect.interruptible,
        Effect.onExit((exit) => (Exit.isFailure(exit) ? stopped(exit.cause) : Effect.void)),
        Effect.ensuring(afterLoop),
        Effect.ignoreCause,
        Effect.forkIn(scope, { uninterruptible: true }),
        Effect.tap((fiber) => Effect.sync(() => (loop = fiber))),
        Effect.asVoid,
      );
    });

    // A message is held; while a call accepts mid-run messages it joins that call if it steers
    // (`steerIn`), else it waits for the next turn, which the loop starts when the call ends.
    // A message for no engine, or for one the chain doesn't have (said), is for the chain's first.
    // One whose client id the session has seen is answered with what became of it, and nothing
    // more: looked up and taken in one step, so two copies sent at once are one message (E41).
    const input = (text: string, { clientId, device: on, engine: asked, followUp: how, leftOut = [], media: attached = [] }: InputOptions = {}) =>
      Effect.gen(function* () {
        const seen = clientId === undefined ? null : receiptOf(clientId, { inbox, logged: chat.mem.clients, taken });
        if (seen !== null) return seen;
        const media = attached.slice(0, MAX_ATTACHMENTS);
        const fresh: Receipt = { type: "new" };
        if (text.trim() === "" && media.length === 0) return fresh; // nothing to answer: no turn, no empty user entry
        const head = o.engines[0]?.ref ?? "";
        const named = asked === undefined ? undefined : engineOf(asked);
        const sentFor = on && o.devices.includes(on) ? on : deviceOf(text, o.devices);
        const steer = (how ?? followUp) === "steer";
        inbox.push({ clientId: clientId ?? null, described: null, device: sentFor, engine: named?.ref ?? head, media, seq: ++seq, state: "held", steer, text });
        for (const said of leftOut) yield* info(said);
        if (attached.length > media.length) yield* info(`at most ${MAX_ATTACHMENTS} attachments per message: ${attached.length - media.length} left out`);
        if (asked !== undefined && !named) yield* info(`${asked} is not an engine of the master's chain: the message is for ${master.label(head)}`);
        parked = null; // a newer message: the ones parked after an error go with it
        // the user is here: reports may wake it again, from a count of none
        woken = 0;
        hushed = false;
        yield* chat.retry; // the next message: failed summaries are tried again (docs/optchat.md §4)
        if (accepting) steerIn(accepting);
        yield* start; // nothing to do while the loop is on: it takes held messages as it goes
        yield* tell;
        return fresh;
      });

    // Only a held message can be taken back (src/inbox.ts takeBack), by any client. Out of the
    // inbox and told in one step, so no turn picks it in between.
    const takeBack = (clientId: string) =>
      Effect.suspend(() => {
        const out = takenFrom(inbox, clientId);
        if ("error" in out) return publish({ clientId, error: out.error, message: null, type: "taken-back" });
        taken.add(clientId);
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
    const resume = (ref: string, loop?: number) =>
      Effect.suspend(() => {
        const e = engineOf(ref);
        if (!e) return info(`${ref} is not an engine of the master's chain (${o.engines.map((x) => x.ref).join(", ")})`);
        const late = info(`not resumed on ${master.label(e.ref)}: no turn waits for a model (another client may have resumed it)`);
        if (stalled === null || !newestLoop(loop)) return late;
        return Deferred.succeed(stalled.resume, e.ref).pipe(Effect.flatMap((first) => (first ? Effect.void : late)));
      });

    const cancel = Effect.suspend(() => (loop ? Fiber.interrupt(loop) : Effect.void));
    const newestLoop = (which?: number) => which === undefined || which === loops;
    const stop = (which?: number) =>
      Effect.suspend(() => (which === undefined || (running && which === loops) ? cancel.pipe(Effect.as(null)) : Effect.succeed("not stopped: the turn it was for has ended")));
    const primeSoon = Effect.asVoid(primeNow);

    // A report waits for the loop: it is logged before the next turn, or by a loop started for it
    // alone, which runs no turn and leaves the phase as it was. It never offers itself to a call.
    const report = (text: string, ro: { readonly wake?: boolean } = {}) =>
      Effect.suspend(() => {
        const logged = Deferred.makeUnsafe<true>();
        const wake = ro.wake !== false;
        reports.push({ logged, text, wake });
        // one that won't wake it while others wait for the debounce waits with them
        const go = wakes !== null && wakeable() && wanted() ? Queue.offer(wakes, true) : start;
        return go.pipe(Effect.andThen(Deferred.await(logged)), Effect.asVoid);
      });
    const hush = Effect.sync(() => {
      hushed = true;
    });
    // the debounce: quiet for o.wake since the last report, then the reports wake the master, unless
    // a loop took them meanwhile (a message came) or something got parked
    if (wakes !== null) {
      const quiet = o.wake ?? 0;
      yield* Effect.gen(function* () {
        yield* Queue.take(wakes);
        while (Option.isSome(yield* Queue.take(wakes).pipe(Effect.timeoutOption(quiet)))) {
          // another report within the debounce: wait for quiet from here
        }
        yield* Effect.suspend(() => (reports.length === 0 || running ? Effect.void : wakeable() && wanted() ? wakeWith : start));
      }).pipe(Effect.forever, Effect.forkIn(scope));
    }
    const turnNow = () => (engine === null || sentView === null ? null : { on: device, ref: engine, view: sentView });
    const lastView = () => sentView;

    return { configure, events, hush, input, lastView, live, newestLoop, primeSoon, report, resume, state, stop, takeBack, turnNow };
  });

// What a log line carries after the reference's keys (src/chat.ts): where its turn ran, on an echo
// whose tool failed `error` (E28), and on a client's message the id it was sent with (E41); each
// only when set, so every other line is the one it always was
const extraOf = (o: { readonly on: string | null; readonly failed?: boolean; readonly client?: string | null }) => {
  const extra: LogExtra = {};
  if (o.on) extra.device = o.on;
  if (o.failed === true) extra.error = true;
  if (o.client) extra.client = o.client;
  return extra;
};

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

export const failureText = (e: EngineError | StoreError) => {
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

