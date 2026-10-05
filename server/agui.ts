// The WebSocket speaks AG-UI events (E15, SPEC "Protocol"). The log stays the truth: a client
// that connects gets a snapshot of its last window, then the live events of every turn, whoever
// started it. Message ids are log indexes.
import type { AGUIEvent, Message } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { LiveRun, SessionEvent, SessionState } from "../src/session.ts";
import type { Entry } from "../src/tree.ts";

export type AgUiEvent = AGUIEvent;

// a tool entry is "<name> <json input>" (ref §5.3)
export const splitTool = (text: string) => {
  const space = text.indexOf(" ");
  return space === -1 ? { args: "", name: text } : { args: text.slice(space + 1), name: text.slice(0, space) };
};
const toolCallId = (i: number) => `t${i}`;

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
        open = toolCallId(e.i);
        out.push({ id, role: "assistant", toolCalls: [{ function: { arguments: args, name }, id: open, type: "function" }] });
        break;
      }
      case "echo":
        out.push({ content: e.text, id, role: "tool", toolCallId: open ?? toolCallId(e.i) });
        open = null;
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
  let tool: string | null = null;

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
        tool = toolCallId(entry.i);
        return [
          ...closeText(),
          { parentMessageId: id, toolCallId: tool, toolCallName: name, type: EventType.TOOL_CALL_START },
          { delta: args, toolCallId: tool, type: EventType.TOOL_CALL_ARGS },
          { toolCallId: tool, type: EventType.TOOL_CALL_END },
        ];
      }
      case "echo": {
        const call = tool ?? toolCallId(entry.i);
        tool = null;
        return [...closeText(), { content: entry.text, messageId: id, role: "tool", toolCallId: call, type: EventType.TOOL_CALL_RESULT }];
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
    if (o.live.reply && o.live.reply.at >= from) first.push(...reply(o.live.reply.at, 0, o.live.reply.text));
  }

  const translate = (e: SessionEvent): AgUiEvent[] => {
    switch (e.type) {
      case "logged":
        return logged(e.entry);
      case "text":
        return reply(e.at, e.offset, e.delta);
      case "thinking":
        return [{ name: "thinking", type: EventType.CUSTOM, value: { tokens: e.tokens } }];
      case "run-started":
        if (run === e.runId) return []; // told at connect
        run = e.runId;
        return [{ runId: e.runId, threadId: o.thread, type: EventType.RUN_STARTED }];
      case "run-finished": {
        run = null;
        tool = null;
        const end: AgUiEvent =
          e.error === null ? { runId: e.runId, threadId: o.thread, type: EventType.RUN_FINISHED } : { message: e.error, type: EventType.RUN_ERROR };
        from = Math.max(from, e.logged);
        return [...closeText(), end, { messages: toMessages(upTo(e.logged)), type: EventType.MESSAGES_SNAPSHOT }];
      }
      case "info":
        return [{ name: "info", type: EventType.CUSTOM, value: e.message }];
      case "usage":
        return [{ name: "usage", type: EventType.CUSTOM, value: e.record }];
      case "state": {
        const ops = delta(state, e.state);
        state = e.state;
        return ops.length > 0 ? [{ delta: ops, type: EventType.STATE_DELTA }] : [];
      }
    }
  };

  return { first, translate };
}
