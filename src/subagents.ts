// Subagents (SPEC "Subagents"; docs/optchat.md §5–§6, the earlier gist's §9). The master starts one
// with spawn(name, task, model?, isolate?, device?, folder?): a run in the background, through the
// same engines and the same device runner as a turn, with the master's own tools and permissions
// (E36). It works directly in a folder by default, the master's own unless it names another, or
// in a git worktree of its own when isolated, which is merged back when it ends (E37, src/worktree.ts).
// It outlives the master's turn, cancelled or not. A subagent may spawn and tell subagents of its own,
// within the same cap; their reports come to it (E38). Its steps go to a side log of its own, never
// to the chat's log or tree; only its report does: a `user` entry starting "[Name] " (E23), which
// wakes an idle master (E39, src/session.ts `report`). tell(name, text) reaches a running one
// between its tool calls, and starts one that has ended again. zoom("Name") reads a side log. The
// user stops one (or all), tells it something or picks its model from its card (server/routes/ws.ts).
//
// On disk, beside the stream's chat/ (SPEC "Subagents"):
//   streams/<device>/agents/<Name>/log.jsonl   its side log: one line per entry, the main log's
//                                              records (records.ts Msg), append-only, fsynced
//   streams/<device>/agents/<Name>/agent.json  what it is: task, model, device, folder, worktree,
//                                              parent, state, times, its log's length and newest
//                                              line, the last merge, and the text of a report not
//                                              delivered yet (`pending`, with its run's number);
//                                              replaced whole
// Both are committed with the data dir. A run that a restart cut short is found "running" at the
// next start and goes on, from its side log, as after a tell (E40). A side log is held in memory
// only while its subagent runs or is listed; the others are read again when asked for.
//
// A report is made once, as its run ends, before anything else can happen to the subagent (a tell
// may start it again at once), and kept as `pending` until its reader has it, the chat or the
// subagent that spawned it: a restart sends the same text, unless its reader holds it already.
//
// Each call of a run is one engine call: the view (the turn's that spawned it, or that told it,
// cached as that turn's), then one opening text: who it is, where it works and who else works
// there, its task, and on a later call what its side log holds so far (its newest entries, within
// SIDE_CONTEXT) and the messages it was sent since. Messages sent while a call runs are offered to
// it; what it never took starts the next call.
import { Cause, Clock, Deferred, type Duration, Effect, Exit, Fiber, Option, PubSub, Queue, Result, Schema, type Scope } from "effect";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { loggedText } from "./artifacts/tools.ts";
import { type Effort, entryLabel, isEffort, type Ref, runEffort } from "./config.ts";
import type { EngineError } from "./engines/errors.ts";
import { type AgentTools, type Caller, SUBAGENT_NAME } from "./mcp.ts";
import { expandHome, within } from "./paths.ts";
import { failureText, type SessionEvent } from "./session.ts";
import { appendLine, newMsg, replaceFile, StoreError } from "./store.ts";
import type { Entry, Mem } from "./tree.ts";
import type { Mid, TurnEngine, TurnEvents } from "./turn/engine.ts";
import type { UsageRecord } from "./usage.ts";
import { render, settle } from "./view.ts";
import { canonicalRef, effortSplit, type SubagentInfo, type SubagentLog } from "./wire.ts";
import { ensureWorktree, mergeBack, type Worktrees } from "./worktree.ts";
import {
  type Agent,
  type AgentPlace,
  agentOf,
  cwdOf,
  decodeMeta,
  history,
  infoOf,
  intro,
  lineOf,
  metaOf,
  type Pending,
  readLog,
  shownEntry,
  SIDE_PAGE,
  type SubagentHost,
  SUBAGENTS_SHOWN,
  type Tell,
  USER_STOP,
  userStopped,
} from "./subagents/agent.ts";
import { makeReports, reportOf } from "./subagents/reports.ts";

export { type AgentPlace, REPORT_MAX, SIDE_CONTEXT, SIDE_PAGE, type SubagentHost, SUBAGENTS_SHOWN } from "./subagents/agent.ts";

// A call cut short by a dropped device runner link (the runner killed its claude) goes on from its
// side log after LINK_WAIT, at most LINK_TRIES times in a run, as after a restart (E40); then it
// fails and reports. The process itself doesn't survive the drop (deferred, SPEC M7b).
export const LINK_TRIES = 3;
export const LINK_WAIT = "5 seconds";
// A run a restart cut short goes on at most this many restarts in a row with no call of it
// completing since; the next restart stops it and reports why (E40), so a server that crashes
// soon after it starts doesn't call the model again at every start
export const RESUMES_MAX = 2;
const NAME = SUBAGENT_NAME; // src/mcp.ts: a letter, then up to 31 letters, digits, - or _

export type Subagents = {
  readonly list: () => readonly SubagentInfo[];
  readonly changes: PubSub.PubSub<true>;
  // spawn, tell and zoom("Name") for a turn's tools: the master's, or a subagent's (E38)
  readonly tools: (caller: Caller) => AgentTools;
  // who holds this /mcp key: a subagent, by its name; null for a key no subagent was given
  readonly callerOf: (key: string) => Caller | null;
  // the user's actions from a card: null when done, else why not
  // A tell with its client's `id` (E41) is told once: one held for its run, or in its side log, is
  // answered and not sent again
  readonly tell: (name: string, text: string, id?: string) => Effect.Effect<string | null>;
  readonly stop: (name: string) => Effect.Effect<string | null>;
  // the user's Stop all: every running subagent, stopped; their names
  readonly stopAll: Effect.Effect<readonly string[]>;
  readonly pick: (name: string, model: string) => Effect.Effect<string | null>;
  readonly log: (name: string, from?: number, limit?: number) => SubagentLog | null;
  // after a restart: the runs it cut short go on, and every report not delivered yet is sent
  readonly restore: Effect.Effect<void>;
};

const bareOf = (ref: string) => effortSplit(ref)[0];
// a run interrupted, and its end handed on (`launch`): what a stop waits for
const stopped = (a: Pick<Agent, "fiber" | "watcher">) => {
  const { fiber, watcher } = a;
  return Effect.andThen(fiber === null ? Effect.void : Fiber.interrupt(fiber), watcher === null ? Effect.void : Fiber.await(watcher));
};
// a message for a subagent as its call is offered it
const asMid = (t: Tell): Mid => ({ media: [], seq: t.seq, text: t.text });
const refused = (text: string) => Effect.succeed({ error: true, text });

// what a restart tells a subagent it cut short, as it goes on (E40)
const RESTARTED = "[from OptChat] The server restarted while you worked, and stopped your last call. Your log so far is above: carry on with your task from there, checking what your last steps left.";
// and what a dropped link does
const RECONNECTED = (device: string) =>
  `[from OptChat] The connection to ${device} dropped while you worked, and stopped your last call. Your log so far is above: carry on with your task from there, checking what your last steps left.`;

export const makeSubagents = (o: {
  readonly dir: string; // the stream: streams/<device>
  readonly device: string; // the server's own
  // the configured devices and their folders: where a subagent may run, and its default folder
  readonly devices: Readonly<Record<string, { readonly folders: readonly string[] }>>;
  readonly chain: readonly Ref[]; // the master's chain: the models a subagent may run on
  readonly effort: Effort; // the master's effort
  readonly max: number; // subagents running at once, every level counted (subagents.max)
  // a subagent's engine for a ref, placed for one call (src/engines/registry.ts, child)
  readonly engine: (ref: Ref, at: AgentPlace) => Effect.Effect<TurnEngine>;
  // a device's worktrees (src/worktree.ts); none: that device can't isolate
  readonly worktrees: (device: string) => Worktrees | undefined;
  // a folder asked for on a device, checked against that device's folders: its path, or why not
  readonly folderFor?: (device: string, path: string) => Result.Result<string, string>;
  readonly host: Deferred.Deferred<SubagentHost>;
  readonly mem: Mem; // for a view when no turn has been sent one yet
  readonly commit: Effect.Effect<string | null>;
  readonly logUsage: (record: UsageRecord) => Effect.Effect<void>;
  readonly publish: (e: SessionEvent) => Effect.Effect<void>;
  readonly linkWait?: Duration.Input; // LINK_WAIT; tests make it short
}): Effect.Effect<Subagents, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = `${o.dir}/agents`;
    const scope = yield* Effect.scope;
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();
    const changes = yield* PubSub.sliding<true>(1);
    const changed = PubSub.publish(changes, true).pipe(Effect.asVoid);
    const info = (message: string) => o.publish({ message, type: "info" });
    const folderFor = o.folderFor ?? ((_device: string, path: string) => Result.succeed(path));
    let seq = 0;
    // the /mcp keys given out, each to one subagent (E38): made at each start, never on disk
    const keys = new Map<string, string>();
    const newKey = (name: string) => {
      const key = crypto.randomUUID();
      keys.set(key, name);
      return key;
    };

    // a device's own folder for a subagent asked for none: its first folder, `~` expanded on this
    // machine (another's runner expands its own); undefined for a device with none
    const firstFolder = (device: string) => {
      const first = o.devices[device]?.folders[0];
      return first === undefined ? undefined : device === o.device ? expandHome(first) : first;
    };

    // ---- the models ----

    const chainText = () => o.chain.map((r) => r.ref).join(", ");
    // A model for a subagent: a ref of the master's chain, or one's engine:model at another effort,
    // which is clamped to what its model takes as the master's is (runEffort). Read as the chain
    // reads one: an effort that is the master's is the bare ref. Anything else is refused, never
    // replaced by a guess.
    const resolve = (asked: string): Result.Result<{ readonly ref: Ref; readonly effort: Effort | undefined }, string> => {
      const allowed = `allowed: ${chainText()}, each also at @low, @medium, @high, @xhigh or @max`;
      const canonical = canonicalRef(asked.trim(), o.effort);
      const exact = o.chain.find((r) => r.ref === canonical);
      if (exact) return Result.succeed({ effort: runEffort(exact, o.effort), ref: exact });
      const [bare, written] = effortSplit(canonical);
      const entry = o.chain.find((r) => bareOf(r.ref) === bare);
      if (!entry) return Result.fail(`${asked} is not a model of the master's chain (${allowed})`);
      if (written === undefined) return Result.succeed({ effort: runEffort(entry, o.effort), ref: entry });
      if (!isEffort(written)) return Result.fail(`${asked}: ${written} is not an effort (${allowed})`);
      const effort = runEffort({ ...entry, effort: undefined }, written);
      const ref = canonicalRef(effort === undefined ? bare : `${bare}@${effort}`, o.effort);
      return Result.succeed({ effort, ref: { ...entry, effort, ref } });
    };

    // ---- on disk ----

    const folder = (name: string) => `${root}/${name}`;
    const save = (a: Agent) => replaceFile(folder(a.name), "agent.json", `${JSON.stringify(metaOf(a))}\n`);
    const saveOrSay = (a: Agent) => save(a).pipe(Effect.catch((error) => info(error.message)));
    // its side log, read again from the file when it isn't in memory
    const entriesOf = (a: Agent): Entry[] => {
      a.entries ??= readLog(`${folder(a.name)}/log.jsonl`);
      return a.entries;
    };
    // one entry of its side log: written and synced before anything else knows it
    // `error` and `client` after the reference's keys, each only when set, as the main log's (E28, E41)
    const append = (a: Agent, kind: Entry["kind"], text: string, extra: { readonly error?: true; readonly client?: string } = {}) =>
      Effect.suspend(() => {
        const entry: Entry = { ...newMsg(a.count, kind, text), ...extra };
        return Effect.try({
          catch: (e) => new StoreError({ message: `cannot log ${a.name}'s entry ${entry.i}: ${e instanceof Error ? e.message : String(e)}` }),
          try: () => {
            appendLine(folder(a.name), "log.jsonl", `${JSON.stringify(entry)}\n`);
          },
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              a.entries?.push(entry);
              a.count += 1;
              a.lastLine = lineOf(entry);
            }),
          ),
          Effect.andThen(changed),
          Effect.uninterruptible,
        );
      });

    // What an earlier run left: every agents/<Name>/ whose agent.json reads and names that folder
    // (one that doesn't is reported and left alone). Its side log stays on disk unless it was
    // running (a restart cut it short: its length on disk is the truth) or its agent.json is from
    // before the length was kept.
    const loaded: Agent[] = [];
    const problems: string[] = [];
    if (existsSync(root))
      for (const name of readdirSync(root).toSorted()) {
        const metaPath = `${folder(name)}/agent.json`;
        if (!NAME.test(name) || !existsSync(metaPath) || !statSync(folder(name)).isDirectory()) continue;
        const meta = decodeMeta(readFileSync(metaPath, "utf8"));
        if (meta._tag === "None") {
          problems.push(`subagent ${name}: agent.json is unreadable; left alone`);
          continue;
        }
        const m = meta.value;
        if (m.name !== name) {
          problems.push(`subagent ${name}: agent.json names ${m.name}, not its folder; left alone`);
          continue;
        }
        const entries = m.state === "running" || m.entries === undefined ? readLog(`${folder(name)}/log.jsonl`) : null;
        const model = resolve(m.ref);
        const device = m.device ?? o.device;
        loaded.push(agentOf(m, { device, entries, folder: firstFolder(device) ?? "", key: newKey(name), model: Result.isSuccess(model) ? model.success : null }));
      }
    const agents = new Map<string, Agent>(loaded.map((a) => [a.name.toLowerCase(), a]));
    const find = (name: string) => agents.get(name.trim().toLowerCase());
    const running = () => [...agents.values()].filter((a) => a.state === "running");
    const capText = (names: readonly string[]) => `${names.length} subagents run already (${names.join(", ")}), at most ${o.max} at once`;
    // the others working directly in the same folder as `a` right now, or in one inside the other
    const sharing = (a: Agent) =>
      a.worktree === null ? running().filter((x) => x !== a && x.worktree === null && x.device === a.device && (within(x.folder, a.folder) || within(a.folder, x.folder))) : [];

    // ---- the state clients see ----

    const infoNow = (a: Agent) => infoOf(a, now(), o.effort);
    // every running one, then the newest others, up to SUBAGENTS_SHOWN
    const shown = () => {
      const all = [...agents.values()].toSorted((x, y) => y.started - x.started);
      const live = all.filter((a) => a.state === "running");
      const others = all.filter((a) => a.state !== "running").slice(0, Math.max(0, SUBAGENTS_SHOWN - live.length));
      return [...live, ...others];
    };
    const list = () => shown().map(infoNow);
    // the side logs of subagents no longer listed leave memory (their cards are gone)
    const evict = () => {
      const listed = new Set(shown());
      for (const a of agents.values()) if (!listed.has(a)) a.entries = null;
    };

    // ---- reports ----

    const reports = makeReports({
      begin: (a, view) => begin(a, view),
      cannotStart: (a) => cannotStart(a),
      chat: () => o.mem.root,
      entriesOf,
      find,
      host: o.host,
      nextSeq: () => ++seq,
      save: saveOrSay,
      scope,
    });
    const { deliver, delivered } = reports;

    // why a subagent that has ended can't start again now; null when it can
    const cannotStart = (a: Agent) => {
      const live = running().map((x) => x.name);
      if (live.length >= o.max) return capText(live);
      if (a.engineRef === null) return `its model ${a.ref} is not in the master's chain any more: pick one on its card (${chainText()})`;
      return null;
    };

    // A run ended: its state and its report, made at once, before this fiber yields (a tell may
    // start it again from the next step on), then saved, committed and delivered. Reports from its
    // own subagents it never took go to the chat, so none waits on a run that won't come.
    const ended = (a: Agent, runId: string, exit: Exit.Exit<void, EngineError | StoreError>): Effect.Effect<void> =>
      Effect.suspend(() => {
        a.fiber = null;
        a.offerTo = null;
        for (const t of a.tells) t.state = "held";
        // a message that came as its last call ended: one more call, as if it had come a moment sooner
        if (Exit.isSuccess(exit) && a.tells.length > 0) return launch(a, runId);
        if (Exit.isSuccess(exit)) {
          a.state = "done";
          a.why = null;
        } else if (Cause.hasInterruptsOnly(exit.cause)) {
          // the server is going down: left "running" on disk, for the next start to resume
          if (!a.stopping) return Effect.void;
          a.state = "stopped";
          a.why = USER_STOP;
        } else {
          const failure = Cause.findErrorOption(exit.cause);
          const defect = Cause.squash(exit.cause);
          a.state = "failed";
          a.why = Option.isSome(failure) ? failureText(failure.value) : `error: ${defect instanceof Error ? defect.message : String(defect)}`;
        }
        a.stopping = false;
        a.ended = now();
        if (a.state === "done") a.resumes = 0;
        // a run the user stopped wakes no one: the stop is a decision, not news to act on (E39)
        const report: Pending = a.why === USER_STOP ? { run: a.runs, text: reportOf(a, a.ended, entriesOf(a)), wake: false } : { run: a.runs, text: reportOf(a, a.ended, entriesOf(a)) };
        a.pending = report;
        const orphans = a.tells.flatMap((t) => (t.report === undefined ? [] : [t.report]));
        a.tells = a.tells.filter((t) => t.report === undefined);
        const told: SessionEvent =
          a.state === "done"
            ? { name: a.name, report: report.text, runId, type: "subagent-finished" }
            : { code: a.state === "stopped" ? "stopped" : "failed", message: a.why ?? a.state, name: a.name, runId, type: "subagent-error" };
        return Effect.gen(function* () {
          yield* saveOrSay(a);
          yield* o.publish(told);
          evict();
          yield* changed;
          yield* o.commit.pipe(Effect.flatMap((failed) => (failed ? info(`git: ${failed}`) : Effect.void)));
          yield* reports.orphaned(a, orphans);
          yield* deliver(a, report);
        });
      });

    // ---- a run ----

    // the view a call starts from: the turn's that spawned or told it, else the most recent turn's,
    // else the memory's own once every line is summarized (no call sees a placeholder)
    const viewFor = (a: Agent) =>
      Effect.gen(function* () {
        if (a.view !== null) return a.view;
        const host = yield* Deferred.await(o.host);
        const seen = host.lastView();
        if (seen !== null) return seen;
        yield* settle(o.mem);
        return render(o.mem);
      });

    // an isolated one's worktree for this call: its own, or a new one (src/worktree.ts)
    const worktreeFor = (a: Agent) =>
      Effect.gen(function* () {
        const w = yield* ensureWorktree(o.worktrees(a.device), { ...a, local: a.device === o.device }).pipe(Effect.mapError((e) => new StoreError({ message: e.message })));
        if (w === a.worktree) return;
        a.worktree = w;
        yield* saveOrSay(a);
        yield* changed;
      });

    // An isolated run's branch back into its folder (src/worktree.ts): never interrupted halfway, a
    // stop waits for it; a failure is the merge's answer, the branch kept
    const merged = (a: Agent) =>
      Effect.gen(function* () {
        if (a.worktree === null) return;
        const back = yield* mergeBack(o.worktrees(a.device), a.worktree, a.name);
        a.merge = back.merge;
        a.worktree = back.worktree;
        yield* saveOrSay(a);
        yield* changed;
      }).pipe(Effect.uninterruptible);

    // a message it was sent, in its side log now; a report from its own subagent is delivered then
    const logTell = (a: Agent, t: Tell) => append(a, "user", t.text, t.client === undefined ? {} : { client: t.client }).pipe(Effect.andThen(t.report === undefined ? Effect.void : delivered(t.report.child, t.report.run)));

    const run = (a: Agent): Effect.Effect<void, EngineError | StoreError> =>
      Effect.gen(function* () {
        let drops = 0; // calls a dropped link cut short in this run
        for (let fresh = a.count <= 1; ; fresh = false) {
          if (a.engineRef === null) return yield* new StoreError({ message: `${a.ref} is not a model of the master's chain any more (${chainText()})` });
          if (a.isolate) yield* worktreeFor(a);
          const engine = yield* o.engine(a.engineRef, { cwd: cwdOf(a), device: a.device, key: a.key, name: a.name });
          const { ref } = a;
          const view = yield* viewFor(a);
          a.view = view;
          // what was sent since its last call: logged now, and part of this call's opening
          const sent = a.tells.filter((t) => t.state === "held");
          a.tells = a.tells.filter((t) => !sent.includes(t));
          for (const t of sent) yield* logTell(a, t);
          const before = entriesOf(a);
          const opening = [intro(a, sharing(a)), `Task: ${a.task}`, ...(fresh ? [] : [history(a.name, before.slice(0, before.length - sent.length))]), ...sent.map((t) => t.text)].join("\n\n");
          const q = yield* Queue.unbounded<Tell>();
          a.offerTo = q;
          const out: TurnEvents = {
            info: (message) => info(`[${a.name}] ${message}`),
            // its side log keeps the artifact tools' stubs too (E31): zoom("Name") answers from it
            log: (kind, body, flags) => append(a, kind, loggedText(kind, body, flags?.tool), kind === "echo" && flags?.error === true ? { error: true } : {}),
            reasoning: () => Effect.void,
            text: () => Effect.void,
            thinking: () => Effect.void,
            // a message the call passed to the model: in its side log now, once
            took: (m) =>
              Effect.suspend(() => {
                const t = a.tells.find((x) => x.seq === m.seq);
                if (!t) return Effect.void;
                a.tells = a.tells.filter((x) => x !== t);
                return logTell(a, t);
              }),
            usage: (record) => {
              const own: UsageRecord = { ...record, ref, role: "subagent", subagent: a.name };
              return o.logUsage(own).pipe(Effect.andThen(o.publish({ record: own, type: "usage" })));
            },
          };
          const mid = { next: Queue.take(q).pipe(Effect.map(asMid)), ready: Queue.clear(q).pipe(Effect.map((ts) => ts.map(asMid))) };
          const ran = yield* Effect.result(engine.run({ device: a.device, earlier: [], media: [], mid, texts: [opening], view }, out, null));
          // what it was offered and never took is held for one more call
          a.offerTo = null;
          for (const t of a.tells) t.state = "held";
          if (Result.isFailure(ran)) {
            const e = ran.failure;
            if (e._tag !== "ModelError" || e.lostLink !== true || drops >= LINK_TRIES) return yield* Effect.fail(e);
            drops += 1;
            yield* info(`[${a.name}] ${e.message}; it goes on from its log in a moment`);
            a.tells.unshift({ seq: ++seq, state: "held", text: RECONNECTED(a.device) });
            yield* Effect.sleep(o.linkWait ?? LINK_WAIT);
            continue;
          }
          // a call completed: a restart that comes now resumes it afresh (E40)
          if (a.resumes > 0) {
            a.resumes = 0;
            yield* saveOrSay(a);
          }
          if (a.tells.length > 0) {
            yield* changed;
            continue;
          }
          // a clean end: an isolated one's branch goes back; a message that came meanwhile is one more call
          yield* merged(a);
          if (a.tells.length === 0) return;
          yield* changed;
        }
      });

    // A run in a fiber of its own, and a watcher that hands its end to `ended`, however it ends:
    // also when it is interrupted before it ever ran (Stop all as it starts), when an onExit of its
    // own would never be registered. A stop that came while it was being started finds it now.
    const launch = (a: Agent, runId: string) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkIn(run(a), scope);
        a.fiber = fiber;
        a.watcher = yield* Fiber.await(fiber).pipe(
          Effect.flatMap((exit) => ended(a, runId, exit)),
          Effect.forkIn(scope),
        );
        if (a.stopping) yield* Fiber.interrupt(fiber);
      });

    // a run starts (spawned, told after it ended, or resumed after a restart), counted against the
    // cap by the caller
    const begin = (a: Agent, view: string | null) =>
      Effect.gen(function* () {
        a.runs += 1;
        a.state = "running";
        a.started = now();
        a.ended = null;
        a.why = null;
        a.merge = null;
        a.view = view;
        const runId = `${a.name}+${a.runs}`;
        yield* save(a);
        yield* o.publish({ name: a.name, runId, task: a.task, type: "subagent-started" });
        yield* launch(a, runId);
        yield* changed;
      });

    // ---- the tools ----

    // one subagent per call (SPEC "Subagents", E36): the master names each one, and a turn that
    // wants several calls spawn several times, each answered at once
    const Spawn = Schema.Struct({
      name: Schema.String,
      task: Schema.String,
      model: Schema.optional(Schema.String),
      isolate: Schema.optional(Schema.Boolean),
      device: Schema.optional(Schema.String),
      folder: Schema.optional(Schema.String),
    });
    const Told = Schema.Struct({ name: Schema.String, text: Schema.String });

    const spawn = (caller: Caller, args: Readonly<Record<string, Schema.Json>>) =>
      Effect.gen(function* () {
        const decoded = Schema.decodeUnknownOption(Spawn)(args);
        if (decoded._tag === "None") return yield* refused("spawn: give a name and a task (and a model, isolate, device or folder, if not yours)");
        const { model, name, task } = decoded.value;
        if (!NAME.test(name)) return yield* refused(`spawn: "${name}" is not a name: a letter, then up to 31 letters, digits, - or _ ("scout", "repo-2")`);
        if (task.trim() === "") return yield* refused("spawn: the task is empty");
        const host = yield* Deferred.await(o.host);
        // who spawns: a turn of the master, or a running subagent (E38), whose model, device,
        // folder and view are the defaults
        const turn = host.turnNow();
        const parent = caller === "master" ? null : find(caller.agent);
        if (caller === "master" && turn === null) return yield* refused("spawn: only a turn can start a subagent");
        if (caller !== "master" && parent?.state !== "running") return yield* refused("spawn: only a running subagent can start one");
        const from = parent === null || parent === undefined ? turn : { on: parent.device, ref: parent.ref, view: parent.view ?? "" };
        if (from === null) return yield* refused("spawn: only a turn can start a subagent");
        const taken = find(name);
        if (taken) return yield* refused(`spawn: there is a subagent called ${taken.name} already (${taken.state}): tell("${taken.name}", …) gives it more work, or pick another name`);
        const live = running().map((a) => a.name);
        if (live.length >= o.max) return yield* refused(`spawn: ${capText(live)}. Their reports will come; or ask the user to stop one`);
        const picked = resolve(model ?? from.ref);
        if (Result.isFailure(picked)) return yield* refused(`spawn: ${picked.failure}`);
        const device = decoded.value.device ?? from.on;
        if (!(device in o.devices)) return yield* refused(`spawn: ${device} is not a device (${Object.keys(o.devices).join(", ")})`);
        // its folder: the one asked for (relative to the caller's own), else the caller's own on the
        // same device (a subagent's spawns work where it works), else the device's first
        const own = parent?.device === device ? cwdOf(parent) : firstFolder(device);
        if (own === undefined) return yield* refused(`spawn: ${device} has no folders to work in`);
        const asked = decoded.value.folder;
        const checked = asked === undefined ? Result.succeed(own) : folderFor(device, posix.isAbsolute(asked) || asked.startsWith("~") ? asked : posix.join(own, asked));
        if (Result.isFailure(checked)) return yield* refused(`spawn: ${checked.failure}`);
        const { effort, ref } = picked.success;
        const isolate = decoded.value.isolate === true;
        const trees = o.worktrees(device);
        if (isolate && trees === undefined) return yield* refused(`spawn: ${device} can't make worktrees`);
        const meta = { effort: effort ?? null, ended: null, folder: checked.success, isolate, name, parent: parent?.name ?? null, ref: ref.ref, runs: 0, started: new Date(now()).toISOString(), state: "running", task, why: null, device } as const;
        const a = agentOf(meta, { device, entries: [], folder: checked.success, key: newKey(name), model: { effort, ref } });
        agents.set(name.toLowerCase(), a); // at once: a second spawn in the same step finds it, and the cap counts it
        const started = Effect.gen(function* () {
          // an isolated one's worktree before anything is written: a folder that can't be isolated is the tool's error
          if (isolate && trees !== undefined) a.worktree = yield* trees.add(a.folder, name).pipe(Effect.mapError((e) => new StoreError({ message: e.message })));
          yield* Effect.try({ catch: (e) => new StoreError({ message: String(e) }), try: () => mkdirSync(folder(name), { recursive: true }) });
          yield* append(a, "user", task);
          yield* begin(a, from.view === "" ? null : from.view);
        });
        // one step a stop can't split: a parent stopped while it spawns (Stop all) finds its child
        // either not made or started, never listed as running with no run behind it
        const failed = yield* Effect.result(started).pipe(Effect.uninterruptible);
        if (Result.isFailure(failed)) {
          agents.delete(name.toLowerCase());
          // a worktree it made goes too, so the same name can be spawned again
          const made = a.worktree;
          if (made !== null && trees !== undefined) yield* trees.discard(made).pipe(Effect.catch((error) => info(`spawn ${name}: ${error.message}`)));
          return yield* refused(`spawn: ${failed.failure.message}`);
        }
        const where = a.worktree === null ? `directly in ${a.folder} on ${device}` : `in its own worktree ${a.worktree.path} on ${device}, branch ${a.worktree.branch} from ${a.worktree.repo}`;
        const reader = parent === null || parent === undefined ? "the chat" : "you";
        return {
          error: false,
          text: `Started ${name} on ${entryLabel(ref, o.effort)}, ${where}. It runs in the background; its report will reach ${reader} as a message starting "[${name}] ". Don't wait for it.`,
        };
      });

    // A message for a subagent: offered to the call it runs, else held for the next; one that has
    // ended starts again with it, within the cap. One the user stopped (or is stopping) is never
    // reached by another subagent's message, as by its report (E38): refused, not held, so the
    // sender knows at once and says it in its own report, which reaches the chat; a held one would
    // wait unseen in a run that may never come, and arrive stale if it did.
    // `sender`: the user from a card, the master's turn, or a subagent, which the message's label names
    const send = (name: string, text: string, sender: "user" | Caller, client?: string) =>
      Effect.gen(function* () {
        const a = find(name);
        if (!a) return Result.fail(`no subagent called ${name}${agents.size === 0 ? "" : ` (there are ${[...agents.values()].map((x) => x.name).join(", ")})`}`);
        if (text.trim() === "") return Result.fail("the message is empty");
        // the same tell again (E41): held for its run, or in its side log already
        if (client !== undefined && (a.tells.some((t) => t.client === client) || entriesOf(a).some((e) => e.client === client))) return Result.succeed(`${a.name} has it already.`);
        const from = sender === "user" ? "the user" : sender === "master" ? "OptChat" : sender.agent;
        if (sender !== "user" && sender !== "master" && userStopped(a)) return Result.fail(`the user stopped ${a.name}, and a subagent's message doesn't start it again. Say it in your final reply instead, which your report carries`);
        const told: Tell = { seq: ++seq, state: "held", text: `[from ${from}] ${text}` };
        const t: Tell = client === undefined ? told : { ...told, client };
        if (a.state === "running") {
          a.tells.push(t);
          if (a.offerTo) {
            t.state = "offered";
            Queue.offerUnsafe(a.offerTo, t);
          }
          return Result.succeed(`Sent to ${a.name}; it reads it between its tool calls.`);
        }
        const why = cannotStart(a);
        if (why !== null) return Result.fail(`${a.name} has ended (${a.state}) and can't start again now: ${why}`);
        a.tells.push(t);
        a.resumes = 0;
        const host = yield* Deferred.await(o.host);
        const was = a.state;
        const started = yield* Effect.result(begin(a, host.turnNow()?.view ?? null));
        if (Result.isFailure(started)) {
          a.tells = a.tells.filter((x) => x !== t);
          a.state = was;
          return Result.fail(started.failure.message);
        }
        return Result.succeed(`${a.name} had ended (${was}); it starts again with your message.`);
      });

    const zoom = (name: string, from: number) => {
      const a = find(name);
      if (!a) return `No subagent ${name}.${agents.size === 0 ? "" : ` Subagents: ${[...agents.values()].map((x) => x.name).join(", ")}.`}`;
      const start = Number.isSafeInteger(from) && from > 0 ? from : 0;
      const entries = entriesOf(a);
      const head = `${a.name}: ${a.state}${a.why === null ? "" : ` (${a.why})`}, on ${a.ref}, ${entries.length} entries; its task is entry 0.`;
      const lines: string[] = [];
      let size = 0;
      let k = start;
      for (; k < entries.length; k++) {
        const line = shownEntry(entries[k] ?? { i: k, kind: "note", text: "" });
        if (lines.length > 0 && size + line.length > SIDE_PAGE) break;
        lines.push(line);
        size += line.length + 1;
      }
      const more = k < entries.length ? `\n[more: zoom("${a.name}", ${k})]` : "";
      if (!shown().includes(a)) a.entries = null; // read for this answer only
      return [head, ...lines].join("\n") + more;
    };

    const tools = (caller: Caller): AgentTools => ({
      call: (tool, args) => {
        if (tool === "spawn") return spawn(caller, args);
        const told = Schema.decodeUnknownOption(Told)(args);
        if (told._tag === "None") return refused("tell: give a name and a text");
        // a subagent's key tells only while it runs, as it spawns only then
        if (caller !== "master" && find(caller.agent)?.state !== "running") return refused("tell: only a running subagent can tell one");
        if (caller !== "master" && told.value.name.trim().toLowerCase() === caller.agent.toLowerCase()) return refused("tell: that is you");
        return send(told.value.name, told.value.text, caller).pipe(
          Effect.map((r) => (Result.isSuccess(r) ? { error: false, text: r.success } : { error: true, text: `tell: ${r.failure}` })),
        );
      },
      zoom,
    });

    const callerOf = (key: string): Caller | null => {
      const name = keys.get(key);
      return name === undefined || find(name) === undefined ? null : { agent: name };
    };

    // ---- the user's, from a card ----

    const tell = (name: string, text: string, id?: string) => send(name, text, "user", id).pipe(Effect.map((r) => (Result.isSuccess(r) ? null : `tell ${name}: ${r.failure}`)));

    const stop = (name: string) =>
      Effect.gen(function* () {
        const a = find(name);
        if (!a) return `stop: no subagent called ${name}`;
        if (a.state !== "running") return `stop: ${a.name} is not running (${a.state})`;
        a.stopping = true;
        // one still being started has no fiber yet: it stops as it starts (`launch`); else its end
        // is waited for, report and all
        yield* stopped(a);
        return null;
      });

    // Every running one: all are marked stopping before any is interrupted, so a child's report as it
    // ends never starts a parent that is about to stop (src/subagents/reports.ts)
    const stopAll = Effect.suspend(() => {
      const live = running();
      for (const a of live) a.stopping = true;
      // one still being started has no fiber yet: it stops as it starts (begin)
      return Effect.forEach(live, stopped, { concurrency: "unbounded", discard: true }).pipe(Effect.as(live.map((a) => a.name)));
    });

    // the model of its next call: the running one, if any, keeps its own
    const pick = (name: string, model: string) =>
      Effect.gen(function* () {
        const a = find(name);
        if (!a) return `model: no subagent called ${name}`;
        const picked = resolve(model);
        if (Result.isFailure(picked)) return `model of ${a.name}: ${picked.failure}`;
        a.engineRef = picked.success.ref;
        a.ref = picked.success.ref.ref;
        a.effort = picked.success.effort;
        yield* saveOrSay(a);
        yield* changed;
        return null;
      });

    // its entries from `from`, at most `limit` of them; one no longer listed is read for this answer only
    const log = (name: string, from = 0, limit = Number.POSITIVE_INFINITY): SubagentLog | null => {
      const a = find(name);
      if (!a) return null;
      const entries = entriesOf(a).slice(from, from + limit);
      if (!shown().includes(a)) a.entries = null;
      return { entries, subagent: infoNow(a) };
    };

    // After a restart (E40): each run it cut short goes on, oldest first, as after a tell, while
    // the cap allows; one past it (subagents.max lowered) or without a model is stopped and
    // reported, as M7a did with all of them. Then every report not delivered yet is sent, unless
    // its reader holds it already.
    const restore = Effect.gen(function* () {
      for (const p of problems) yield* info(p);
      const cut = [...agents.values()].filter((a) => a.state === "running" && a.fiber === null).toSorted((x, y) => x.started - y.started);
      for (const a of cut) a.state = "stopped"; // not running until resumed: the cap counts the resumed ones only
      for (const a of cut) {
        const looping = a.resumes >= RESUMES_MAX;
        const why = looping ? null : cannotStart(a);
        if (!looping && why === null) {
          a.resumes += 1;
          a.tells.push({ seq: ++seq, state: "held", text: RESTARTED });
          const resumed = yield* Effect.result(begin(a, null));
          if (Result.isSuccess(resumed)) continue;
          a.tells = [];
          a.state = "stopped";
        }
        const last = entriesOf(a).at(-1);
        a.why = looping
          ? `the server restarted ${a.resumes + 1} times while it ran, with no call of it completing since`
          : `the server restarted while it ran, and it could not go on: ${why ?? "its state could not be saved"}`;
        a.ended = last === undefined ? now() : Date.parse(last.date) || now();
        a.resumes = 0;
        a.pending = { run: a.runs, text: reportOf(a, a.ended, entriesOf(a)) };
        yield* saveOrSay(a);
      }
      for (const a of agents.values()) {
        const { ended, pending } = a;
        if (pending === null) continue; // a resumed one's too: the report of a run before the one cut short
        if (ended !== null && reports.readerHolds(a, pending.text, ended)) {
          a.pending = null;
          yield* saveOrSay(a);
        } else yield* deliver(a, pending);
      }
      evict();
      yield* changed;
    });

    return { callerOf, changes, list, log, pick, restore, stop, stopAll, tell, tools };
  });
