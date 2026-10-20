// A client's message, from /ws (a RunAgentInput's user message) or POST /api/messages: its
// attachments looked up in the asset store, then the session's, answered by its id (E41). A message
// the session has seen is answered as it stands now and nothing more: its attachments are not
// looked up again, so what was said about one missing is said once.
import { Effect } from "effect";
import { receivedOf } from "../src/once.ts";
import type { InputOptions, Session } from "../src/session.ts";
import { type Asset, type Received, shortSha } from "../src/wire.ts";

// the asset store's lookup, and where a client is told of an attachment that isn't there
export type Assets = { readonly find: (sha: string) => Asset | null; readonly report: (message: string) => Effect.Effect<void> };

// an attachment as a message names it: an image or a video by its digest (SPEC "Media")
export type Named = { readonly kind: string; readonly sha: string };

export type Message = Omit<InputOptions, "clientId" | "media"> & { readonly id: string; readonly text: string; readonly attachments: readonly Named[] };

// the attachments as stored; one the store doesn't hold is left out, and said
const stored = (assets: Assets, named: readonly Named[]) =>
  Effect.forEach(named, ({ kind, sha }) => {
    const asset = assets.find(sha);
    if (asset?.kind === kind) return Effect.succeed([asset]);
    return assets.report(`${kind} ${shortSha(sha)} is not on the server: left out of the message`).pipe(Effect.as([]));
  }).pipe(Effect.map((found) => found.flat()));

export const takeMessage = (session: Pick<Session, "input" | "receipt">, assets: Assets, { attachments, id, text, ...forwarded }: Message): Effect.Effect<Received> =>
  Effect.suspend(() => {
    const seen = session.receipt(id);
    if (seen !== null) return Effect.succeed(receivedOf(id, seen));
    return stored(assets, attachments).pipe(
      Effect.flatMap((media) => session.input(text, { ...forwarded, clientId: id, media })),
      Effect.map((r) => receivedOf(id, r)),
    );
  });
