// A client's message, from /ws (a RunAgentInput's user message) or POST /api/messages: its
// attachments looked up in the asset store, then the session's, answered by its id (E41). The
// session looks the id up once, as it takes the message: one it has seen is answered as it stands
// now and nothing more, so what is said of an attachment the store doesn't hold is said once.
import { Effect } from "effect";
import { receivedOf } from "../src/once.ts";
import type { InputOptions, Session } from "../src/session.ts";
import { type Asset, type Received, shortSha } from "../src/wire.ts";

// the asset store's lookup, and where a client is told of an attachment that isn't there
export type Assets = { readonly find: (sha: string) => Asset | null; readonly report: (message: string) => Effect.Effect<void> };

// an attachment as a message names it: an image or a video by its digest (SPEC "Media")
export type Named = { readonly kind: string; readonly sha: string };

export type Message = Omit<InputOptions, "clientId" | "media" | "leftOut"> & { readonly id: string; readonly text: string; readonly attachments: readonly Named[] };

export const takeMessage = (session: Pick<Session, "input">, assets: Pick<Assets, "find">, { attachments, id, text, ...forwarded }: Message): Effect.Effect<Received> =>
  Effect.suspend(() => {
    // the attachments as stored; one the store doesn't hold is left out, and said if it is taken
    const media: Asset[] = [];
    const leftOut: string[] = [];
    for (const { kind, sha } of attachments) {
      const asset = assets.find(sha);
      if (asset?.kind === kind) media.push(asset);
      else leftOut.push(`${kind} ${shortSha(sha)} is not on the server: left out of the message`);
    }
    return session.input(text, { ...forwarded, clientId: id, leftOut, media }).pipe(Effect.map((r) => receivedOf(id, r)));
  });
