// GET /ws (SPEC "Protocol", E15): one WebSocket per client, AG-UI events out, RunAgentInput frames
// and aborts in. Every client watches the same server-owned session.
import { Effect, Option, Predicate, PubSub, Schema } from "effect";
import { type HttpRouter, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";
import type { Session } from "../../src/session.ts";
import type { Entry } from "../../src/tree.ts";
import { type Asset, shortSha } from "../../src/wire.ts";
import { type AgUiEvent, openStream } from "../agui.ts";

// What a client sends: AG-UI's RunAgentInput (its user messages not seen before are the ones to
// answer), or an abort. A user message's content is its text, or AG-UI's parts: text, and image
// or video parts whose source is a URL "asset:<sha256>", an upload PUT /api/assets stored
// (SPEC "Media"). The server finds each in its own store; a client never names a path.
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
  Schema.Struct({
    forwardedProps: Schema.optional(Schema.Struct({ device: Schema.optional(Schema.String) })),
    messages: Schema.Array(InboundMessage),
  }),
]);
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
    readonly entries: readonly Entry[];
    readonly thread: string;
    readonly window: number;
    // the asset store's lookup, and where a client is told of one it named that isn't there
    readonly assets?: { readonly find: (sha: string) => Asset | null; readonly report: (message: string) => Effect.Effect<void> };
  },
) =>
  router.add("GET", "/ws", (request) =>
    Effect.gen(function* () {
      const socket = yield* request.upgrade;
      const write = yield* socket.writer;
      const send = (events: readonly AgUiEvent[]) => Effect.forEach(events, (e) => write.write(JSON.stringify(e)), { discard: true });
      const live = yield* PubSub.subscribe(o.session.events); // before the snapshot, so nothing falls between
      const { first, translate } = openStream({ entries: o.entries, live: o.session.live(), state: o.session.state(), thread: o.thread, window: o.window });
      yield* send(first);
      yield* o.session.primeSoon;
      yield* PubSub.take(live).pipe(
        Effect.flatMap((e) => send(translate(e))),
        Effect.forever,
        Effect.forkScoped,
      );
      const fresh = unseen(o.entries);
      // a message's attachments as stored; one the store doesn't hold is left out, and said
      const attached = (m: InboundMessage) =>
        Effect.forEach(attachmentsOf(m), ({ kind, sha }) => {
          const asset = o.assets?.find(sha) ?? null;
          if (asset?.kind === kind) return Effect.succeed([asset]);
          return (o.assets?.report(`${kind} ${shortSha(sha)} is not on the server: left out of the message`) ?? Effect.void).pipe(Effect.as([]));
        }).pipe(Effect.map((found) => found.flat()));
      const pull = yield* Socket.readerString(socket);
      yield* pull.pipe(
        Effect.flatMap((frames) =>
          Effect.forEach(frames, (frame) =>
            Option.match(decodeInbound(frame), {
              onNone: () => Effect.void,
              onSome: (m) =>
                "messages" in m
                  ? Effect.forEach(fresh(m.messages), (x) => attached(x).pipe(Effect.flatMap((media) => o.session.input(textOf(x), m.forwardedProps?.device, x.id, media))), {
                      discard: true,
                    })
                  : o.session.cancel,
            }),
          ),
        ),
        Effect.forever,
        Effect.ignore, // the socket closed
      );
      return HttpServerResponse.empty();
    }).pipe(Effect.scoped, Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
  );
