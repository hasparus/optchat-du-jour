// A subagent's reports (SPEC "Subagents"): what its reader gets when a run ends, and getting it
// there exactly once (E38). The reader is the chat, or the subagent that spawned it, which gets it
// as a message (between its tool calls while it runs; else it starts again with it, within the
// cap). One the parent can't take (gone, stopped by the user, at the cap, no model) goes to the
// chat with a note. A report stays `pending` in agent.json until its reader has it; a restart sends
// it again unless the reader holds it already.
import { Deferred, Effect, Queue, type Scope } from "effect";
import { headOf } from "../text.ts";
import type { Entry } from "../tree.ts";
import { type Merge, reportHead } from "../wire.ts";
import { type Agent, type Pending, REPORT_MAX, type SubagentHost, type Tell, took, userStopped } from "./agent.ts";

// the line a report ends with for an isolated run: how its branch went back
const mergeLine = (m: Merge) => `\n[${m.detail}${m.files > 0 ? `; ${m.files} files changed, +${m.insertions} -${m.deletions}` : ""}]`;

// What its reader gets when a run ends: its final reply, or why there is none, and for an isolated
// run how its branch went back (as its run ends: `ended` is when; `entries` its side log)
export const reportOf = (a: Agent, ended: number, entries: readonly Entry[]) => {
  const head = reportHead(a.name);
  const ran = took(ended - a.started);
  const more = `zoom("${a.name}") reads its log (${a.count} entries)`;
  const keptNote = a.worktree === null ? "" : ` Its worktree ${a.worktree.path} (branch ${a.worktree.branch}) is kept: tell("${a.name}", …) goes on there.`;
  if (a.state === "done") {
    const merged = a.merge === null ? "" : mergeLine(a.merge);
    const reply = entries.findLast((e) => e.kind === "talk")?.text.trim() ?? "";
    if (reply === "") return `${head}finished after ${ran} without a reply; ${more}.${merged}`;
    const cut = headOf(reply, REPORT_MAX);
    return cut === reply ? `${head}${reply}${merged}` : `${head}${cut}\n[… ${reply.length - cut.length} characters cut: ${more}]${merged}`;
  }
  if (a.state === "failed") return `${head}failed after ${ran} (${a.why ?? "no reason given"}) on ${a.ref}; ${more}.${keptNote}`;
  return `${head}stopped after ${ran}: ${a.why ?? "stopped"}. ${more}; tell("${a.name}", …) starts it again.${keptNote}`;
};

// Whether a log holds this report already, since the run ended: a restart between the reader's
// line and agent.json's would otherwise send it twice. The chat's copy may carry a note after it.
export const holds = (log: readonly Entry[], text: string, since: number) => {
  for (let k = log.length - 1; k >= 0; k--) {
    const e = log[k];
    if (e === undefined || Date.parse(e.date) < since) return false;
    if (e.kind === "user" && (e.text === text || e.text.startsWith(`${text}\n[for `))) return true;
  }
  return false;
};

export const makeReports = (o: {
  readonly scope: Scope.Scope;
  readonly host: Deferred.Deferred<SubagentHost>;
  readonly find: (name: string) => Agent | undefined;
  readonly save: (a: Agent) => Effect.Effect<void>;
  readonly entriesOf: (a: Agent) => Entry[];
  readonly chat: () => readonly Entry[];
  // why one that has ended can't start again now (null: it can), and starting it again
  readonly cannotStart: (a: Agent) => string | null;
  readonly begin: (a: Agent, view: string | null) => Effect.Effect<void, { readonly message: string }>;
  readonly nextSeq: () => number;
}) => {
  // the report of this run is with its reader: no longer pending, unless a later run's is by then
  const delivered = (child: string, run: number) =>
    Effect.suspend(() => {
      const a = o.find(child);
      if (a?.pending?.run !== run) return Effect.void;
      a.pending = null;
      return o.save(a);
    });

  // This report, word for word, into the chat once the session logs it (src/session.ts: it wakes an
  // idle master unless it is a run the user stopped, E39), with a note when it was for a subagent
  // that couldn't take it. Forked: the session logs it when no turn runs.
  const toChat = (a: Agent, report: Pending, note = "") =>
    Effect.gen(function* () {
      const host = yield* Deferred.await(o.host);
      yield* host.report(`${report.text}${note}`, { wake: report.wake !== false });
      yield* delivered(a.name, report.run);
    }).pipe(Effect.forkIn(o.scope), Effect.asVoid);

  // A report to whoever started its subagent: the chat, or its parent, as a message. A parent the
  // user stopped (or is stopping, as Stop all does to all at once) is never started again by it.
  const deliver = (a: Agent, report: Pending): Effect.Effect<void> =>
    Effect.suspend(() => {
      const parent = a.parent === null ? undefined : o.find(a.parent);
      if (parent === undefined) return toChat(a, report, a.parent === null ? "" : `\n[for ${a.parent}, which is gone]`);
      if (userStopped(parent)) return toChat(a, report, `\n[for ${parent.name}, which the user stopped]`);
      const t: Tell = { report: { child: a.name, run: report.run }, seq: o.nextSeq(), state: "held", text: report.text };
      if (parent.state === "running") {
        parent.tells.push(t);
        if (parent.offerTo) {
          t.state = "offered";
          Queue.offerUnsafe(parent.offerTo, t);
        }
        return Effect.void;
      }
      const why = o.cannotStart(parent);
      if (why !== null) return toChat(a, report, `\n[for ${parent.name}, which could not take it: ${why}]`);
      parent.tells.push(t);
      return Effect.flatMap(Deferred.await(o.host), (host) => o.begin(parent, host.turnNow()?.view ?? null)).pipe(
        Effect.catch((error) =>
          Effect.suspend(() => {
            parent.tells = parent.tells.filter((x) => x !== t);
            return toChat(a, report, `\n[for ${parent.name}, which could not take it: ${error.message}]`);
          }),
        ),
      );
    });

  // the reports a parent held from its subagents when it ended without taking them: to the chat
  const orphaned = (parent: Agent, held: readonly { readonly child: string; readonly run: number }[]) =>
    Effect.forEach(
      held,
      (r) => {
        const child = o.find(r.child);
        return child?.pending?.run === r.run ? toChat(child, child.pending, `\n[for ${parent.name}, which ended (${parent.state}) before it took this]`) : Effect.void;
      },
      { discard: true },
    );

  // whether its reader (the chat, or its parent's side log) holds this report since `since`
  const readerHolds = (a: Agent, text: string, since: number) => {
    const parent = a.parent === null ? undefined : o.find(a.parent);
    return holds(o.chat(), text, since) || (parent !== undefined && holds(o.entriesOf(parent), text, since));
  };

  return { deliver, delivered, orphaned, readerHolds };
};
