// Subagents, phase 1 (SPEC M7a; docs/optchat.md §5–§6, the earlier gist's §9). The master starts
// one with spawn(name, task, model?): a run in the background, on the server's own device, through
// the same engines as a turn, read-only (Read, Glob, Grep, zoom and date). It outlives the master's
// turn, cancelled or not. Its steps go to a side log of its own, never to the chat's log or tree;
// only its report does: a `user` entry starting "[Name] " (E23), logged by the session when no turn
// runs, never starting one (src/session.ts `report`). tell(name, text) reaches a running one between
// its tool calls, and starts one that has ended again. zoom("Name") reads a side log. The user
// stops one, tells it something or picks its model from its card (server/routes/ws.ts).
//
// On disk, beside the stream's chat/ (SPEC "Subagents"):
//   streams/<device>/agents/<Name>/log.jsonl   its side log: one line per entry, the main log's
//                                              records (records.ts Msg), append-only, fsynced
//   streams/<device>/agents/<Name>/agent.json  what it is: task, model, state, times, and whether
//                                              its last report is in the chat yet; replaced whole
// Both are committed with the data dir. A run that a restart cut short is found "running" at the
// next start: it is marked stopped and reported so, and nothing resumes it.
//
// Each call of a run is one engine call: the view (the turn's that spawned it, or that told it,
// cached as that turn's), then one opening text: who it is, its task, and on a later call what its
// side log holds so far (its newest entries, within SIDE_CONTEXT) and the messages it was sent
// since. Messages sent while a call runs are offered to it; what it never took starts the next call.
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Option, PubSub, Queue, Result, Schema, type Scope } from "effect";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { type Effort, entryLabel, isEffort, type Ref, runEffort } from "./config.ts";
import type { EngineError } from "./engines/errors.ts";
import { type AgentTools, SUBAGENT_NAME } from "./mcp.ts";
import { Msg } from "./records.ts";
import { failureText, type SessionEvent } from "./session.ts";
import { appendLine, newMsg, replaceFile, StoreError } from "./store.ts";
import { headOf } from "./text.ts";
import type { Entry, Mem } from "./tree.ts";
import type { Mid, TurnEngine, TurnEvents } from "./turn/engine.ts";
import type { UsageRecord } from "./usage.ts";
import { render, settle } from "./view.ts";
import { canonicalRef, effortSplit, type SubagentInfo, type SubagentLog, SubagentState } from "./wire.ts";

// at most this many run at once; a spawn or a tell that would start one more is refused, naming them
export const SUBAGENTS_AT_ONCE = 2;
// the characters of a final reply its report carries; past that it is cut, and zoom("Name") has it whole
export const REPORT_MAX = 8000;
// the characters one zoom("Name") answers with; the next page starts where it says (the master logs
// the answer as an echo, capped at CAP, 30,000)
export const SIDE_PAGE = 28_000;
// the characters of its own side log a later call of a subagent is sent, its newest entries
export const SIDE_CONTEXT = 60_000;
// the subagents the state lists: every running one, then the newest others up to this many in all
export const SUBAGENTS_SHOWN = 8;
// the characters of a side log's newest line the state carries
const LAST_LINE = 160;
const NAME = SUBAGENT_NAME; // src/mcp.ts: a letter, then up to 31 letters, digits, - or _

// what the session gives the supervisor, once it exists (it needs the supervisor's list first)
export type SubagentHost = {
  readonly report: (text: string) => Effect.Effect<void>;
  readonly turnNow: () => { readonly ref: string; readonly view: string } | null;
  readonly lastView: () => string | null;
};

export type Subagents = {
  readonly list: () => readonly SubagentInfo[];
  readonly changes: PubSub.PubSub<true>;
  // spawn, tell and zoom("Name") for a turn's tools: the master's, or a subagent's, which can't
  // start or tell one (no nesting)
  readonly tools: (caller: "master" | "subagent") => AgentTools;
  // the user's actions from a card: null when done, else why not
  readonly tell: (name: string, text: string) => Effect.Effect<string | null>;
  readonly stop: (name: string) => Effect.Effect<string | null>;
  readonly pick: (name: string, model: string) => Effect.Effect<string | null>;
  readonly log: (name: string) => SubagentLog | null;
  // after a restart: the runs it cut short are stopped, and every report not in the chat yet is sent
  readonly restore: Effect.Effect<void>;
};

const Meta = Schema.Struct({
  name: Schema.String,
  task: Schema.String,
  ref: Schema.String,
  effort: Schema.NullOr(Schema.String),
  state: SubagentState,
  started: Schema.String,
  ended: Schema.NullOr(Schema.String),
  why: Schema.NullOr(Schema.String),
  runs: Schema.Number,
  reported: Schema.Boolean,
});
type Meta = typeof Meta.Type;
const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(Meta));
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(Msg));

// a message sent to a subagent: held for its next call, or offered to the running one
type Tell = { readonly seq: number; readonly text: string; state: "held" | "offered" };

type Agent = {
  readonly name: string;
  readonly task: string;
  ref: string; // as the master's chain spells it (canonicalRef)
  engineRef: Ref | null; // null: a ref the config no longer has (after a restart)
  effort: Effort | undefined;
  state: SubagentState;
  started: number;
  ended: number | null;
  why: string | null;
  runs: number;
  reported: boolean;
  readonly entries: Entry[];
  tells: Tell[];
  offerTo: Queue.Queue<Tell> | null;
  fiber: Fiber.Fiber<void, EngineError | StoreError> | null;
  stopping: boolean; // the user stopped it: an interrupt is that, not the server going down
  view: string | null;
};

const iso = (ms: number) => new Date(ms).toISOString();
const bareOf = (ref: string) => effortSplit(ref)[0];
const capText = (names: readonly string[]) => `${names.length} subagents run already (${names.join(", ")}), at most ${SUBAGENTS_AT_ONCE} at once`;
const refused = (text: string) => Effect.succeed({ error: true, text });
const flat = (text: string) => text.replaceAll(/\s+/g, " ").trim();

// "12 s", "2 min 05 s": how long a run took, for its report
const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
};

// What the first message of each call says after the view (one system prompt for every call,
// docs/optchat.md §5, so who it is goes here)
const intro = (name: string) =>
  `[optchat: You are the subagent "${name}", started by OptChat for the task below. The view above is OptChat's memory, context only: do what your task says, not what the user's last message says. You can read files (Read, Glob, Grep) and memory (zoom, date), and nothing else: you write no file and run no command. Messages from OptChat or the user may reach you while you work. Your final reply is your report to OptChat: what you found and what will matter later, in a few lines.]`;

const shownEntry = (e: Pick<Entry, "i" | "kind" | "text">) => `${e.i}|${e.kind}: ${e.text}`;

// a later call's own history: its newest entries within SIDE_CONTEXT, after the task (entry 0)
const history = (name: string, entries: readonly Entry[]) => {
  const kept: string[] = [];
  let room = SIDE_CONTEXT;
  let k = entries.length - 1;
  for (; k >= 1; k--) {
    const line = shownEntry(entries[k] ?? { i: k, kind: "note", text: "" });
    if (line.length > room) break;
    room -= line.length + 1;
    kept.unshift(line);
  }
  const left = k >= 1 ? `\n[${k} older entries left out: zoom("${name}", 1) reads them]` : "";
  return `[optchat: You worked on this before. Your own log so far, oldest first (zoom("${name}") reads it too); carry on from there:]${left}\n${kept.join("\n")}`;
};

export const makeSubagents = (o: {
  readonly dir: string; // the stream: streams/<device>
  readonly device: string; // the server's own: every call runs here
  readonly chain: readonly Ref[]; // the master's chain: the models a subagent may run on
  readonly effort: Effort; // the master's effort
  readonly engine: (ref: Ref) => Effect.Effect<TurnEngine>; // a subagent's engine for a ref (src/engines/registry.ts, child)
  readonly host: Deferred.Deferred<SubagentHost>;
  readonly mem: Mem; // for a view when no turn has been sent one yet
  readonly commit: Effect.Effect<string | null>;
  readonly logUsage: (record: UsageRecord) => Effect.Effect<void>;
  readonly publish: (e: SessionEvent) => Effect.Effect<void>;
}): Effect.Effect<Subagents, never, Scope.Scope> =>
  Effect.gen(function* () {
    const root = `${o.dir}/agents`;
    const scope = yield* Effect.scope;
    const clock = yield* Clock.Clock;
    const now = () => clock.currentTimeMillisUnsafe();
    const changes = yield* PubSub.sliding<true>(1);
    const changed = PubSub.publish(changes, true).pipe(Effect.asVoid);
    const info = (message: string) => o.publish({ message, type: "info" });
    let seq = 0;

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
    const metaOf = (a: Agent): Meta => ({
      effort: a.effort ?? null,
      ended: a.ended === null ? null : iso(a.ended),
      name: a.name,
      reported: a.reported,
      ref: a.ref,
      runs: a.runs,
      started: iso(a.started),
      state: a.state,
      task: a.task,
      why: a.why,
    });
    const save = (a: Agent) => replaceFile(folder(a.name), "agent.json", `${JSON.stringify(metaOf(a))}\n`);
    // one entry of its side log: written and synced before anything else knows it
    const append = (a: Agent, kind: Entry["kind"], text: string, error = false) =>
      Effect.suspend(() => {
        const base = newMsg(a.entries.length, kind, text);
        const entry: Entry = error ? { ...base, error: true } : base;
        return Effect.try({
          catch: (e) => new StoreError({ message: `cannot log ${a.name}'s entry ${entry.i}: ${e instanceof Error ? e.message : String(e)}` }),
          try: () => {
            appendLine(folder(a.name), "log.jsonl", `${JSON.stringify(entry)}\n`);
          },
        }).pipe(
          Effect.tap(() => Effect.sync(() => a.entries.push(entry))),
          Effect.andThen(changed),
          Effect.uninterruptible,
        );
      });

    // what an earlier run left: every agents/<Name>/ with an agent.json that reads (one that
    // doesn't is reported and left alone), its side log's lines that read
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
        const logPath = `${folder(name)}/log.jsonl`;
        const lines = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n") : [];
        const entries = lines.flatMap((line) => {
          const e = line.trim() === "" ? undefined : decodeEntry(line);
          return e?._tag === "Some" ? [{ ...e.value, size: e.value.size ?? 0 }] : [];
        });
        const model = resolve(m.ref);
        loaded.push({
          effort: Result.isSuccess(model) ? model.success.effort : m.effort !== null && isEffort(m.effort) ? m.effort : undefined,
          ended: m.ended === null ? null : Date.parse(m.ended),
          engineRef: Result.isSuccess(model) ? model.success.ref : null,
          entries,
          fiber: null,
          name: m.name,
          offerTo: null,
          ref: m.ref,
          reported: m.reported,
          runs: m.runs,
          started: Date.parse(m.started),
          state: m.state,
          stopping: false,
          task: m.task,
          tells: [],
          view: null,
          why: m.why,
        });
      }
    const agents = new Map<string, Agent>(loaded.map((a) => [a.name.toLowerCase(), a]));
    const find = (name: string) => agents.get(name.trim().toLowerCase());
    const runningNames = () => [...agents.values()].filter((a) => a.state === "running").map((a) => a.name);

    // ---- the state clients see ----

    const infoOf = (a: Agent): SubagentInfo => {
      const last = a.entries.at(-1);
      const base: SubagentInfo = {
        device: o.device,
        effort: a.effort ?? null,
        elapsed: Math.max(0, (a.ended ?? now()) - a.started),
        entries: a.entries.length,
        label: a.engineRef ? entryLabel(a.engineRef, o.effort) : a.ref,
        name: a.name,
        ref: a.ref,
        started: iso(a.started),
        state: a.state,
        task: a.task,
      };
      const withLast = last === undefined ? base : { ...base, lastLine: headOf(flat(`${last.kind}: ${last.text}`), LAST_LINE) };
      return a.why === null ? withLast : { ...withLast, why: a.why };
    };
    const list = () => {
      const all = [...agents.values()].toSorted((x, y) => y.started - x.started);
      const running = all.filter((a) => a.state === "running");
      const others = all.filter((a) => a.state !== "running").slice(0, Math.max(0, SUBAGENTS_SHOWN - running.length));
      return [...running, ...others].map(infoOf);
    };

    // ---- reports ----

    // What reaches the chat when a run ends: its final reply, or why there is none
    const reportOf = (a: Agent) => {
      const head = `[${a.name}] `;
      const ran = took((a.ended ?? now()) - a.started);
      const more = `zoom("${a.name}") reads its log (${a.entries.length} entries)`;
      if (a.state === "done") {
        const reply = a.entries.findLast((e) => e.kind === "talk")?.text.trim() ?? "";
        if (reply === "") return `${head}finished after ${ran} without a reply; ${more}.`;
        const kept = headOf(reply, REPORT_MAX);
        return kept === reply ? `${head}${reply}` : `${head}${kept}\n[… ${reply.length - kept.length} characters cut: ${more}]`;
      }
      if (a.state === "failed") return `${head}failed after ${ran} (${a.why ?? "no reason given"}) on ${a.ref}; ${more}.`;
      return `${head}stopped after ${ran}: ${a.why ?? "stopped"}. ${more}; tell("${a.name}", …) starts it again.`;
    };

    // Into the chat once the session logs it; then marked reported, so a restart before that sends
    // it again and one after doesn't. Forked: the session logs it when no turn runs.
    const sendReport = (a: Agent) =>
      Effect.gen(function* () {
        const host = yield* Deferred.await(o.host);
        yield* host.report(reportOf(a));
        a.reported = true;
        yield* save(a).pipe(Effect.catch((error) => info(error.message)));
      }).pipe(Effect.forkIn(scope), Effect.asVoid);

    // a run ended: its state, saved and committed, then the report
    const ended = (a: Agent, runId: string, exit: Exit.Exit<void, EngineError | StoreError>): Effect.Effect<void> =>
      Effect.gen(function* () {
        a.fiber = null;
        a.offerTo = null;
        for (const t of a.tells) t.state = "held";
        // a message that came as its last call ended: one more call, as if it had come a moment sooner
        if (Exit.isSuccess(exit) && a.tells.length > 0) {
          a.fiber = yield* Effect.forkIn(run(a, runId), scope);
          return;
        }
        if (Exit.isSuccess(exit)) {
          a.state = "done";
          a.why = null;
        } else if (Cause.hasInterruptsOnly(exit.cause)) {
          // the server is going down: left "running" on disk, for the next start to report
          if (!a.stopping) return;
          a.state = "stopped";
          a.why = "stopped by the user";
        } else {
          const failure = Cause.findErrorOption(exit.cause);
          const defect = Cause.squash(exit.cause);
          a.state = "failed";
          a.why = Option.isSome(failure) ? failureText(failure.value) : `error: ${defect instanceof Error ? defect.message : String(defect)}`;
        }
        a.stopping = false;
        a.ended = now();
        a.reported = false;
        yield* save(a).pipe(Effect.catch((error) => info(error.message)));
        yield* a.state === "done"
          ? o.publish({ name: a.name, report: reportOf(a), runId, type: "subagent-finished" })
          : o.publish({ code: a.state === "stopped" ? "stopped" : "failed", message: a.why ?? a.state, name: a.name, runId, type: "subagent-error" });
        yield* changed;
        yield* o.commit.pipe(Effect.flatMap((failed) => (failed ? info(`git: ${failed}`) : Effect.void)));
        yield* sendReport(a);
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

    const run = (a: Agent, runId: string): Effect.Effect<void, EngineError | StoreError> =>
      Effect.gen(function* () {
        for (let fresh = a.entries.length <= 1; ; fresh = false) {
          if (a.engineRef === null) return yield* new StoreError({ message: `${a.ref} is not a model of the master's chain any more (${chainText()})` });
          const engine = yield* o.engine(a.engineRef);
          const { ref } = a;
          const view = yield* viewFor(a);
          a.view = view;
          // what was sent since its last call: logged now, and part of this call's opening
          const sent = a.tells.filter((t) => t.state === "held");
          a.tells = a.tells.filter((t) => !sent.includes(t));
          for (const t of sent) yield* append(a, "user", t.text);
          const opening = [intro(a.name), `Task: ${a.task}`, ...(fresh ? [] : [history(a.name, a.entries.slice(0, a.entries.length - sent.length))]), ...sent.map((t) => t.text)].join("\n\n");
          const q = yield* Queue.unbounded<Tell>();
          a.offerTo = q;
          const asMid = (t: Tell): Mid => ({ media: [], seq: t.seq, text: t.text });
          const out: TurnEvents = {
            info: (message) => info(`[${a.name}] ${message}`),
            log: (kind, body, flags) => append(a, kind, body, kind === "echo" && flags?.error === true),
            reasoning: () => Effect.void,
            text: () => Effect.void,
            thinking: () => Effect.void,
            // a message the call passed to the model: in its side log now, once
            took: (m) =>
              Effect.suspend(() => {
                const t = a.tells.find((x) => x.seq === m.seq);
                if (!t) return Effect.void;
                a.tells = a.tells.filter((x) => x !== t);
                return append(a, "user", t.text);
              }),
            usage: (record) => {
              const own: UsageRecord = { ...record, ref, role: "subagent", subagent: a.name };
              return o.logUsage(own).pipe(Effect.andThen(o.publish({ record: own, type: "usage" })));
            },
          };
          const mid = { next: Queue.take(q).pipe(Effect.map(asMid)), ready: Queue.clear(q).pipe(Effect.map((ts) => ts.map(asMid))) };
          yield* engine.run({ device: o.device, earlier: [], media: [], mid, texts: [opening], view }, out, null);
          // what it was offered and never took is held for one more call
          a.offerTo = null;
          for (const t of a.tells) t.state = "held";
          if (a.tells.length === 0) return;
          yield* changed;
        }
      }).pipe(Effect.onExit((exit) => ended(a, runId, exit)));

    // a run starts (spawned, or told after it ended), counted against the cap by the caller
    const begin = (a: Agent, view: string | null) =>
      Effect.gen(function* () {
        a.runs += 1;
        a.state = "running";
        a.started = now();
        a.ended = null;
        a.why = null;
        a.stopping = false;
        a.view = view;
        const runId = `${a.name}+${a.runs}`;
        yield* save(a);
        yield* o.publish({ name: a.name, runId, task: a.task, type: "subagent-started" });
        a.fiber = yield* Effect.forkIn(run(a, runId), scope);
        yield* changed;
      });

    // ---- the tools ----

    const Spawn = Schema.Struct({ name: Schema.String, task: Schema.String, model: Schema.optional(Schema.String) });
    const Told = Schema.Struct({ name: Schema.String, text: Schema.String });

    const spawn = (args: Readonly<Record<string, Schema.Json>>) =>
      Effect.gen(function* () {
        const decoded = Schema.decodeUnknownOption(Spawn)(args);
        if (decoded._tag === "None") return yield* refused("spawn: give a name and a task (and a model, if not this turn's)");
        const { model, name, task } = decoded.value;
        if (!NAME.test(name)) return yield* refused(`spawn: "${name}" is not a name: a letter, then up to 31 letters, digits, - or _ ("scout", "repo-2")`);
        if (task.trim() === "") return yield* refused("spawn: the task is empty");
        const host = yield* Deferred.await(o.host);
        const turn = host.turnNow();
        if (turn === null) return yield* refused("spawn: only a turn can start a subagent");
        const taken = find(name);
        if (taken) return yield* refused(`spawn: there is a subagent called ${taken.name} already (${taken.state}): tell("${taken.name}", …) gives it more work, or pick another name`);
        const running = runningNames();
        if (running.length >= SUBAGENTS_AT_ONCE) return yield* refused(`spawn: ${capText(running)}. Its report will come; or ask the user to stop one`);
        const picked = resolve(model ?? turn.ref);
        if (Result.isFailure(picked)) return yield* refused(`spawn: ${picked.failure}`);
        const { effort, ref } = picked.success;
        const a: Agent = {
          effort,
          ended: null,
          engineRef: ref,
          entries: [],
          fiber: null,
          name,
          offerTo: null,
          ref: ref.ref,
          reported: true,
          runs: 0,
          started: now(),
          state: "running",
          stopping: false,
          task,
          tells: [],
          view: null,
          why: null,
        };
        agents.set(name.toLowerCase(), a); // at once: a second spawn in the same step finds it
        const started = Effect.gen(function* () {
          yield* Effect.try({ catch: (e) => new StoreError({ message: String(e) }), try: () => mkdirSync(folder(name), { recursive: true }) });
          yield* append(a, "user", task);
          yield* begin(a, turn.view);
        });
        const failed = yield* Effect.result(started);
        if (Result.isFailure(failed)) {
          agents.delete(name.toLowerCase());
          return yield* refused(`spawn: ${failed.failure.message}`);
        }
        return {
          error: false,
          text: `Started ${name} on ${entryLabel(ref, o.effort)}. It runs in the background; its report will reach the chat as a message starting "[${name}] ". Don't wait for it.`,
        };
      });

    // a message for a subagent: offered to the call it runs, else held for the next; one that has
    // ended starts again with it, within the cap
    const send = (name: string, text: string, from: "OptChat" | "the user") =>
      Effect.gen(function* () {
        const a = find(name);
        if (!a) return Result.fail(`no subagent called ${name}${agents.size === 0 ? "" : ` (there are ${[...agents.values()].map((x) => x.name).join(", ")})`}`);
        if (text.trim() === "") return Result.fail("the message is empty");
        const t: Tell = { seq: ++seq, state: "held", text: `[from ${from}] ${text}` };
        if (a.state === "running") {
          a.tells.push(t);
          if (a.offerTo) {
            t.state = "offered";
            Queue.offerUnsafe(a.offerTo, t);
          }
          return Result.succeed(`Sent to ${a.name}; it reads it between its tool calls.`);
        }
        const running = runningNames();
        if (running.length >= SUBAGENTS_AT_ONCE) return Result.fail(`${a.name} has ended (${a.state}) and starting it again would make one too many: ${capText(running)}`);
        if (a.engineRef === null) return Result.fail(`${a.name}'s model ${a.ref} is not in the master's chain any more: pick one on its card (${chainText()})`);
        a.tells.push(t);
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
      const head = `${a.name}: ${a.state}${a.why === null ? "" : ` (${a.why})`}, on ${a.ref}, ${a.entries.length} entries; its task is entry 0.`;
      const lines: string[] = [];
      let size = 0;
      let k = start;
      for (; k < a.entries.length; k++) {
        const line = shownEntry(a.entries[k] ?? { i: k, kind: "note", text: "" });
        if (lines.length > 0 && size + line.length > SIDE_PAGE) break;
        lines.push(line);
        size += line.length + 1;
      }
      const more = k < a.entries.length ? `\n[more: zoom("${a.name}", ${k})]` : "";
      return [head, ...lines].join("\n") + more;
    };

    const tools = (caller: "master" | "subagent"): AgentTools => ({
      call: (tool, args) => {
        if (caller === "subagent") return refused(`${tool}: a subagent can't start or tell subagents`);
        if (tool === "spawn") return spawn(args);
        const told = Schema.decodeUnknownOption(Told)(args);
        if (told._tag === "None") return refused("tell: give a name and a text");
        return send(told.value.name, told.value.text, "OptChat").pipe(
          Effect.map((r) => (Result.isSuccess(r) ? { error: false, text: r.success } : { error: true, text: `tell: ${r.failure}` })),
        );
      },
      zoom,
    });

    // ---- the user's, from a card ----

    const tell = (name: string, text: string) => send(name, text, "the user").pipe(Effect.map((r) => (Result.isSuccess(r) ? null : `tell ${name}: ${r.failure}`)));

    const stop = (name: string) =>
      Effect.gen(function* () {
        const a = find(name);
        if (!a) return `stop: no subagent called ${name}`;
        const { fiber } = a;
        if (a.state !== "running" || fiber === null) return `stop: ${a.name} is not running (${a.state})`;
        a.stopping = true;
        yield* Fiber.interrupt(fiber);
        return null;
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
        yield* save(a).pipe(Effect.catch((error) => info(error.message)));
        yield* changed;
        return null;
      });

    const log = (name: string): SubagentLog | null => {
      const a = find(name);
      return a ? { entries: [...a.entries], subagent: infoOf(a) } : null;
    };

    const restore = Effect.gen(function* () {
      for (const p of problems) yield* info(p);
      for (const a of agents.values()) {
        if (a.state === "running" && a.fiber === null) {
          a.state = "stopped";
          a.why = "the server restarted while it ran; nothing resumes it";
          a.ended = a.entries.at(-1) ? Date.parse(a.entries.at(-1)?.date ?? "") || now() : now();
          a.reported = false;
          yield* save(a).pipe(Effect.catch((error) => info(error.message)));
        }
        if (!a.reported && a.state !== "running") yield* sendReport(a);
      }
      yield* changed;
    });

    return { changes, list, log, pick, restore, stop, tell, tools };
  });
