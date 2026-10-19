// GET /ws (SPEC "Protocol", E15): one WebSocket per client, AG-UI events out; RunAgentInput frames,
// aborts, take-backs, settings and resumes in. Every client watches the same server-owned session.
import { Clock, Duration, Effect, Option, Predicate, PubSub, Schema, Stream } from "effect";
import { EventType } from "@ag-ui/core";
import { type HttpRouter, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import type { Session, SessionEvent } from "../../src/session.ts";
import type { Subagents } from "../../src/subagents.ts";
import type { Entry } from "../../src/tree.ts";
import { HEARTBEAT } from "../../src/config.ts";
import { type Asset, FollowUp, shortSha } from "../../src/wire.ts";
import { type AgUiEvent, openStream } from "../agui.ts";

// What a client sends: AG-UI's RunAgentInput (its user messages not seen before are the ones to
// answer), an abort, a take-back of a held message by the id its sender gave it, a change to the
// session's settings, the resume of a turn waiting for a model on an engine of the master's chain,
// or a subagent card's tell, stop or model (SPEC M7a). A user message's content is its text, or AG-UI's parts: text, and image
// or video parts whose source is a URL "asset:<sha256>", an upload PUT /api/assets stored
// (SPEC "Media"). The server finds each in its own store; a client never names a path.
// `forwardedProps.followUp` asks for the other follow-up behavior for this one message;
// `forwardedProps.engine` names the engine of the master's chain it is for (the chain's first if none).
const Source = Schema.Struct({ type: Schema.String, value: Schema.String });
const ContentPart = Schema.Struct({ text: Schema.optional(Schema.String), type: Schema.String, source: Schema.optional(Source) });
const InboundMessage = Schema.Struct({
  content: Schema.optional(Schema.Union([Schema.String, Schema.Array(ContentPart)])),
  id: Schema.String,
  role: Schema.String,
});
type InboundMessage = typeof InboundMessage.Type;
const Inbound = Schema.Union([
  Schema.Struct({ type: Schema.Literal("abort") }),
  Schema.Struct({ type: Schema.Literal("take-back"), clientId: Schema.String }),
  // `lead`: an out-of-date client's model pick (the server no longer has one): it is told to reload
  Schema.Struct({ type: Schema.Literal("settings"), followUp: Schema.optional(FollowUp), lead: Schema.optional(Schema.Unknown) }),
  Schema.Struct({ type: Schema.Literal("resume"), engine: Schema.String }),
  // a subagent's card (SPEC M7a): a message to it, its stop, the model of its next call
  Schema.Struct({ type: Schema.Literal("tell"), name: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("stop-subagent"), name: Schema.String }),
  Schema.Struct({ type: Schema.Literal("subagent-model"), name: Schema.String, model: Schema.String }),
  Schema.Struct({
    forwardedProps: Schema.optional(Schema.Struct({ device: Schema.optional(Schema.String), followUp: Schema.optional(FollowUp), engine: Schema.optional(Schema.String) })),
    messages: Schema.Array(InboundMessage),
  }),
]);
type Inbound = typeof Inbound.Type;
const decodeInbound = Schema.decodeUnknownOption(Schema.fromJsonString(Inbound));

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

// how many message ids a connection remembers
const SEEN = 1000;

// The user messages of each RunAgentInput on one connection that it has not sent before: a client
// that sends the whole history every time must not have old texts answered again. An id that is a
// log index names an entry the server sent (message ids are log indexes, server/agui.ts) when that
// entry is a user message with the same text; any other id, numeric or not, is the client's own.
export const unseen = (entries: readonly Entry[]) => {
  const seen = new Set<string>();
  const logged = (id: string, text: string) => {
    const entry = /^\d+$/.test(id) ? entries[Number(id)] : undefined;
    return entry?.kind === "user" && entry.text === text;
  };
  return (messages: readonly InboundMessage[]) =>
    messages.filter((m) => {
      const { id } = m;
      if (m.role !== "user" || seen.has(id) || logged(id, textOf(m))) return false;
      seen.add(id);
      for (const old of seen) {
        if (seen.size <= SEEN) break;
        seen.delete(old); // the oldest first
      }
      return true;
    });
};

export const wsRoute = (
  router: HttpRouter.HttpRouter,
  o: {
    readonly session: Session;
    readonly subagents?: Pick<Subagents, "pick" | "stop" | "tell">; // none: a card's frames are answered that there are none
    readonly entries: readonly Entry[];
    readonly thread: string;
    readonly window: number;
    // the asset store's lookup, and where a client is told of one it named that isn't there
    readonly assets: { readonly find: (sha: string) => Asset | null; readonly report: (message: string) => Effect.Effect<void> };
    readonly heartbeat?: Duration.Input; // HEARTBEAT
  },
) =>
  router.add("GET", "/ws", (request) =>
    Effect.gen(function* () {
      const socket = yield* request.upgrade;
      const write = yield* socket.writer;
      const clock = yield* Clock.Clock;
      let said = clock.currentTimeMillisUnsafe(); // when this connection was last sent anything
      const send = (events: readonly AgUiEvent[]) =>
        Effect.forEach(events, (e) => write.write(JSON.stringify(e)), { discard: true }).pipe(Effect.tap(() => Effect.sync(() => void (said = clock.currentTimeMillisUnsafe()))));
      const live = yield* PubSub.subscribe(o.session.events); // before the snapshot, so nothing falls between
      const { beat, first, translate } = openStream({ entries: o.entries, live: o.session.live(), state: o.session.state(), thread: o.thread, window: o.window });
      yield* send(first);
      yield* o.session.primeSoon;
      // The session's events as they come, and a heartbeat once nothing went out for HEARTBEAT,
      // so a client knows a silent socket is dead (web/src/lib/connection.ts). A clock looks five
      // times per HEARTBEAT; the events are merged with it, one at a time, and never interrupted.
      const every = Duration.toMillis(Duration.fromInputUnsafe(o.heartbeat ?? HEARTBEAT));
      const events: Stream.Stream<Option.Option<SessionEvent>> = Stream.fromSubscription(live).pipe(Stream.map(Option.some));
      yield* events.pipe(
        Stream.merge(Stream.tick(Duration.millis(every / 5)).pipe(Stream.map((): Option.Option<SessionEvent> => Option.none()))),
        Stream.runForEach(
          Option.match({
            onNone: () => (clock.currentTimeMillisUnsafe() - said >= every ? send(beat(o.session.state())) : Effect.void),
            onSome: (e) => send(translate(e)),
          }),
        ),
        Effect.forkScoped,
      );
      const fresh = unseen(o.entries);
      // a message's attachments as stored; one the store doesn't hold is left out, and said
      const attached = (m: InboundMessage) =>
        Effect.forEach(attachmentsOf(m), ({ kind, sha }) => {
          const asset = o.assets.find(sha);
          if (asset?.kind === kind) return Effect.succeed([asset]);
          return o.assets.report(`${kind} ${shortSha(sha)} is not on the server: left out of the message`).pipe(Effect.as([]));
        }).pipe(Effect.map((found) => found.flat()));
      // a card's action; what went wrong is told to this client alone
      const subagent = (m: Extract<Inbound, { readonly type: "tell" | "stop-subagent" | "subagent-model" }>) => {
        const agents = o.subagents;
        const done =
          agents === undefined
            ? Effect.succeed("there are no subagents on this server")
            : m.type === "tell"
              ? agents.tell(m.name, m.text)
              : m.type === "stop-subagent"
                ? agents.stop(m.name)
                : agents.pick(m.name, m.model);
        return done.pipe(Effect.flatMap((error) => (error === null ? Effect.void : send([{ name: "info", type: EventType.CUSTOM, value: error }]))));
      };
      const handle = (m: Inbound) => {
        if ("messages" in m) {
          const { device, engine, followUp } = m.forwardedProps ?? {};
          return Effect.forEach(fresh(m.messages), (x) => attached(x).pipe(Effect.flatMap((media) => o.session.input(textOf(x), { clientId: x.id, device, engine, followUp, media }))), {
            discard: true,
          });
        }
        switch (m.type) {
          case "abort":
            return o.session.cancel;
          case "take-back":
            return o.session.takeBack(m.clientId);
          case "settings":
            return o.session
              .configure({ followUp: m.followUp })
              .pipe(Effect.andThen(m.lead === undefined ? Effect.void : send([{ name: "info", type: EventType.CUSTOM, value: OUT_OF_DATE }])));
          case "resume":
            return o.session.resume(m.engine);
          case "tell":
          case "stop-subagent":
          case "subagent-model":
            return subagent(m);
        }
      };
      const pull = yield* Socket.readerString(socket);
      yield* pull.pipe(
        Effect.flatMap((frames) => Effect.forEach(frames, (frame) => Option.match(decodeInbound(frame), { onNone: () => Effect.void, onSome: handle }))),
        Effect.forever,
        Effect.ignore, // the socket closed
      );
      return HttpServerResponse.empty();
    }).pipe(Effect.scoped, Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
  );
