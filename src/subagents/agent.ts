// One subagent as the supervisor (../subagents.ts) holds it (SPEC "Subagents"): the record in
// memory, its agent.json, its card's info, the side log as its file holds it, and what each call's
// opening says. `agentOf` is the one place a record is made, from agent.json or from a spawn.
import { type Effect, type Fiber, type Queue, Schema } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { type Effort, entryLabel, isEffort, type Ref } from "../config.ts";
import type { EngineError } from "../engines/errors.ts";
import { Msg } from "../records.ts";
import type { StoreError } from "../store.ts";
import { headOf } from "../text.ts";
import type { Entry } from "../tree.ts";
import { Isolation, Merge, type SubagentInfo, SubagentState } from "../wire.ts";

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

// why a run the user stopped ended (a card's Stop, or Stop all): a decision, not a report to act on
export const USER_STOP = "stopped by the user";

// what the session gives the supervisor, once it exists (it needs the supervisor's list first)
export type SubagentHost = {
  // a report into the chat; `wake: false` (a run the user stopped) never wakes the master (E39)
  readonly report: (text: string, o?: { readonly wake?: boolean }) => Effect.Effect<void>;
  // the turn running now: its engine, the view it was sent, and its device
  readonly turnNow: () => { readonly ref: string; readonly view: string; readonly on: string } | null;
  readonly lastView: () => string | null;
};

// where one call of a subagent runs (E36): its device, its folder (the worktree of an isolated
// one), its own /mcp key, which names it to the server, and its name
export type AgentPlace = { readonly device: string; readonly cwd: string; readonly key: string; readonly name: string };

// A report not delivered yet, and the run it ends (its `runs` then): two runs' reports with the
// same words stay two reports. `wake: false`: the user stopped that run, so it wakes no one.
const Pending = Schema.Struct({ run: Schema.Number, text: Schema.String, wake: Schema.optional(Schema.Boolean) });
export type Pending = typeof Pending.Type;

export const Meta = Schema.Struct({
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
  pending: Schema.optional(Schema.NullOr(Pending)),
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
  // restarts in a row that resumed it with no call of its completing since (E40)
  resumes: Schema.optional(Schema.Number),
});
export type Meta = typeof Meta.Type;
export const decodeMeta = Schema.decodeUnknownOption(Schema.fromJsonString(Meta));
const decodeEntry = Schema.decodeUnknownOption(Schema.fromJsonString(Msg));

// A message sent to a subagent: held for its next call, or offered to the running one. A report
// from a subagent it spawned names that child and its run (`report`): once in its side log, the
// child's report is delivered.
// `client`: the id of the card's tell it is (E41), written on its side-log line, so the same tell
// sent again, after a restart too, is answered and not told twice
export type Tell = { readonly seq: number; readonly text: string; state: "held" | "offered"; readonly report?: { readonly child: string; readonly run: number }; readonly client?: string };

export type Agent = {
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
  watcher: Fiber.Fiber<void> | null; // what hands its run's end on (`launch`): a stop waits for it
  stopping: boolean; // the user stopped it: an interrupt is that, not the server going down
  view: string | null;
  readonly device: string; // where its calls run
  readonly folder: string; // where it works, the device's own path; an isolated one's worktree is made from it
  readonly isolate: boolean;
  worktree: Isolation | null; // an isolated one's worktree, while it has one
  merge: Merge | null; // how its last run's branch went back
  readonly parent: string | null; // the subagent that spawned it; null: OptChat
  readonly key: string; // its /mcp key, made at each start of the server
  resumes: number; // restarts in a row that resumed it with no call completing since (E40)
};

// the user stopped it, or is stopping it: neither a report nor a tell from a child starts it again
export const userStopped = (a: Pick<Agent, "stopping" | "state" | "why">) => a.stopping || (a.state === "stopped" && a.why === USER_STOP);

// The record of a subagent, from what agent.json says (a spawn's is a fresh one): `model` is its
// ref as the chain reads it now (null: no longer in the chain), `entries` its side log when it
// was read, `defaults` what a file from before M7b lacks, `key` the /mcp key it gets now.
export const agentOf = (
  m: Meta,
  o: {
    readonly model: { readonly ref: Ref; readonly effort: Effort | undefined } | null;
    readonly entries: Entry[] | null;
    readonly device: string;
    readonly folder: string;
    readonly key: string;
  },
): Agent => {
  const last = o.entries?.at(-1);
  return {
    count: o.entries?.length ?? m.entries ?? 0,
    device: m.device ?? o.device,
    effort: o.model === null ? (m.effort !== null && isEffort(m.effort) ? m.effort : undefined) : o.model.effort,
    ended: m.ended === null ? null : Date.parse(m.ended),
    engineRef: o.model?.ref ?? null,
    entries: o.entries,
    fiber: null,
    folder: m.folder ?? o.folder,
    isolate: m.isolate ?? false,
    key: o.key,
    lastLine: o.entries === null ? (m.lastLine ?? null) : last === undefined ? null : lineOf(last),
    merge: m.merge ?? null,
    name: m.name,
    offerTo: null,
    parent: m.parent ?? null,
    pending: m.pending ?? null,
    ref: m.ref,
    resumes: m.resumes ?? 0,
    runs: m.runs,
    started: Date.parse(m.started),
    state: m.state,
    stopping: false,
    task: m.task,
    tells: [],
    view: null,
    watcher: null,
    why: m.why,
    worktree: m.worktree ?? null,
  };
};

const iso = (ms: number) => new Date(ms).toISOString();

// what agent.json keeps of it
export const metaOf = (a: Agent): Meta => ({
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
  resumes: a.resumes,
  runs: a.runs,
  started: iso(a.started),
  state: a.state,
  task: a.task,
  why: a.why,
  worktree: a.worktree,
});

// the optional fields of a subagent's info, filled one by one
type InfoExtras = { -readonly [K in "lastLine" | "why" | "isolated" | "worktree" | "merge" | "parent"]?: NonNullable<SubagentInfo[K]> };

// what its card shows, as of `now` (the master's effort labels the model)
export const infoOf = (a: Agent, now: number, masterEffort: Effort): SubagentInfo => {
  const base: SubagentInfo = {
    device: a.device,
    effort: a.effort ?? null,
    elapsed: Math.max(0, (a.ended ?? now) - a.started),
    entries: a.count,
    folder: a.folder,
    label: a.engineRef ? entryLabel(a.engineRef, masterEffort) : a.ref,
    name: a.name,
    ref: a.ref,
    started: iso(a.started),
    state: a.state,
    task: a.task,
  };
  const more: InfoExtras = {};
  if (a.lastLine !== null) more.lastLine = a.lastLine;
  if (a.why !== null) more.why = a.why;
  if (a.isolate) more.isolated = true;
  if (a.worktree !== null) more.worktree = a.worktree;
  if (a.merge !== null) more.merge = a.merge;
  if (a.parent !== null) more.parent = a.parent;
  return { ...base, ...more };
};

export const flat = (text: string) => text.replaceAll(/\s+/g, " ").trim();

// "12 s", "2 min 05 s": how long a run took, for its report
export const took = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
};

// where it works, for its card and its opening: its worktree while it has one, else its folder
export const cwdOf = (a: Pick<Agent, "folder" | "worktree">) => a.worktree?.path ?? a.folder;
// who started it, as its opening and its report name them
export const starter = (a: Pick<Agent, "parent">) => (a.parent === null ? "OptChat" : `the subagent "${a.parent}"`);

// What the first message of each call says after the view (one system prompt for every call,
// docs/optchat.md §5, so who it is and where it works go here). `others`: the subagents working
// directly in the same folder now (E36's soft guard): told so, it can keep out of their way.
export const intro = (a: Agent, others: readonly Agent[]) => {
  const shared =
    others.length === 0
      ? ""
      : ` ${others.map((x) => `${x.name} (${headOf(flat(x.task), TASK_SHOWN)})`).join(", ")} ${others.length === 1 ? "works" : "work"} there now too: keep to the files your task needs, read a file again just before you edit it, and never undo a change you didn't make.`;
  const into = a.worktree?.from ?? null;
  const where =
    a.worktree === null
      ? `You work directly in ${a.folder} on ${a.device}, where OptChat and the user may change files too.${shared}`
      : `You work in a git worktree of your own, ${a.worktree.path} on ${a.device}, on branch ${a.worktree.branch}, made from ${a.worktree.repo} at ${a.worktree.base.slice(0, 12)}. Commit your work there. When you end, your branch is merged back into ${into ?? "the branch the folder was on"} if it merges cleanly (what you left uncommitted is committed first); a conflict is kept for later and said in your report. Files git ignores keep the worktree from being removed.`;
  return `[optchat: You are the subagent "${a.name}", started by ${starter(a)} for the task below. The view above is OptChat's memory, context only: do what your task says, not what the user's last message says. ${where} You have OptChat's tools: files, commands and the web, zoom and date, and spawn and tell for subagents of your own, whose reports come to you. Messages from OptChat or the user may reach you while you work. Your final reply is your report to ${starter(a)}: what you did and changed, and what will matter later, in a few lines.]`;
};

// the line the state shows of a side log entry
export const lineOf = (e: Pick<Entry, "kind" | "text">) => headOf(flat(`${e.kind}: ${e.text}`), LAST_LINE);

// a side log as its file holds it: the lines that read, in order
export const readLog = (path: string): Entry[] =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line) => {
          const e = line.trim() === "" ? undefined : decodeEntry(line);
          return e?._tag === "Some" ? [{ ...e.value, size: e.value.size ?? 0 }] : [];
        })
    : [];

export const shownEntry = (e: Pick<Entry, "i" | "kind" | "text">) => `${e.i}|${e.kind}: ${e.text}`;

// a later call's own history: its newest entries within SIDE_CONTEXT, after the task (entry 0)
export const history = (name: string, entries: readonly Entry[]) => {
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
