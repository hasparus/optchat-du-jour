// What the session (./session.ts) tells every client: its events, which server/agui.ts turns into
// AG-UI events, and the run going on, for a client that joins mid-run.
import type { DraftNow, DraftOut } from "./artifacts/draft.ts";
import type { Entry } from "./tree.ts";
import type { UsageRecord } from "./usage.ts";
import type { ArtifactVersion, Asset, SessionState } from "./wire.ts";

export type SessionEvent =
  | { readonly type: "logged"; readonly entry: Entry; readonly runId: string | null }
  // `at`: the log index the reply's talk entry will get, taken when the delta is published;
  // `offset`: where the delta starts in that reply's text so far
  | { readonly type: "text"; readonly delta: string; readonly runId: string; readonly at: number; readonly offset: number }
  | { readonly type: "thinking"; readonly tokens: number; readonly runId: string }
  // Thinking as it streams (SPEC "Reasoning"): `at` is the log index of the entry it is expected
  // to come before, taken when the piece began; `offset`, where the delta starts in it
  | { readonly type: "reasoning"; readonly delta: string; readonly runId: string; readonly at: number; readonly offset: number }
  // the piece streamed at `at` is kept before entry `i` (normally `at`), after `ms`; `cut` characters
  // past the caps were left out (never streamed)
  | { readonly type: "reasoning-kept"; readonly runId: string; readonly at: number; readonly i: number; readonly ms: number; readonly cut: number }
  // the piece streamed at `at` came before no reply or tool call (the turn stopped): it is not kept
  | { readonly type: "reasoning-dropped"; readonly runId: string; readonly at: number }
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
  | { readonly type: "state"; readonly state: SessionState }
  // A subagent's run began (spawned, or started again by a tell), ended with its final reply, or
  // ended without one: failed or stopped (`code`). AG-UI's SUBAGENT_* events (SPEC M7a); `runId`
  // is "<name>+<n>", its n-th run
  | { readonly type: "subagent-started"; readonly runId: string; readonly name: string; readonly task: string }
  | { readonly type: "subagent-finished"; readonly runId: string; readonly name: string; readonly report: string }
  | { readonly type: "subagent-error"; readonly runId: string; readonly name: string; readonly message: string; readonly code: "failed" | "stopped" }
  // A file tool's input as it streams (E45, src/wire.ts liveTool): `delta`, the next piece of the
  // JSON of call `call` (Claude Code's id), whose tool entry is expected at log index `at`; `offset`,
  // where the delta starts in that input so far
  | { readonly type: "tool-input"; readonly runId: string; readonly at: number; readonly call: string; readonly name: string; readonly delta: string; readonly offset: number }
  // An artifact's live draft while a publish or an edit streams (SPEC "Artifacts"), and a version
  // saved (told by the tools, src/artifacts/tools.ts)
  | { readonly type: "artifact-draft"; readonly draft: DraftOut }
  | { readonly type: "artifact"; readonly name: string; readonly version: ArtifactVersion };

export type LiveRun = {
  readonly runId: string;
  readonly reply: { readonly at: number; readonly text: string } | null;
  // the thinking streaming in now, before the entry at `at` (SPEC "Reasoning")
  readonly reasoning: { readonly at: number; readonly text: string } | null;
  // the artifacts' drafts streaming in now (SPEC "Artifacts")
  readonly drafts: readonly DraftNow[];
  // the file tool call whose input streams in now, and its input so far; none once its entry is logged (E45)
  readonly tool: LiveInput | null;
};

export type LiveInput = { readonly at: number; readonly call: string; readonly name: string; readonly args: string };
