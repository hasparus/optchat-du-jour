// A scripted optchat-server for UI tests (SPEC "Web UI": fixtures replay conversations as AG-UI
// events, no model, no network). Each socket the app opens gets the server's greeting (a
// MESSAGES_SNAPSHOT and a STATE_SNAPSHOT), then whatever the test plays; what the app sends is
// recorded. @shadcn/helpers/tanstack-ai can't stand in here: it answers a client's own request,
// while our server pushes snapshots and turns other clients started.
import { EventType } from "@ag-ui/core";
import { Schema } from "effect";
import type { SocketLike } from "@/lib/connection";
import type { Inbound } from "@/lib/protocol";
import type { SessionState } from "@wire";

type Listener = (event: { readonly data: string }) => void;

export const IDLE: SessionState = {
  budget: 128_000,
  device: "mini",
  down: [],
  effort: "high",
  engine: null,
  engines: [
    { down: null, label: "Claude Opus (Claude Code)", ref: "claude-code:opus" },
    { down: null, label: "GPT-6.1 Sol (ChatGPT plan)", ref: "openai-plan:gpt-6.1-sol" },
  ],
  followUp: "steer",
  messages: 0,
  phase: "idle",
  pending: [],
  stopped: null,
  viewBytes: 0,
  waiting: 0,
};

export type Entry = { readonly kind: "user" | "talk" | "tool" | "echo" | "note"; readonly text: string };

// the log as server/agui.ts toMessages writes it; `from` is the first entry's index
export function snapshot(entries: readonly Entry[], from = 0): Inbound {
  let open = "";
  return {
    messages: entries.map((e, k) => {
      const i = from + k;
      const id = String(i);
      switch (e.kind) {
        case "user":
          return { content: e.text, id, role: "user" as const };
        case "note":
          return { content: e.text, id, name: "note", role: "user" as const };
        case "talk":
          return { content: e.text, id, role: "assistant" as const };
        case "tool": {
          const space = e.text.indexOf(" ");
          open = `t${i}`;
          return {
            id,
            role: "assistant" as const,
            toolCalls: [{ function: { arguments: e.text.slice(space + 1), name: e.text.slice(0, space) }, id: open, type: "function" as const }],
          };
        }
        case "echo":
          return { content: e.text, id, role: "tool" as const, toolCallId: open };
      }
    }),
    type: EventType.MESSAGES_SNAPSHOT,
  };
}

export const said = (id: number, role: "user" | "assistant", text: string): Inbound[] => [
  { messageId: String(id), role, type: EventType.TEXT_MESSAGE_START },
  { delta: text, messageId: String(id), type: EventType.TEXT_MESSAGE_CONTENT },
  { messageId: String(id), type: EventType.TEXT_MESSAGE_END },
];
export const state = (s: Partial<SessionState>): Inbound => ({
  delta: Object.entries(s).map(([k, v]) => ({ op: "replace" as const, path: `/${k}`, value: v })),
  type: EventType.STATE_DELTA,
});

// a frame the app sent: a RunAgentInput, or the abort
const Sent = Schema.Struct({
  type: Schema.optional(Schema.String),
  // content: the text, or with attachments AG-UI's parts (lib/protocol.ts runInput)
  messages: Schema.optional(Schema.Array(Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(Schema.Json)]), id: Schema.String, role: Schema.String }))),
  forwardedProps: Schema.optional(Schema.Struct({ device: Schema.optional(Schema.String), engine: Schema.optional(Schema.String), followUp: Schema.optional(Schema.String) })),
  // a take-back, a settings or a resume frame
  clientId: Schema.optional(Schema.String),
  followUp: Schema.optional(Schema.String),
  engine: Schema.optional(Schema.String),
});
// the server's word on a message: logged at `at`, or (with an error) not
export const ack = (clientId: string, at: number | null, error: string | null = null): Inbound => ({
  name: "ack",
  type: EventType.CUSTOM,
  value: { clientId, error, messageId: at === null ? null : String(at) },
});
export const parseSent = Schema.decodeUnknownSync(Schema.fromJsonString(Sent));

export function fakeServer(greeting: () => readonly Inbound[]) {
  const sockets: FakeSocket[] = [];
  const sent: string[] = [];

  class FakeSocket implements SocketLike {
    readyState = 0;
    private readonly listeners = new Map<string, Listener[]>();
    constructor(readonly url: string) {
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.fire("open", { data: "" });
        for (const e of greeting()) this.fire("message", { data: JSON.stringify(e) });
      });
    }
    addEventListener(type: string, listener: Listener) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    send(frame: string) {
      sent.push(frame);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.fire("close", { data: "" });
    }
    fire(type: string, event: { readonly data: string }) {
      for (const l of this.listeners.get(type) ?? []) l(event);
    }
  }

  return {
    socket: (url: string) => new FakeSocket(url),
    sent,
    sockets,
    // frames from the server to every open socket
    play: (...events: readonly Inbound[]) => {
      for (const s of sockets) if (s.readyState === 1) for (const e of events) s.fire("message", { data: JSON.stringify(e) });
    },
    // the connection drops
    drop: () => {
      for (const s of sockets) s.close();
    },
  };
}
