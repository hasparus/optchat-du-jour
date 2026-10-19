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
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Option, PubSub, Queue, Result, Schema, type Scope } from "effect";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { posix } from "node:path";
import { type Effort, entryLabel, isEffort, type Ref, runEffort } from "./config.ts";
import type { EngineError } from "./engines/errors.ts";
import { type AgentTools, type Caller, SUBAGENT_NAME } from "./mcp.ts";
import { expandHome } from "./paths.ts";
import { Msg } from "./records.ts";
import { failureText, type SessionEvent } from "./session.ts";
import { appendLine, newMsg, replaceFile, StoreError } from "./store.ts";
import { headOf } from "./text.ts";
import type { Entry, Mem } from "./tree.ts";
import type { Mid, TurnEngine, TurnEvents } from "./turn/engine.ts";
import type { UsageRecord } from "./usage.ts";
import { render, settle } from "./view.ts";
import { branchKept, canonicalRef, effortSplit, Isolation, Merge, type SubagentInfo, type SubagentLog, SubagentState } from "./wire.ts";
import type { Worktrees } from "./worktree.ts";

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
// the characters of another subagent's task its opening shows, when they share a folder
const TASK_SHOWN = 80;
const NAME = SUBAGENT_NAME; // src/mcp.ts: a letter, then up to 31 letters, digits, - or _

// what the session gives the supervisor, once it exists (it needs the supervisor's list first)
export type SubagentHost = {
  readonly report: (text: string) => Effect.Effect<void>;
  // the turn running now: its engine, the view it was sent, and its device
  readonly turnNow: () => { readonly ref: string; readonly view: string; readonly on: string } | null;
  readonly lastView: () => string | null;
};

// where one call of a subagent runs (E36): its device, its folder (the worktree of an isolated
// one), its own /mcp key, which names it to the server, and its name
export type AgentPlace = { readonly device: string; readonly cwd: string; readonly key: string; readonly name: string };

export type Subagents = {
  readonly list: () => readonly SubagentInfo[];
  readonly changes: PubSub.PubSub<true>;
  // spawn, tell and zoom("Name") for a turn's tools: the master's, or a subagent's (E38)
  readonly tools: (caller: Caller) => AgentTools;
  // who holds this /mcp key: a subagent, by its name; null for a key no subagent was given
  readonly callerOf: (key: string) => Caller | null;
  // the user's actions from a card: null when done, else why not
  readonly tell: (name: string, text: string) => Effect.Effect<string | null>;
  readonly stop: (name: string) => Effect.Effect<string | null>;
  // the user's Stop all: every running subagent, stopped; their names
  readonly stopAll: Effect.Effect<readonly string[]>;
  readonly pick: (name: string, model: string) => Effect.Effect<string | null>;
  readonly log: (name: string, from?: number, limit?: number) => SubagentLog | null;
  // after a restart: the runs it cut short go on, and every report not delivered yet is sent
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
  // the report made when its last run ended and not delivered yet, word for word
  pending: Schema.optional(Schema.NullOr(Schema.Struct({ run: Schema.Number, text: Schema.String }))),
  // its side log's length and newest line (LAST_LINE characters), so a subagent that isn't listed
  // needn't be read; a file without them is read once at startup
  entries: Schema.optional(Schema.Number),
  lastLine: Schema.optional(Schema.NullOr(Schema.String)),
  // M7b (a file from M7a has none: the server's own device, its first folder, not isolated, OptChat's)
  device: Schema.optional(Schema.String),
  folder: Schema.optional(Schema.String),
  isolate: Schema.optional(Schema.Boolean),
  worktree: Schema.optional(Schema.NullOr(Isolation)),
  merge: Schema.optional(Schema.NullOr(Merge)),
  parent: Schema.optional(Schema.NullOr(Schema.String)),
});
type Meta = typeof Meta.Type;
const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(Meta));
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(Msg));

// a report not delivered yet, and the run it ends (its `runs` then): two runs' reports with the
// same words stay two reports
type Pending = { readonly run: number; readonly text: string };

// A message sent to a subagent: held for its next call, or offered to the running one. A report
// from a subagent it spawned names that child and its run (`report`): once in its side log, the
// child's report is delivered.
type Tell = { readonly seq: number; readonly text: string; state: "held" | "offered"; readonly report?: { readonly child: string; readonly run: number } };

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
  pending: Pending | null; // the report not delivered yet
  entries: Entry[] | null; // its side log, while in memory (`entriesOf` reads it again)
  count: number; // its side log's length
  lastLine: string | null; // its newest line, as the state shows it
  tells: Tell[];
  offerTo: Queue.Queue<Tell> | null;
  fiber: Fiber.Fiber<void, EngineError | StoreError> | null;
  stopping: boolean; // the user stopped it: an interrupt is that, not the server going down
  view: string | null;
  readonly device: string; // where its calls run
  readonly folder: string; // where it works, the device's own path; an isolated one's worktree is made from it
  readonly isolate: boolean;
  worktree: Isolation | null; // an isolated one's worktree, while it has one
  merge: Merge | null; // how its last run's branch went back
  readonly parent: string | null; // the subagent that spawned it; null: OptChat
  readonly key: string; // its /mcp key, made at each start of the server
};

// the optional fields of a subagent's info, filled one by one (infoOf)
type InfoExtras = { -readonly [K in "lastLine" | "why" | "isolated" | "worktree" | "merge" | "parent"]?: NonNullable<SubagentInfo[K]> };

const iso = (ms: number) => new Date(ms).toISOString();
const bareOf = (ref: string) => effortSplit(ref)[0];
const refused = (text: string) => Effect.succeed({ error: true, text });
const flat = (text: string) => text.replaceAll(/\s+/g, " ").trim();
const within = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);

// "12 s", "2 min 05 s": how long a run took, for its report
const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
};

// where it works, for its card and its opening: its worktree while it has one, else its folder
const cwdOf = (a: Pick<Agent, "folder" | "worktree">) => a.worktree?.path ?? a.folder;
// who started it, as its opening and its report name them
const starter = (a: Pick<Agent, "parent">) => (a.parent === null ? "OptChat" : `the subagent "${a.parent}"`);

// What the first message of each call says after the view (one system prompt for every call,
// docs/optchat.md §5, so who it is and where it works go here). `others`: the subagents working
// directly in the same folder now (E36's soft guard): told so, it can keep out of their way.
const intro = (a: Agent, others: readonly Agent[]) => {
  const shared =
    others.length === 0
      ? ""
      : ` ${others.map((x) => `${x.name} (${headOf(flat(x.task), TASK_SHOWN)})`).join(", ")} ${others.length === 1 ? "works" : "work"} there now too: keep to the files your task needs, read a file again just before you edit it, and never undo a change you didn't make.`;
  const where =
    a.worktree === null
      ? `You work directly in ${a.folder} on ${a.device}, where OptChat and the user may change files too.${shared}`
      : `You work in a git worktree of your own, ${a.worktree.path} on ${a.device}, on branch ${a.worktree.branch}, made from ${a.worktree.repo} at ${a.worktree.base.slice(0, 12)}. Commit your work there. When you end, your branch is merged back into ${a.worktree.repo}'s branch if it merges cleanly (what you left uncommitted is committed first); a conflict is kept for later and said in your report.`;
  return `[optchat: You are the subagent "${a.name}", started by ${starter(a)} for the task below. The view above is OptChat's memory, context only: do what your task says, not what the user's last message says. ${where} You have OptChat's tools: files, commands and the web, zoom and date, and spawn and tell for subagents of your own, whose reports come to you. Messages from OptChat or the user may reach you while you work. Your final reply is your report to ${starter(a)}: what you did and changed, and what will matter later, in a few lines.]`;
};

// the line the state shows of a side log entry
const lineOf = (e: Pick<Entry, "kind" | "text">) => headOf(flat(`${e.kind}: ${e.text}`), LAST_LINE);

// a side log as its file holds it: the lines that read, in order
const readLog = (path: string): Entry[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line) => {
          const e = line.trim() === "" ? undefined : decodeEntry(line);
          return e?._tag === "Some" ? [{ ...e.value, size: e.value.size ?? 0 }] : [];
        })
    : [];

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

// the line a report ends with for an isolated run: how its branch went back
const mergeLine = (m: Merge) => `\n[${m.detail}${m.files > 0 ? `; ${m.files} files changed, +${m.insertions} -${m.deletions}` : ""}]`;

// Whether a log holds this report already, since the run ended: a restart between the reader's
// line and agent.json's would otherwise send it twice. The chat's copy may carry a note after it.
const holds = (log: readonly Entry[], text: string, since: number) => {
  for (let k = log.length - 1; k >= 0; k--) {
    const e = log[k];
    if (e === undefined || Date.parse(e.date) < since) return false;
    if (e.kind === "user" && (e.text === text || e.text.startsWith(`${text}\n[for `))) return true;
  }
  return false;
};

// what a restart tells a subagent it cut short, as it goes on (E40)
const RESTARTED = "[from OptChat] The server restarted while you worked, and stopped your last call. Your log so far is above: carry on with your task from there, checking what your last steps left.";

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
    const metaOf = (a: Agent): Meta => ({
      device: a.device,
      effort: a.effort ?? null,
      ended: a.ended === null ? null : iso(a.ended),
      entries: a.count,
      folder: a.folder,
      isolate: a.isolate,
      lastLine: a.lastLine,
      merge: a.merge,
      name: a.name,
      parent: a.parent,
      pending: a.pending,
      ref: a.ref,
      runs: a.runs,
      started: iso(a.started),
      state: a.state,
      task: a.task,
      why: a.why,
      worktree: a.worktree,
    });
    const save = (a: Agent) => replaceFile(folder(a.name), "agent.json", `${JSON.stringify(metaOf(a))}\n`);
    const saveOrSay = (a: Agent) => save(a).pipe(Effect.catch((error) => info(error.message)));
    // its side log, read again from the file when it isn't in memory
    const entriesOf = (a: Agent): Entry[] => {
      a.entries ??= readLog(`${folder(a.name)}/log.jsonl`);
      return a.entries;
    };
    // one entry of its side log: written and synced before anything else knows it
    const append = (a: Agent, kind: Entry["kind"], text: string, error = false) =>
      Effect.suspend(() => {
        const base = newMsg(a.count, kind, text);
        const entry: Entry = error ? { ...base, error: true } : base;
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
        const last = entries?.at(-1);
        const model = resolve(m.ref);
        const device = m.device ?? o.device;
        loaded.push({
          count: entries?.length ?? m.entries ?? 0,
          device,
          effort: Result.isSuccess(model) ? model.success.effort : m.effort !== null && isEffort(m.effort) ? m.effort : undefined,
          ended: m.ended === null ? null : Date.parse(m.ended),
          engineRef: Result.isSuccess(model) ? model.success.ref : null,
          entries,
          fiber: null,
          folder: m.folder ?? firstFolder(device) ?? "",
          isolate: m.isolate ?? false,
          key: newKey(name),
          lastLine: entries === null ? (m.lastLine ?? null) : last === undefined ? null : lineOf(last),
          merge: m.merge ?? null,
          name,
          offerTo: null,
          parent: m.parent ?? null,
          pending: m.pending ?? null,
          ref: m.ref,
          runs: m.runs,
          started: Date.parse(m.started),
          state: m.state,
          stopping: false,
          task: m.task,
          tells: [],
          view: null,
          why: m.why,
          worktree: m.worktree ?? null,
        });
      }
    const agents = new Map<string, Agent>(loaded.map((a) => [a.name.toLowerCase(), a]));
    const find = (name: string) => agents.get(name.trim().toLowerCase());
    const running = () => [...agents.values()].filter((a) => a.state === "running");
    const capText = (names: readonly string[]) => `${names.length} subagents run already (${names.join(", ")}), at most ${o.max} at once`;
    // the others working directly in the same folder as `a` right now, or in one inside the other
    const sharing = (a: Agent) =>
      a.worktree === null ? running().filter((x) => x !== a && x.worktree === null && x.device === a.device && (within(x.folder, a.folder) || within(a.folder, x.folder))) : [];

    // ---- the state clients see ----

    const infoOf = (a: Agent): SubagentInfo => {
      const base: SubagentInfo = {
        device: a.device,
        effort: a.effort ?? null,
        elapsed: Math.max(0, (a.ended ?? now()) - a.started),
        entries: a.count,
        folder: a.folder,
        label: a.engineRef ? entryLabel(a.engineRef, o.effort) : a.ref,
        name: a.name,
        ref: a.ref,
        started: iso(a.started),
        state: a.state,
        task: a.task,
      };
      // what it has of the optional fields, each only when it has it
      const more: InfoExtras = {};
      if (a.lastLine !== null) more.lastLine = a.lastLine;
      if (a.why !== null) more.why = a.why;
      if (a.isolate) more.isolated = true;
      if (a.worktree !== null) more.worktree = a.worktree;
      if (a.merge !== null) more.merge = a.merge;
      if (a.parent !== null) more.parent = a.parent;
      return { ...base, ...more };
    };
    // every running one, then the newest others, up to SUBAGENTS_SHOWN
    const shown = () => {
      const all = [...agents.values()].toSorted((x, y) => y.started - x.started);
      const live = all.filter((a) => a.state === "running");
      const others = all.filter((a) => a.state !== "running").slice(0, Math.max(0, SUBAGENTS_SHOWN - live.length));
      return [...live, ...others];
    };
    const list = () => shown().map(infoOf);
    // the side logs of subagents no longer listed leave memory (their cards are gone)
    const evict = () => {
      const listed = new Set(shown());
      for (const a of agents.values()) if (!listed.has(a)) a.entries = null;
    };

    // ---- reports ----

    // What its reader gets when a run ends: its final reply, or why there is none, and for an
    // isolated run how its branch went back (as its run ends: `ended` is when)
    const reportOf = (a: Agent, ended: number) => {
      const head = `[${a.name}] `;
      const ran = took(ended - a.started);
      const more = `zoom("${a.name}") reads its log (${a.count} entries)`;
      const keptNote = a.worktree === null ? "" : ` Its worktree ${a.worktree.path} (branch ${a.worktree.branch}) is kept: tell("${a.name}", …) goes on there.`;
      if (a.state === "done") {
        const merged = a.merge === null ? "" : mergeLine(a.merge);
        const reply = entriesOf(a).findLast((e) => e.kind === "talk")?.text.trim() ?? "";
        if (reply === "") return `${head}finished after ${ran} without a reply; ${more}.${merged}`;
        const cut = headOf(reply, REPORT_MAX);
        return cut === reply ? `${head}${reply}${merged}` : `${head}${cut}\n[… ${reply.length - cut.length} characters cut: ${more}]${merged}`;
      }
      if (a.state === "failed") return `${head}failed after ${ran} (${a.why ?? "no reason given"}) on ${a.ref}; ${more}.${keptNote}`;
      return `${head}stopped after ${ran}: ${a.why ?? "stopped"}. ${more}; tell("${a.name}", …) starts it again.${keptNote}`;
    };

    // the report of this run is with its reader: no longer pending, unless a later run's is by then
    const delivered = (child: string, run: number) =>
      Effect.suspend(() => {
        const a = find(child);
        if (a?.pending?.run !== run) return Effect.void;
        a.pending = null;
        return saveOrSay(a);
      });

    // This report, word for word, into the chat once the session logs it (src/session.ts: it wakes
    // an idle master, E39), with a note when it was for a subagent that couldn't take it. Forked:
    // the session logs it when no turn runs.
    const toChat = (a: Agent, report: Pending, note = "") =>
      Effect.gen(function* () {
        const host = yield* Deferred.await(o.host);
        yield* host.report(`${report.text}${note}`);
        yield* delivered(a.name, report.run);
      }).pipe(Effect.forkIn(scope), Effect.asVoid);

    // A report goes to whoever started its subagent (E38): the chat, or the subagent that spawned
    // it, as a message (between its tool calls while it runs; else it starts again with it, within
    // the cap). One its parent can't take (gone, at the cap, no model) goes to the chat instead.
    const deliver = (a: Agent, report: Pending): Effect.Effect<void> =>
      Effect.suspend(() => {
        const parent = a.parent === null ? undefined : find(a.parent);
        if (parent === undefined) return toChat(a, report, a.parent === null ? "" : `\n[for ${a.parent}, which is gone]`);
        const t: Tell = { report: { child: a.name, run: report.run }, seq: ++seq, state: "held", text: report.text };
        if (parent.state === "running") {
          parent.tells.push(t);
          if (parent.offerTo) {
            t.state = "offered";
            Queue.offerUnsafe(parent.offerTo, t);
          }
          return Effect.void;
        }
        const why = cannotStart(parent);
        if (why !== null) return toChat(a, report, `\n[for ${parent.name}, which could not take it: ${why}]`);
        parent.tells.push(t);
        return Effect.flatMap(Deferred.await(o.host), (host) => begin(parent, host.turnNow()?.view ?? null)).pipe(
          Effect.catch((error) =>
            Effect.suspend(() => {
              parent.tells = parent.tells.filter((x) => x !== t);
              return toChat(a, report, `\n[for ${parent.name}, which could not take it: ${error.message}]`);
            }),
          ),
        );
      });

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
        if (Exit.isSuccess(exit) && a.tells.length > 0)
          return Effect.forkIn(run(a, runId), scope).pipe(
            Effect.tap((fiber) => Effect.sync(() => (a.fiber = fiber))),
            Effect.asVoid,
          );
        if (Exit.isSuccess(exit)) {
          a.state = "done";
          a.why = null;
        } else if (Cause.hasInterruptsOnly(exit.cause)) {
          // the server is going down: left "running" on disk, for the next start to resume
          if (!a.stopping) return Effect.void;
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
        const report: Pending = { run: a.runs, text: reportOf(a, a.ended) };
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
          for (const r of orphans) {
            const child = find(r.child);
            if (child?.pending?.run === r.run) yield* toChat(child, child.pending, `\n[for ${a.name}, which ended (${a.state}) before it took this]`);
          }
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

    // the worktree of an isolated subagent that has none (spawned, merged back, or one a restart
    // finds gone on this machine): made from its folder's HEAD
    const worktreeFor = (a: Agent) =>
      Effect.gen(function* () {
        if (a.worktree !== null && (a.device !== o.device || existsSync(a.worktree.path))) return;
        const trees = o.worktrees(a.device);
        if (trees === undefined) return yield* new StoreError({ message: `${a.device} can't make worktrees` });
        a.worktree = yield* trees.add(a.folder, a.name).pipe(Effect.mapError((e) => new StoreError({ message: e.message })));
        yield* saveOrSay(a);
        yield* changed;
      });

    // An isolated run's branch back into its folder (src/worktree.ts): never interrupted halfway, a
    // stop waits for it. A failure is the merge's answer, not the run's: the branch is kept.
    const mergeBack = (a: Agent, w: Isolation) =>
      Effect.gen(function* () {
        const trees = o.worktrees(a.device);
        const failed = (message: string): Merge => ({ deletions: 0, detail: `not merged (${message}); ${w.branch} is kept with its worktree at ${w.path}`, files: 0, insertions: 0, into: null, outcome: "not-merged" });
        a.merge = trees === undefined ? failed(`${a.device} can't merge worktrees`) : yield* trees.finish(w, a.name).pipe(Effect.catch((error) => Effect.succeed(failed(error.message))));
        if (!branchKept(a.merge)) a.worktree = null;
        yield* saveOrSay(a);
        yield* changed;
      }).pipe(Effect.uninterruptible);

    // a message it was sent, in its side log now; a report from its own subagent is delivered then
    const logTell = (a: Agent, t: Tell) => append(a, "user", t.text).pipe(Effect.andThen(t.report === undefined ? Effect.void : delivered(t.report.child, t.report.run)));

    const run = (a: Agent, runId: string): Effect.Effect<void, EngineError | StoreError> =>
      Effect.gen(function* () {
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
                return logTell(a, t);
              }),
            usage: (record) => {
              const own: UsageRecord = { ...record, ref, role: "subagent", subagent: a.name };
              return o.logUsage(own).pipe(Effect.andThen(o.publish({ record: own, type: "usage" })));
            },
          };
          const mid = { next: Queue.take(q).pipe(Effect.map(asMid)), ready: Queue.clear(q).pipe(Effect.map((ts) => ts.map(asMid))) };
          yield* engine.run({ device: a.device, earlier: [], media: [], mid, texts: [opening], view }, out, null);
          // what it was offered and never took is held for one more call
          a.offerTo = null;
          for (const t of a.tells) t.state = "held";
          if (a.tells.length > 0) {
            yield* changed;
            continue;
          }
          // a clean end: an isolated one's branch goes back; a message that came meanwhile is one more call
          if (a.worktree !== null) yield* mergeBack(a, a.worktree);
          if (a.tells.length === 0) return;
          yield* changed;
        }
      }).pipe(Effect.onExit((exit) => ended(a, runId, exit)));

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
        a.stopping = false;
        a.view = view;
        const runId = `${a.name}+${a.runs}`;
        yield* save(a);
        yield* o.publish({ name: a.name, runId, task: a.task, type: "subagent-started" });
        a.fiber = yield* Effect.forkIn(run(a, runId), scope);
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
        const a: Agent = {
          count: 0,
          device,
          effort,
          ended: null,
          engineRef: ref,
          entries: [],
          fiber: null,
          folder: checked.success,
          isolate,
          key: newKey(name),
          lastLine: null,
          merge: null,
          name,
          offerTo: null,
          parent: parent?.name ?? null,
          pending: null,
          ref: ref.ref,
          runs: 0,
          started: now(),
          state: "running",
          stopping: false,
          task,
          tells: [],
          view: null,
          why: null,
          worktree: null,
        };
        agents.set(name.toLowerCase(), a); // at once: a second spawn in the same step finds it, and the cap counts it
        const started = Effect.gen(function* () {
          // an isolated one's worktree before anything is written: a folder that can't be isolated is the tool's error
          if (isolate && trees !== undefined) a.worktree = yield* trees.add(a.folder, name).pipe(Effect.mapError((e) => new StoreError({ message: e.message })));
          yield* Effect.try({ catch: (e) => new StoreError({ message: String(e) }), try: () => mkdirSync(folder(name), { recursive: true }) });
          yield* append(a, "user", task);
          yield* begin(a, from.view === "" ? null : from.view);
        });
        const failed = yield* Effect.result(started);
        if (Result.isFailure(failed)) {
          agents.delete(name.toLowerCase());
          return yield* refused(`spawn: ${failed.failure.message}`);
        }
        const where = a.worktree === null ? `directly in ${a.folder} on ${device}` : `in its own worktree ${a.worktree.path} on ${device}, branch ${a.worktree.branch} from ${a.worktree.repo}`;
        const reader = parent === null || parent === undefined ? "the chat" : "you";
        return {
          error: false,
          text: `Started ${name} on ${entryLabel(ref, o.effort)}, ${where}. It runs in the background; its report will reach ${reader} as a message starting "[${name}] ". Don't wait for it.`,
        };
      });

    // a message for a subagent: offered to the call it runs, else held for the next; one that has
    // ended starts again with it, within the cap
    const send = (name: string, text: string, from: string) =>
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
        const why = cannotStart(a);
        if (why !== null) return Result.fail(`${a.name} has ended (${a.state}) and can't start again now: ${why}`);
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
        const by = caller === "master" ? "OptChat" : caller.agent;
        if (caller !== "master" && told.value.name.trim().toLowerCase() === caller.agent.toLowerCase()) return refused("tell: that is you");
        return send(told.value.name, told.value.text, by).pipe(
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

    // every running one at once, each as its own Stop does it
    const stopAll = Effect.suspend(() => {
      const live = running().filter((a) => a.fiber !== null);
      return Effect.forEach(live, (a) => stop(a.name), { concurrency: "unbounded", discard: true }).pipe(Effect.as(live.map((a) => a.name)));
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
      return { entries, subagent: infoOf(a) };
    };

    const readerHolds = (a: Agent, text: string, since: number) => {
      const parent = a.parent === null ? undefined : find(a.parent);
      return holds(o.mem.root, text, since) || (parent !== undefined && holds(entriesOf(parent), text, since));
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
        const why = cannotStart(a);
        if (why === null) {
          a.tells.push({ seq: ++seq, state: "held", text: RESTARTED });
          const resumed = yield* Effect.result(begin(a, null));
          if (Result.isSuccess(resumed)) continue;
          a.tells = [];
        }
        const last = entriesOf(a).at(-1);
        a.why = `the server restarted while it ran, and it could not go on: ${why ?? "its state could not be saved"}`;
        a.ended = last === undefined ? now() : Date.parse(last.date) || now();
        a.pending = { run: a.runs, text: reportOf(a, a.ended) };
        yield* saveOrSay(a);
      }
      for (const a of agents.values()) {
        const { ended, pending } = a;
        if (pending === null) continue; // a resumed one's too: the report of a run before the one cut short
        if (ended !== null && readerHolds(a, pending.text, ended)) {
          a.pending = null;
          yield* saveOrSay(a);
        } else yield* deliver(a, pending);
      }
      evict();
      yield* changed;
    });

    return { callerOf, changes, list, log, pick, restore, stop, stopAll, tell, tools };
  });
