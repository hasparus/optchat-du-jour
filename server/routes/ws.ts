// GET /ws (SPEC "Protocol", E15): one WebSocket per client, AG-UI events out; RunAgentInput frames,
// aborts, take-backs, settings and resumes in, each done once by its id (E41). Every client watches
// the same server-owned session.
import { type Duration, Effect, Option, Predicate, PubSub, Schema } from "effect";
import { EventType } from "@ag-ui/core";
import { type HttpRouter, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import { makeSeen } from "../../src/once.ts";
import type { InputOptions, Session } from "../../src/session.ts";
import type { Subagents } from "../../src/subagents.ts";
import type { Entry } from "../../src/tree.ts";
import { ACTS, HEARTBEAT } from "../../src/config.ts";
import { FollowUp, type Received, WIRE, WIRE_STALE } from "../../src/wire.ts";
import { type AgUiEvent, openStream } from "../agui.ts";
import { type Assets, takeMessage } from "../messages.ts";

// What a client sends: AG-UI's RunAgentInput (its user messages are the ones to answer), an abort,
// a take-back of a held message by the id its sender gave it, a change to the session's settings,
// the resume of a turn waiting for a model on an engine of the master's chain, or a subagent card's
// tell, stop or model (SPEC M7a), or the sheet's Stop all (the turn and every subagent). A user
// message's content is its text, or AG-UI's parts: text, and image or video parts whose source is a
// URL "asset:<sha256>", an upload PUT /api/assets stored (SPEC "Media"). The server finds each in
// its own store; a client never names a path. `forwardedProps.followUp` asks for the other
// follow-up behavior for this one message; `forwardedProps.engine` names the engine of the master's
// chain it is for (the chain's first if none).
// Every action carries an id of its client's (E41): a message its own, any other `id`; each is
// done once and answered to its sender with a `received`, however often it comes. An abort, a Stop
// all and a resume name the run of the turn loop they were for (`loop`, the state's). A frame
// without an id (a client from before E41, the REPL's) is done as it comes, unanswered.
const Source = Schema.Struct({ type: Schema.String, value: Schema.String });
const ContentPart = Schema.Struct({ text: Schema.optional(Schema.String), type: Schema.String, source: Schema.optional(Source) });
const InboundMessage = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentPart)])),
  id: Schema.String,
  role: Schema.String,
});
type InboundMessage = typeof InboundMessage.Type;
const Id = Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)));
const Loop = Schema.optional(Schema.Number);
const Inbound = Schema.Union([
  Schema.Struct({ type: Schema.Literal("abort"), id: Id, loop: Loop }),
  Schema.Struct({ type: Schema.Literal("take-back"), clientId: Schema.String, id: Id }),
  // `lead`: an out-of-date client's model pick (the server no longer has one): it is told to reload
  Schema.Struct({ type: Schema.Literal("settings"), followUp: Schema.optional(FollowUp), lead: Schema.optional(Schema.Unknown), id: Id }),
  Schema.Struct({ type: Schema.Literal("resume"), engine: Schema.String, id: Id, loop: Loop }),
  // a subagent's card (SPEC M7a): a message to it, its stop, the model of its next call
  Schema.Struct({ type: Schema.Literal("tell"), name: Schema.String, text: Schema.String, id: Id }),
  Schema.Struct({ type: Schema.Literal("stop-subagent"), name: Schema.String, id: Id }),
  Schema.Struct({ type: Schema.Literal("subagent-model"), name: Schema.String, model: Schema.String, id: Id }),
  // Background work's Stop all: the turn, as an abort, and every running subagent, as their Stops
  Schema.Struct({ type: Schema.Literal("stop-all"), id: Id, loop: Loop }),
  Schema.Struct({
    forwardedProps: Schema.optional(Schema.Struct({ device: Schema.optional(Schema.String), followUp: Schema.optional(FollowUp), engine: Schema.optional(Schema.String) })),
    messages: Schema.Array(InboundMessage),
  }),
]);
type Inbound = typeof Inbound.Type;
const decodeInbound = Schema.decodeUnknownOption(Schema.fromJsonString(Inbound));
// the id of a frame that doesn't decode (a newer client's action, a malformed one), if it has one
const decodeId = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ id: Schema.String })));

const textOf = ({ content = "" }: InboundMessage) => (Predicate.isString(content) ? content : content.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join(""));

// the digests a message's image and video parts name, in order
const ASSET = /^asset:([0-9a-f]{64})$/;
const attachmentsOf = ({ content = "" }: InboundMessage) =>
  Predicate.isString(content)
    ? []
    : content.flatMap((p) => {
        const sha = (p.type === "image" || p.type === "video") && p.source?.type === "url" ? ASSET.exec(p.source.value)?.[1] : undefined;
        return sha === undefined ? [] : [{ kind: p.type, sha }];
      });

// what a client that still sends a model pick (`settings.lead`, before PR #21) is told, alone
export const OUT_OF_DATE = "this client is out of date: reload it (the model is picked per message now)";

// A client that sends the whole history every time must not have old texts answered again: an id
// that is a log index names an entry the server sent (message ids are log indexes, server/agui.ts)
// when that entry is a user message with the same text, and that message is logged already. Any
// other id, numeric or not, is the client's own, which the session answers once (E41).
export const historyOf = (entries: readonly Entry[]) => (m: InboundMessage) => {
  const entry = /^\d+$/.test(m.id) ? entries[Number(m.id)] : undefined;
  return entry?.kind === "user" && entry.text === textOf(m) ? entry : null;
};

// A page from another build than this server's (E44): its /ws?wire=N differs from WIRE. One that
// sends none (the REPL, a page from before the check) is served as ever: it couldn't read the close.
export const staleWire = (url: string) => {
  const wire = new URL(url, "http://x").searchParams.get("wire");
  return wire !== null && wire !== String(WIRE);
};

// The sheet's Stop all, on the state the user saw: its `loop` must still be the turn loop's newest
// run, running or ended (E41), else it does nothing at all, and says so. Then reports are hushed
// first, so the stopped runs' reports, and any other until the user's next message, wake no turn
// (E39); then the turn, if it runs; then every subagent.
export const STOP_ALL_LATE = "not stopped: a turn began after the one Stop all was for";
export const stopEverything = (session: Pick<Session, "hush" | "newestLoop" | "stop">, subagents: Pick<Subagents, "stopAll"> | undefined, loop?: number) =>
  Effect.suspend(() =>
    session.newestLoop(loop)
      ? session.hush.pipe(Effect.andThen(session.stop(loop)), Effect.andThen(subagents?.stopAll ?? Effect.void), Effect.as(null))
      : Effect.succeed(STOP_ALL_LATE),
  );

export const wsRoute = (
  router: HttpRouter.HttpRouter,
  o: {
    readonly session: Session;
    readonly subagents?: Pick<Subagents, "pick" | "stop" | "stopAll" | "tell">; // none: a card's frames are answered that there are none
    readonly entries: readonly Entry[];
    readonly thread: string;
    readonly window: number;
    readonly assets: Assets; // the asset store's lookup, and where a client is told of one it named that isn't there
    readonly heartbeat?: Duration.Input; // HEARTBEAT
  },
) => {
  // the ids of the actions other than messages done so far, the newest ACTS, on every connection:
  // one sent again on another socket, or from another tab, is answered and not done again (E41)
  const done = makeSeen(ACTS);
  const history = historyOf(o.entries);
  return router.add("GET", "/ws", (request) =>
    Effect.gen(function* () {
      const socket = yield* request.upgrade;
      const write = yield* socket.writer;
      // a stale page is told so with a typed close, and reloads instead of reconnecting (E44)
      if (staleWire(request.url)) {
        yield* write.write(new Socket.CloseEvent(WIRE_STALE, "reload: this server runs another build of OptChat"));
        return HttpServerResponse.empty();
      }
      const send = (events: readonly AgUiEvent[]) => Effect.forEach(events, (e) => write.write(JSON.stringify(e)), { discard: true });
      const live = yield* PubSub.subscribe(o.session.events); // before the snapshot, so nothing falls between
      const { beat, first, translate } = openStream({ entries: o.entries, live: o.session.live(), state: o.session.state(), thread: o.thread, window: o.window });
      yield* send(first);
      yield* o.session.primeSoon;
      // The session's events as they come, and a heartbeat when none came for HEARTBEAT, so a
      // client knows a silent socket is dead (web/src/lib/connection.ts). A take that the timeout
      // interrupts had taken nothing (an event that arrives completes it first, in the same step),
      // so no event is lost; and a beat goes out only once the subscription has been empty for a
      // whole HEARTBEAT, so it is never fresher than an event still waiting behind it.
      yield* PubSub.take(live).pipe(
        Effect.timeoutOption(o.heartbeat ?? HEARTBEAT),
        Effect.flatMap(Option.match({ onNone: () => send(beat(o.session.state())), onSome: (e) => send(translate(e)) })),
        Effect.forever,
        Effect.forkScoped,
      );
      // what this client alone is told: an action's receipt (E41), why one did nothing
      const answer = (value: Received) => send([{ name: "received", type: EventType.CUSTOM, value }]);
      const say = (error: string | null) => (error === null ? Effect.void : send([{ name: "info", type: EventType.CUSTOM, value: error }]));
      // a card's action; what went wrong is told to this client alone
      const subagent = (m: Extract<Inbound, { readonly type: "tell" | "stop-subagent" | "subagent-model" }>) => {
        const agents = o.subagents;
        const did =
          agents === undefined
            ? Effect.succeed("there are no subagents on this server")
            : m.type === "tell"
              ? agents.tell(m.name, m.text, m.id)
              : m.type === "stop-subagent"
                ? agents.stop(m.name)
                : agents.pick(m.name, m.model);
        return did.pipe(Effect.flatMap(say));
      };
      // A user message: one this client was sent as the log's (`history`) is logged, any other the
      // session answers once by its id
      const message = (m: InboundMessage, forwarded: InputOptions): Effect.Effect<Received> => {
        const logged = history(m);
        if (logged !== null) return Effect.succeed({ id: m.id, messageId: String(logged.i), outcome: "logged" });
        return takeMessage(o.session, o.assets, { ...forwarded, attachments: attachmentsOf(m), id: m.id, text: textOf(m) });
      };
      const act = (m: Exclude<Inbound, { readonly messages: unknown }>) => {
        switch (m.type) {
          case "abort":
            return o.session.stop(m.loop).pipe(Effect.flatMap(say));
          case "stop-all":
            return stopEverything(o.session, o.subagents, m.loop).pipe(Effect.flatMap(say));
          case "take-back":
            return o.session.takeBack(m.clientId);
          case "settings":
            return o.session.configure({ followUp: m.followUp }).pipe(Effect.andThen(m.lead === undefined ? Effect.void : say(OUT_OF_DATE)));
          case "resume":
            return o.session.resume(m.engine, m.loop);
          case "tell":
          case "stop-subagent":
          case "subagent-model":
            return subagent(m);
        }
      };
      const handle = (m: Inbound) => {
        if ("messages" in m) {
          const { device, engine, followUp } = m.forwardedProps ?? {};
          return Effect.forEach(m.messages, (x) => (x.role === "user" ? message(x, { device, engine, followUp }).pipe(Effect.flatMap(answer)) : Effect.void), { discard: true });
        }
        // done once by its id, or, with none, as it comes
        if (m.id === undefined) return act(m);
        if (!done.add(m.id)) return answer({ id: m.id, messageId: null, outcome: "done" });
        return act(m).pipe(Effect.andThen(answer({ id: m.id, messageId: null, outcome: "taken" })));
      };
      // a frame that doesn't decode is dropped undone, and answered `refused` when it has an id, so
      // its client stops sending it, and can say so
      const unread = (frame: string) => Option.match(decodeId(frame), { onNone: () => Effect.void, onSome: ({ id }) => answer({ id, messageId: null, outcome: "refused" }) });
      const pull = yield* Socket.readerString(socket);
      yield* pull.pipe(
        Effect.flatMap((frames) => Effect.forEach(frames, (frame) => Option.match(decodeInbound(frame), { onNone: () => unread(frame), onSome: handle }))),
        Effect.forever,
        Effect.ignore, // the socket closed
      );
      return HttpServerResponse.empty();
    }).pipe(Effect.scoped, Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
  );
};
