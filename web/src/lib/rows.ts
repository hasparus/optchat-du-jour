// The chat as rows (SPEC "Web UI", Chat): `user` and `talk` entries are messages, a `note` a user
// message marked as such, a `tool` entry and the `echo` answering it one tool row. Every row is
// keyed by the log index it starts at, so a row keeps its key (and a tool row its open state) from
// the first streamed event to the snapshot that confirms it.
import { splitTool } from "@wire";
import { Option, Schema } from "effect";
import { type Draft, draftItem, type Item, withDraft } from "./log.ts";

export type Row =
  | { readonly kind: "user" | "note" | "talk"; readonly key: string; readonly id: number; readonly text: string }
  | {
      readonly kind: "tool";
      readonly key: string;
      readonly id: number;
      readonly name: string;
      readonly args: string;
      readonly output: string | null;
      // the echo is flagged: the tool said it failed (E28)
      readonly failed: boolean;
    };

type ToolRow = Extract<Row, { kind: "tool" }>;

// The row each entry made last time, so an entry the log still holds gives the same row object
// when another is logged (ChatRow is memo'd, and what a row cites is read once per object, below).
// Keyed by the entry object and its log index: the log keeps an entry's object until a snapshot or
// a page replaces it (log.ts), and a new object is read again. An echo's row also depends on the
// call it answers: it is kept only while that is the same row (null when it stands alone).
type Made = { readonly i: number; readonly answers: Row | null; readonly row: Row };
const made = new WeakMap<object, Made>();
const kept = (e: Pick<Item, "i">, answers: Row | null): Row | undefined => {
  const known = made.get(e);
  return known?.i === e.i && known.answers === answers ? known.row : undefined;
};
const keep = (e: Pick<Item, "i">, answers: Row | null, row: Row): Row => {
  made.set(e, { answers, i: e.i, row });
  return row;
};

// An echo answers the nearest tool call before it that has no answer yet, as server/agui.ts pairs
// them (a mid-run message can come between); one with none, or across a hole, stands alone.
export function entryRows(entries: readonly Pick<Item, "error" | "i" | "kind" | "text">[]): Row[] {
  const out: Row[] = [];
  let open: number | null = null; // where in `out` the unanswered tool row is
  let prev: number | null = null;
  for (const e of entries) {
    if (prev !== null && e.i !== prev + 1) open = null;
    prev = e.i;
    const key = `e${e.i}`;
    switch (e.kind) {
      case "user":
      case "note":
      case "talk":
        out.push(kept(e, null) ?? keep(e, null, { id: e.i, key, kind: e.kind, text: e.text }));
        break;
      case "tool":
        open = out.length;
        out.push(kept(e, null) ?? keep(e, null, { failed: false, id: e.i, key, kind: "tool", output: null, ...splitTool(e.text) }));
        break;
      case "echo": {
        const tool = open === null ? undefined : out[open];
        const failed = e.error === true;
        if (open !== null && tool?.kind === "tool") out[open] = kept(e, tool) ?? keep(e, tool, { ...tool, failed, output: e.text } satisfies ToolRow);
        else out.push(kept(e, null) ?? keep(e, null, { args: "", failed, id: e.i, key, kind: "tool", name: "output", output: e.text }));
        open = null;
        break;
      }
    }
  }
  return out;
}

// The rows with the draft streaming after them. `base` is entryRows(items), which a streamed token
// doesn't change: the draft is one row more, unless it rewrites an entry already held.
export function chatRows(items: readonly Item[], base: readonly Row[], draft: Draft | null): readonly Row[] {
  if (!draft) return base;
  if (draft.i > (items.at(-1)?.i ?? -1)) return [...base, ...entryRows([draftItem(draft)])];
  return entryRows(withDraft(items, draft));
}

// the index in `rows` of the last row starting at or before log index i; -1 when i is above all
export function rowIndexFor(rows: readonly Row[], i: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((rows[mid]?.id ?? 0) <= i) low = mid + 1;
    else high = mid;
  }
  return low - 1;
}

// the row to scroll to for log index i: the last one starting at or before it
export const rowFor = (rows: readonly Row[], i: number) => rows.findLast((r) => r.id <= i) ?? rows[0];

// ---- how a tool row reads (components/ai-elements/tool.tsx draws it) ----

// running: no echo yet and the turn goes on; done: the echo is in; ended: the turn ended without
// one; error: the echo is flagged failed
export type ToolState = "running" | "done" | "ended" | "error";

export const TOOL_STATE_LABELS = {
  done: "Completed",
  ended: "No output",
  error: "Failed",
  running: "Running",
} satisfies Record<ToolState, string>;

// A tool row's state: `busy` is whether a turn runs or waits, `last` whether this is the newest
// tool row (only the newest can still be running). Failed comes from the echo's flag alone (SPEC
// "Web UI", E28), never from what the output says: an echo logged without one, including every
// echo from before the flag existed, reads as done.
export const toolStateOf = (row: Pick<ToolRow, "failed" | "output">, busy: boolean, last: boolean): ToolState =>
  row.output === null ? (busy && last ? "running" : "ended") : row.failed ? "error" : "done";

// an MCP tool comes as mcp__<server>__<name>; the row names it by <name>
export const toolName = (name: string) => name.split("__").at(-1) ?? name;

const oneLine = (s: string, max = 120) => {
  const flat = s.replaceAll(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

// What a tool was called on, for its one line: the command, the file, the pattern or the address
// when the input names one, a memory node as `id+n`, a todo list by its length, else the input
// itself on one line. The input as logged is under the line, open.
const Text = Schema.optional(Schema.String);
const ToolInputFields = Schema.Struct({
  command: Text,
  description: Text,
  file_path: Text,
  id: Schema.optional(Schema.Number),
  n: Schema.optional(Schema.Number),
  notebook_path: Text,
  path: Text,
  pattern: Text,
  prompt: Text,
  query: Text,
  todos: Schema.optional(Schema.Array(Schema.Unknown)),
  url: Text,
});
const decodeToolInput = Schema.decodeUnknownOption(Schema.fromJsonString(ToolInputFields));

export const toolSummary = (args: string): string =>
  Option.match(decodeToolInput(args), {
    onNone: () => oneLine(args),
    onSome: (input) => {
      if (input.id !== undefined && input.n !== undefined) return `${input.id}+${input.n}`;
      const named = [input.command, input.file_path, input.notebook_path, input.pattern, input.url, input.query, input.path, input.description, input.prompt].find(
        (v) => v !== undefined && v.trim() !== "",
      );
      if (named !== undefined) return oneLine(named);
      if (input.todos !== undefined) return `${input.todos.length} items`;
      return oneLine(args);
    },
  });

// ---- turns, as the log shows them ----

// The log keeps no turn boundaries: a turn starts at a user message, and a message steered into a
// running turn is a user row inside it, as a subagent's report (M7) will be. So a "turn" here runs
// from one user row to the next, and a steered message starts a new one: a plan or the sources
// before it stay with the rows above it. The running turn itself is known exactly, from
// RUN_STARTED (Session.run), and only that decides what is live.
const turnsOf = (rows: readonly Row[]): (readonly Row[])[] => {
  const turns: Row[][] = [[]];
  for (const row of rows) {
    if (row.kind === "user" && (turns.at(-1)?.length ?? 0) > 0) turns.push([]);
    turns.at(-1)?.push(row);
  }
  return turns;
};

// ---- a plan: Claude Code's TodoWrite, read from its input as logged (the Plan pattern) ----

export type PlanStepStatus = "pending" | "in_progress" | "completed";
export type PlanStep = { readonly content: string; readonly status: PlanStepStatus; readonly activeForm: string | null };

const Todos = Schema.Struct({
  todos: Schema.Array(
    Schema.Struct({
      activeForm: Schema.optional(Schema.String),
      content: Schema.String,
      status: Schema.Literals(["pending", "in_progress", "completed"]),
    }),
  ),
});
const decodeTodos = Schema.decodeUnknownOption(Schema.fromJsonString(Todos));

// The steps a TodoWrite call set, or null for any other call, or one whose input isn't the list
// Claude Code writes (the row is then an ordinary tool line, its input as logged).
// read once per row object, like a row's sources (below)
const plans = new WeakMap<object, readonly PlanStep[] | null>();
export const planOf = (row: Pick<ToolRow, "args" | "name">): readonly PlanStep[] | null => {
  if (toolName(row.name) !== "TodoWrite") return null;
  const known = plans.get(row);
  if (known !== undefined) return known;
  const steps = Option.match(decodeTodos(row.args), {
    onNone: () => null,
    onSome: ({ todos }) => (todos.length === 0 ? null : todos.map((t) => ({ activeForm: t.activeForm ?? null, content: t.content, status: t.status }))),
  });
  plans.set(row, steps);
  return steps;
};

// Each turn's plan: its last TodoWrite call, the list as it stands. The calls before it in the
// turn are the same list at earlier points, so they read as plain tool lines (folded into the
// latest) rather than "0 of 3 done" above "3 of 3 done". Keyed by row.
export const turnPlans = (rows: readonly Row[]): ReadonlySet<string> =>
  new Set(turnsOf(rows).flatMap((turn) => turn.findLast((r) => r.kind === "tool" && planOf(r) !== null)?.key ?? []));

// How each turn's plan shows, keyed by row: the chat's newest open ("newest"), the others closed
// ("turn"), and the newest plan of the run that goes on now "live". `run` is the log index that run
// started at (Session.run), or null when none runs. A run can hold more than one turn's plan, since
// a message steered into it starts a turn (turnsOf), but only its newest is live: a plan before the
// steer is an earlier state of the same work, and two lists would shimmer at once.
export type PlanState = "newest" | "live" | "turn";
export function planStates(rows: readonly Row[], run: number | null): ReadonlyMap<string, PlanState> {
  const keys = turnPlans(rows);
  const plans = rows.filter((r) => keys.has(r.key));
  const newest = plans.at(-1);
  const live = run !== null && newest !== undefined && newest.id >= run;
  return new Map(plans.map((r) => [r.key, r === newest ? (live ? "live" : "newest") : "turn"]));
}

// ---- the links a turn used: its WebFetch and WebSearch calls (the Sources pattern) ----

export type WebSource = { readonly url: string; readonly title: string };

// only web addresses: a model-written `javascript:` or `data:` link is never offered. (new URL in
// a try: URL.canParse is newer than the Safari versions the app runs on)
const webUrl = (s: string): URL | null => {
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  return url.protocol === "https:" || url.protocol === "http:" ? url : null;
};

const FetchInput = Schema.fromJsonString(Schema.Struct({ url: Schema.String }));
const decodeFetch = Schema.decodeUnknownOption(FetchInput);
// Claude Code's WebSearch answers with a line `Links: [{"title":…,"url":…},…]` per batch of results
const Links = Schema.fromJsonString(Schema.Array(Schema.Struct({ title: Schema.optional(Schema.String), url: Schema.String })));
const decodeLinks = Schema.decodeUnknownOption(Links);

const NO_SOURCES: readonly WebSource[] = [];
// a row object never changes, and entryRows gives the same one while its entries are the same
// objects, so what it cites is read once per object: neither a streamed token nor a newly logged
// entry parses the chat's searches again (a snapshot brings new entries, which are read once more)
const cited = new WeakMap<object, readonly WebSource[]>();

// what one tool row cites, in order: a WebFetch's address, a WebSearch's result links; the same
// array for the same row object
export const sourcesOfTool = (row: Pick<ToolRow, "args" | "name" | "output">): readonly WebSource[] => {
  const name = toolName(row.name);
  if (name !== "WebFetch" && name !== "WebSearch") return NO_SOURCES;
  const known = cited.get(row);
  if (known) return known;
  const found: { url: string; title?: string | undefined }[] = [];
  if (name === "WebFetch") Option.map(decodeFetch(row.args), (input) => found.push({ url: input.url }));
  if (name === "WebSearch" && row.output !== null) {
    for (const line of row.output.split("\n")) {
      if (line.startsWith("Links: ")) Option.map(decodeLinks(line.slice("Links: ".length)), (links) => found.push(...links));
    }
  }
  const sources = found.flatMap((f) => {
    const url = webUrl(f.url);
    if (!url) return [];
    const title = f.title?.trim();
    return [{ title: title === undefined || title === "" ? url.hostname : title, url: url.href }];
  });
  cited.set(row, sources);
  return sources;
};

// a turn's sources, deduplicated by address (first seen first), kept per the list of its rows'
// arrays: the same tool rows give the same array back, so a reply drawn before (ChatRow is memo'd)
// isn't drawn again on every streamed token or logged entry
const turnLists = new WeakMap<readonly WebSource[], { readonly parts: readonly (readonly WebSource[])[]; readonly list: readonly WebSource[] }>();
const sameParts = (a: readonly (readonly WebSource[])[], b: readonly (readonly WebSource[])[]) => a.length === b.length && a.every((part, k) => part === b[k]);

const turnList = (parts: readonly (readonly WebSource[])[]): readonly WebSource[] => {
  const last = parts.at(-1);
  if (last === undefined) return NO_SOURCES;
  const known = turnLists.get(last);
  if (known && sameParts(known.parts, parts)) return known.list;
  const seen = new Set<string>();
  const list = parts.flat().filter((s) => {
    if (seen.has(s.url)) return false;
    seen.add(s.url);
    return true;
  });
  turnLists.set(last, { list, parts });
  return list;
};

// The sources of each turn (turnsOf), under its last reply, keyed by that row. A turn with no reply
// shows none: its tool lines carry the addresses.
export function turnSources(rows: readonly Row[]): Map<string, readonly WebSource[]> {
  const out = new Map<string, readonly WebSource[]>();
  for (const turn of turnsOf(rows)) {
    const reply = turn.findLast((r) => r.kind === "talk");
    if (reply === undefined) continue;
    const parts = turn.flatMap((r) => (r.kind === "tool" ? [sourcesOfTool(r)] : [])).filter((p) => p.length > 0);
    if (parts.length > 0) out.set(reply.key, turnList(parts));
  }
  return out;
}
