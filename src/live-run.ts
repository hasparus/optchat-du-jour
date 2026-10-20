// The run going on in the session (src/session.ts), and what it streams that the log doesn't hold
// yet, for a client joining mid-run (`live`): the reply's text, its thinking, the artifacts'
// drafts, the file tool call whose input streams (E45), and its retry pause (E43). `begin` and
// `end` are the one start and the one end of a run; the session decides when each comes.
import { Effect, type Scope } from "effect";
import { makeDrafts } from "./artifacts/draft.ts";
import type { RetryPause } from "./engines/retry.ts";
import type { ToolInputHooks } from "./engines/tool-input.ts";
import { makePieces, noReasoning, type Pieces, type Reasoning } from "./reasoning.ts";
import type { LiveInput, LiveRun, SessionEvent } from "./session-events.ts";
import type { Entry } from "./tree.ts";
import { liveTool } from "./wire.ts";

export const makeLiveRun = (o: {
  readonly publish: (e: SessionEvent) => Effect.Effect<void>;
  readonly length: () => number; // the log's length: the index its next entry gets
  readonly now: () => number; // the session's clock
  readonly engine: () => string; // the engine running now ("" between calls)
  readonly scope: Scope.Scope;
  readonly reasoning?: Reasoning; // the side file thinking is kept in (src/reasoning.ts); none: only streamed
  // an artifact's latest HTML, for an edit's live draft (SPEC "Artifacts"); none: edits show none
  readonly artifactBase?: (name: string) => Effect.Effect<string | null>;
}) => {
  const { publish } = o;
  // the run whose RUN_STARTED went out, the text it is streaming at log index `at`, and its
  // thinking (src/reasoning.ts makePieces: a run's own, so its budget starts with it)
  // and the artifacts' drafts it is streaming (src/artifacts/draft.ts)
  // and the file tool call whose input is streaming (E45)
  let current: { runId: string; reply: { at: number; text: string } | null; pieces: Pieces; drafts: ReturnType<typeof makeDrafts>; tool: LiveInput | null } | null = null;
  const live = (): LiveRun | null =>
    current && {
      drafts: current.drafts.now(),
      reasoning: current.pieces.live(),
      reply: current.reply && { ...current.reply },
      runId: current.runId,
      tool: current.tool && { ...current.tool },
    };
  const sideFile = o.reasoning ?? noReasoning;
  // the running turn's retry pause (E43): until `until` (this clock), before try `next` of `tries`
  let retryPause: { readonly until: number; readonly next: number; readonly tries: number } | null = null;

  // an entry went into the log: the streamed text is logged now, or was left behind, and a call's
  // input that streamed is the entry now (E45)
  const logged = (kind: Entry["kind"]) => {
    if (!current) return;
    current.reply = null;
    if (kind === "tool") current.tool = null;
  };

  // live reply text: buffered for clients that join mid-reply, each delta with its place in it
  const stream = (delta: string, runId: string) =>
    Effect.suspend(() => {
      const at = o.length();
      if (current && current.reply?.at !== at) current.reply = { at, text: "" };
      const offset = current?.reply?.text.length ?? 0;
      if (current?.reply) current.reply.text += delta;
      return publish({ at, delta, offset, runId, type: "text" });
    });
  // the reply streaming in is dropped unlogged (a usage limit stopped it): the next one streams anew
  const dropReply = (runId: string) =>
    Effect.suspend(() => (current?.reply ? publish({ runId, type: "reply-dropped" }) : Effect.void)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          if (current) current.reply = null;
        }),
      ),
    );

  // A file tool's input as it streams (E45): buffered for clients that join mid-call, each delta
  // with its place in it; the call's tool entry is expected next in the log. Should an entry be
  // logged meanwhile (the reply before the call), the input so far goes out again under the new index.
  const liveInput = (call: { readonly id: string; readonly name: string }, delta: string) =>
    Effect.suspend(() => {
      if (!current) return Effect.void;
      const at = o.length();
      const was = current.tool?.call === call.id ? current.tool : { args: "", at, call: call.id, name: call.name };
      const moved = was.at !== at;
      current.tool = { ...was, args: was.args + delta, at };
      const out = moved ? { delta: current.tool.args, offset: 0 } : { delta, offset: was.args.length };
      return publish({ ...out, at, call: call.id, name: call.name, runId: current.runId, type: "tool-input" });
    });
  // a tool call's input as it streams: an artifact call's is its live draft (SPEC "Artifacts"); a
  // file tool's, clients draw as it comes (E45)
  const toolInput: ToolInputHooks = {
    delta: (call, piece) => (liveTool(call.name) ? liveInput(call, piece) : Effect.suspend(() => current?.drafts.delta(call, piece) ?? Effect.void)),
    end: (id) => Effect.suspend(() => current?.drafts.end(id) ?? Effect.void),
  };

  // Thinking as it streams (SPEC "Reasoning"): the run's pieces (src/reasoning.ts) say what of it
  // goes out, under the caps; once the reply or tool call it came before is logged, its piece is
  // kept in the side file under that index, then clients are told. A write that fails is the side
  // file's to report; the turn goes on. A piece the run logged nothing after is dropped.
  const think = (delta: string, fresh: boolean, runId: string) =>
    Effect.suspend(() => {
      const out = current?.pieces.add({ at: o.length(), delta, engine: o.engine(), fresh, now: o.now() });
      return out ? publish({ at: out.at, delta: out.taken, offset: out.offset, runId, type: "reasoning" }) : Effect.void;
    });
  const keepThought = (entry: Entry, runId: string) =>
    Effect.suspend(() => {
      const taken = entry.kind === "talk" || entry.kind === "tool" ? current?.pieces.take(entry.i, o.now()) : null;
      if (!taken) return Effect.void;
      const { at, record } = taken;
      return sideFile.keep(record).pipe(Effect.andThen(publish({ at, cut: record.cut ?? 0, i: record.i, ms: record.ms, runId, type: "reasoning-kept" })));
    });
  const dropThought = (runId: string) =>
    Effect.suspend(() => {
      const at = current?.pieces.drop() ?? null;
      return at === null ? Effect.void : publish({ at, runId, type: "reasoning-dropped" });
    });

  // our HTTP engines' retry pause: the state says so while it lasts (E43)
  const pause = (p: RetryPause | null) =>
    Effect.sync(() => {
      retryPause = p && { next: p.next, tries: p.tries, until: o.now() + p.ms };
    });
  // the pause as the state shows it, as of `now`: what is left of it
  const pauseNow = (now: number) => retryPause && { ms: Math.max(0, retryPause.until - now), next: retryPause.next, tries: retryPause.tries };

  // the one start of a run: `current` and RUN_STARTED together, so no end goes out without its start
  const begin = (runId: string) =>
    Effect.suspend(() => {
      const drafts = makeDrafts({
        base: (name) => o.artifactBase?.(name) ?? Effect.succeed(null),
        runId,
        scope: o.scope,
        send: (draft) => publish({ draft, type: "artifact-draft" }),
      });
      current = { drafts, pieces: makePieces(), reply: null, runId, tool: null };
      return publish({ runId, type: "run-started" });
    }).pipe(Effect.uninterruptible);

  // The one end of a run: published before the session logs anything outside it (what a failed
  // or cancelled turn leaves unanswered), so a reply left open (a cancel, a crash) is closed
  // before its log index goes to another entry. The run's own last entries come before it, also
  // on a cancel: our tool loop answers a call cut short with `not run: cancelled` as that call
  // unwinds (src/turn/loop.ts), under the run's id, before the loop gets here.
  const end = (error: string | null) =>
    Effect.suspend(() => {
      if (!current) return Effect.void;
      const { drafts, runId } = current;
      return dropThought(runId).pipe(
        Effect.andThen(drafts.stop),
        Effect.andThen(
          Effect.suspend(() => {
            current = null;
            retryPause = null;
            return publish({ error, logged: o.length(), runId, type: "run-finished" });
          }),
        ),
      );
    });

  const inRun = () => current !== null;

  return { begin, dropReply, dropThought, end, inRun, keepThought, live, logged, pause, pauseNow, stream, think, toolInput };
};
