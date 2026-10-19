// The WebSocket speaks AG-UI events (E15, SPEC "Protocol"). The log stays the truth: a client
// that connects gets a snapshot of its last window, then the live events of every turn, whoever
// started it. Message ids are log indexes.
import type { AGUIEvent, Message } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { DraftOut } from "../src/artifacts/draft.ts";
import type { LiveRun, SessionEvent } from "../src/session.ts";
import type { Entry } from "../src/tree.ts";
import { reasoningId, type SessionState, splitTool, toolCallId, withCut } from "../src/wire.ts";

export type AgUiEvent = AGUIEvent;

// CUSTOM "artifact-draft": one piece of a call's draft, under the run it streams in
const artifactDraft = (runId: string, d: DraftOut): AgUiEvent => ({ name: "artifact-draft", type: EventType.CUSTOM, value: { ...d, runId } });

// The tool call the next echo answers, once `e` is logged: a tool entry opens its call, an echo
// closes it. One rule for the snapshot (toMessages) and for a connection's live events, so a
// client that joins between a tool and its echo pairs them as the snapshot does.
const openCall = (open: string | null, e: Entry): string | null => {
  if (e.kind === "tool") return toolCallId(e.i);
  return e.kind === "echo" ? null : open;
};

// An echo whose tool failed carries `metadata: {error: true}` (E28), on its tool message and on its
// TOOL_CALL_RESULT alike: the event has no `error` field, and the tool message's `error` is a reason,
// which the log doesn't keep apart from the output. Left out when the entry has no flag.
const flagged = (e: Entry) => (e.error === true ? { metadata: { error: true } } : {});

// the log as AG-UI messages: user and note entries are user messages (a note named "note"), talk an
// assistant message, a tool entry an assistant message with one tool call, an echo the tool message
// answering the nearest tool call before it
export function toMessages(entries: readonly Entry[]): Message[] {
  const out: Message[] = [];
  let open: string | null = null;
  for (const e of entries) {
    const id = String(e.i);
    switch (e.kind) {
      case "user":
        out.push({ content: e.text, id, role: "user" });
        break;
      case "note":
        out.push({ content: e.text, id, name: "note", role: "user" });
        break;
      case "talk":
        out.push({ content: e.text, id, role: "assistant" });
        break;
      case "tool": {
        const { args, name } = splitTool(e.text);
        open = openCall(open, e);
        out.push({ id, role: "assistant", toolCalls: [{ function: { arguments: args, name }, id: toolCallId(e.i), type: "function" }] });
        break;
      }
      case "echo":
        out.push({ content: e.text, id, role: "tool", toolCallId: open ?? toolCallId(e.i), ...flagged(e) });
        open = openCall(open, e);
        break;
    }
  }
  return out;
}

export const snapshot = (entries: readonly Entry[], state: SessionState): AgUiEvent[] => [
  { messages: toMessages(entries), type: EventType.MESSAGES_SNAPSHOT },
  { snapshot: state, type: EventType.STATE_SNAPSHOT },
];

// JSON Patch replacing what changed between two states (STATE_DELTA)
const delta = (before: SessionState, after: SessionState) => {
  const old: Readonly<Record<string, SessionState[keyof SessionState]>> = before;
  return Object.entries(after)
    .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(old[k]))
    .map(([k, v]) => ({ op: "replace" as const, path: `/${k}`, value: v }));
};

// a message sent in one piece
const whole = (id: string, role: "assistant" | "user", body: string): AgUiEvent[] => [
  { messageId: id, role, type: EventType.TEXT_MESSAGE_START },
  { delta: body, messageId: id, type: EventType.TEXT_MESSAGE_CONTENT },
  { messageId: id, type: EventType.TEXT_MESSAGE_END },
];

// a reasoning message opens: REASONING_START, then its REASONING_MESSAGE_START
const opening = (id: string): AgUiEvent[] => [{ messageId: id, type: EventType.REASONING_START }, { messageId: id, role: "reasoning", type: EventType.REASONING_MESSAGE_START }];

// a reasoning message closes: REASONING_MESSAGE_END, then REASONING_END with where it went
const closing = (id: string, metadata: Readonly<Record<string, number | boolean>>): AgUiEvent[] => [
  { messageId: id, type: EventType.REASONING_MESSAGE_END },
  { messageId: id, metadata, type: EventType.REASONING_END },
];

// What one connection is told. It starts with a snapshot of the log's last `window` entries and
// the state; if a run is going on, its RUN_STARTED and the reply streamed so far follow, so a client
// that joins mid-reply has all of it. Then `translate` turns each session event into AG-UI events.
// Every run's end is followed by a fresh MESSAGES_SNAPSHOT, so a client always resyncs to the log
// (a reply cut off by a cancel or a crash disappears there, since nothing logged it).
export function openStream(o: {
  readonly thread: string;
  readonly entries: readonly Entry[]; // the log, append-only: a slice of it never changes
  readonly window: number;
  readonly state: SessionState;
  readonly live: LiveRun | null;
}) {
  const upTo = (n: number) => o.entries.slice(Math.max(0, n - o.window), n);
  let { state } = o;
  let from = o.entries.length; // the first log index this connection has not been shown
  let run: string | null = null; // the run whose RUN_STARTED it got
  let text: { id: string; sent: number } | null = null; // the open reply: its id (log index) and how much of it went out
  // the tool call its next echo answers, from where its snapshot ends (openCall)
  let tool: string | null = null;
  for (const e of upTo(from)) tool = openCall(tool, e);

  // the thinking streaming in (SPEC "Reasoning"): its reasoning message id and how much went out
  let thought: { id: string; sent: number } | null = null;

  // A piece of thinking before the entry expected at `at`, starting `offset` characters into it:
  // REASONING_START and REASONING_MESSAGE_START open it, REASONING_MESSAGE_CONTENT carries it; what
  // this connection has already had is not sent again.
  const thinking = (at: number, offset: number, delta: string): AgUiEvent[] => {
    const out: AgUiEvent[] = [];
    const id = reasoningId(at);
    if (thought?.id !== id) {
      out.push(...dropOpen(), ...opening(id));
      thought = { id, sent: offset };
    }
    const fresh = delta.slice(Math.max(0, thought.sent - offset));
    thought.sent = Math.max(thought.sent, offset + delta.length);
    if (fresh !== "") out.push({ delta: fresh, messageId: id, type: EventType.REASONING_MESSAGE_CONTENT });
    return out;
  };
  // The open piece came before nothing logged: it ends `dropped`, which a client drops
  function dropOpen(): AgUiEvent[] {
    if (thought === null) return [];
    const { id } = thought;
    thought = null;
    return closing(id, { dropped: true });
  }
  // The piece streamed at `at` was kept before entry `i` (after `ms`, `cut` characters left out); one
  // this connection never saw open (nothing of it streamed: all of it cut) opens here first
  const kept = (at: number, end: { readonly i: number; readonly ms: number; readonly cut: number }): AgUiEvent[] => {
    const id = reasoningId(at);
    const opened = thought?.id === id;
    if (opened) thought = null;
    return [...(opened ? [] : opening(id)), ...closing(id, withCut({ i: end.i, ms: end.ms }, end.cut))];
  };

  const closeText = (): AgUiEvent[] => {
    if (text === null) return [];
    const { id } = text;
    text = null;
    return [{ messageId: id, type: EventType.TEXT_MESSAGE_END }];
  };

  // a piece of the reply at log index `at`, starting `offset` characters into it; what this
  // connection has already had (a seeded prefix) is not sent again
  const reply = (at: number, offset: number, delta: string): AgUiEvent[] => {
    const out: AgUiEvent[] = [];
    const id = String(at);
    if (text?.id !== id) {
      out.push(...closeText(), { messageId: id, role: "assistant", type: EventType.TEXT_MESSAGE_START });
      text = { id, sent: offset };
    }
    const fresh = delta.slice(Math.max(0, text.sent - offset));
    text.sent = Math.max(text.sent, offset + delta.length);
    if (fresh !== "") out.push({ delta: fresh, messageId: id, type: EventType.TEXT_MESSAGE_CONTENT });
    return out;
  };

  const logged = (entry: Entry): AgUiEvent[] => {
    if (entry.i < from) return []; // in the snapshot already
    from = entry.i + 1;
    const id = String(entry.i);
    switch (entry.kind) {
      case "talk":
        // streamed already under this id: the entry is what was streamed
        if (text?.id === id) return closeText();
        return [...closeText(), ...whole(id, "assistant", entry.text)];
      case "tool": {
        const { args, name } = splitTool(entry.text);
        const call = toolCallId(entry.i);
        tool = openCall(tool, entry);
        return [
          ...closeText(),
          { parentMessageId: id, toolCallId: call, toolCallName: name, type: EventType.TOOL_CALL_START },
          { delta: args, toolCallId: call, type: EventType.TOOL_CALL_ARGS },
          { toolCallId: call, type: EventType.TOOL_CALL_END },
        ];
      }
      case "echo": {
        const call = tool ?? toolCallId(entry.i);
        tool = openCall(tool, entry);
        return [...closeText(), { content: entry.text, messageId: id, role: "tool", toolCallId: call, type: EventType.TOOL_CALL_RESULT, ...flagged(entry) }];
      }
      case "user":
      case "note":
        return [...closeText(), ...whole(id, "user", entry.text)];
    }
  };

  const first: AgUiEvent[] = [...snapshot(upTo(from), state)];
  if (o.live) {
    run = o.live.runId;
    first.push({ runId: run, threadId: o.thread, type: EventType.RUN_STARTED });
    if (o.live.reasoning && o.live.reasoning.at >= from) first.push(...thinking(o.live.reasoning.at, 0, o.live.reasoning.text));
    if (o.live.reply && o.live.reply.at >= from) first.push(...reply(o.live.reply.at, 0, o.live.reply.text));
    // an artifact's draft so far, whole (SPEC "Artifacts")
    for (const d of o.live.drafts ?? [])
      first.push(artifactDraft(o.live.runId, { closed: d.closed, delta: d.html, id: d.id, name: d.name, offset: 0, replace: true, tool: d.tool }));
  }

  const translate = (e: SessionEvent): AgUiEvent[] => {
    switch (e.type) {
      case "logged":
        return logged(e.entry);
      case "text":
        return reply(e.at, e.offset, e.delta);
      // the status line's "thinking…", from its size, whether or not its text comes too
      case "thinking":
        return [{ name: "thinking", type: EventType.CUSTOM, value: { tokens: e.tokens } }];
      case "reasoning":
        return thinking(e.at, e.offset, e.delta);
      case "reasoning-kept":
        return kept(e.at, e);
      case "reasoning-dropped":
        return thought?.id === reasoningId(e.at) ? dropOpen() : [];
      // the next text under that index starts the reply again (TEXT_MESSAGE_START clears a draft)
      case "reply-dropped":
        text = null;
        return [];
      case "run-started":
        if (run === e.runId) return []; // told at connect
        run = e.runId;
        return [{ runId: e.runId, threadId: o.thread, type: EventType.RUN_STARTED }];
      case "run-finished": {
        run = null;
        tool = null;
        const dropped = dropOpen(); // the session drops it first; a connection that missed that closes it here
        const end: AgUiEvent =
          e.error === null ? { runId: e.runId, threadId: o.thread, type: EventType.RUN_FINISHED } : { message: e.error, type: EventType.RUN_ERROR };
        from = Math.max(from, e.logged);
        return [...dropped, ...closeText(), end, { messages: toMessages(upTo(e.logged)), type: EventType.MESSAGES_SNAPSHOT }];
      }
      case "info":
        return [{ name: "info", type: EventType.CUSTOM, value: e.message }];
      // before the user entry it names, so its sender knows the message is its own
      case "ack":
        return [{ name: "ack", type: EventType.CUSTOM, value: { clientId: e.clientId, error: e.error, messageId: e.at === null ? null : String(e.at) } }];
      // every client is told, so a page whose own message another one took back drops it too
      case "taken-back":
        return [{ name: "taken-back", type: EventType.CUSTOM, value: { clientId: e.clientId, error: e.error, media: e.message?.media ?? [], text: e.message?.text ?? null } }];
      case "usage":
        return [{ name: "usage", type: EventType.CUSTOM, value: e.record }];
      // a subagent's run (SPEC M7a), AG-UI's own events; its state is in STATE_DELTA too
      case "subagent-started":
        return [{ description: e.task, name: e.name, subagentRunId: e.runId, type: EventType.SUBAGENT_STARTED }];
      case "subagent-finished":
        return [{ result: e.report, subagentRunId: e.runId, type: EventType.SUBAGENT_FINISHED }];
      case "subagent-error":
        return [{ code: e.code, message: e.message, subagentRunId: e.runId, type: EventType.SUBAGENT_ERROR }];
      // an artifact's live draft, and a version saved (SPEC "Artifacts"); a client from before them
      // drops the frames it can't decode
      case "artifact-draft":
        return [artifactDraft(e.runId, e.draft)];
      case "artifact":
        return [{ name: "artifact", type: EventType.CUSTOM, value: { name: e.name, version: e.version } }];
            case "state": {
        const ops = delta(state, e.state);
        state = e.state;
        return ops.length > 0 ? [{ delta: ops, type: EventType.STATE_DELTA }] : [];
      }
    }
  };

  return { first, translate };
}
