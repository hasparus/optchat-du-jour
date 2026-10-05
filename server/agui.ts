// The WebSocket speaks AG-UI events (E15, SPEC "Protocol"). The log stays the truth: a client
// that connects gets a snapshot of its last window, then the live events of every turn, whoever
// started it. Message ids are log indexes.
import type { BaseEvent, Message } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type { SessionEvent, SessionState } from "../src/session.ts";
import type { Entry } from "../src/tree.ts";

export type AgUiEvent = BaseEvent & Record<string, unknown>;

// a tool entry is "<name> <json input>" (ref §5.3)
export const splitTool = (text: string) => {
  const space = text.indexOf(" ");
  return space < 0 ? { args: "", name: text } : { args: text.slice(space + 1), name: text.slice(0, space) };
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

export const snapshot = (entries: readonly Entry[], state: SessionState, thread: string): AgUiEvent[] => [
  { messages: toMessages(entries), threadId: thread, type: EventType.MESSAGES_SNAPSHOT },
  { snapshot: state, type: EventType.STATE_SNAPSHOT },
];

// JSON Patch replacing what changed between two states (STATE_DELTA)
const delta = (before: SessionState, after: SessionState) =>
  Object.entries(after)
    .filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(Object.entries(before).find(([b]) => b === k)?.[1]))
    .map(([k, v]) => ({ op: "replace", path: `/${k}`, value: v }));

// One translator per connection: it remembers the open text message and tool call of the turn.
export function makeTranslator(thread: string, initial: SessionState, nextIndex: () => number) {
  let state = initial;
  let text: string | null = null; // the live reply's message id: the log index its talk entry will get
  let tool: string | null = null;

  const closeText = (): AgUiEvent[] => {
    if (text === null) return [];
    const id = text;
    text = null;
    return [{ messageId: id, type: EventType.TEXT_MESSAGE_END }];
  };

  const logged = (entry: Entry): AgUiEvent[] => {
    const id = String(entry.i);
    switch (entry.kind) {
      case "talk": {
        if (text !== null) return closeText(); // streamed already; the entry is what was streamed
        return [
          { messageId: id, role: "assistant", type: EventType.TEXT_MESSAGE_START },
          { delta: entry.text, messageId: id, type: EventType.TEXT_MESSAGE_CONTENT },
          { messageId: id, type: EventType.TEXT_MESSAGE_END },
        ];
      }
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
        return [{ content: entry.text, messageId: id, role: "tool", toolCallId: call, type: EventType.TOOL_CALL_RESULT }];
      }
      case "user":
      case "note":
        return [
          ...closeText(),
          { messageId: id, role: "user", type: EventType.TEXT_MESSAGE_START },
          { delta: entry.text, messageId: id, type: EventType.TEXT_MESSAGE_CONTENT },
          { messageId: id, type: EventType.TEXT_MESSAGE_END },
        ];
    }
  };

  return (e: SessionEvent): AgUiEvent[] => {
    switch (e.type) {
      case "logged":
        return logged(e.entry);
      case "text": {
        const start: AgUiEvent[] = [];
        if (text === null) {
          text = String(nextIndex());
          start.push({ messageId: text, role: "assistant", type: EventType.TEXT_MESSAGE_START });
        }
        return [...start, { delta: e.delta, messageId: text, type: EventType.TEXT_MESSAGE_CONTENT }];
      }
      case "thinking":
        return [{ name: "thinking", type: EventType.CUSTOM, value: { tokens: e.tokens } }];
      case "run-started":
        return [{ runId: e.runId, threadId: thread, type: EventType.RUN_STARTED }];
      case "run-finished":
        return [
          ...closeText(),
          e.error === null
            ? { runId: e.runId, threadId: thread, type: EventType.RUN_FINISHED }
            : { message: e.error, runId: e.runId, type: EventType.RUN_ERROR },
        ];
      case "info":
        return [{ name: "info", type: EventType.CUSTOM, value: e.message }];
      case "usage":
        return [{ name: "usage", type: EventType.CUSTOM, value: e.record }];
      case "state": {
        const ops = delta(state, e.state);
        state = e.state;
        return ops.length ? [{ delta: ops, type: EventType.STATE_DELTA }] : [];
      }
    }
  };
}
