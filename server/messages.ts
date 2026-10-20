// A client's message, from /ws (a RunAgentInput's user message) or POST /api/messages: its
// attachments looked up in the asset store, then the session's, answered by its id (E41). The
// session looks the id up once, as it takes the message: one it has seen is answered as it stands
// now and nothing more, so what is said of an attachment the store doesn't hold is said once. One
// left with nothing to send once those are left out is refused, and its sender alone told why.
import { Effect } from "effect";
import { receivedOf } from "../src/once.ts";
import type { InputOptions, Session } from "../src/session.ts";
import { type Asset, type Received, shortSha } from "../src/wire.ts";

// the asset store's lookup
export type Assets = { readonly find: (sha: string) => Asset | null };

// an attachment as a message names it: an image or a video by its digest (SPEC "Media")
export type Named = { readonly kind: string; readonly sha: string };

export type Message = Omit<InputOptions, "clientId" | "media" | "leftOut"> & { readonly id: string; readonly text: string; readonly attachments: readonly Named[] };

export const takeMessage = (session: Pick<Session, "input">, assets: Assets, { attachments, id, text, ...forwarded }: Message): Effect.Effect<Received> =>
  Effect.suspend(() => {
    // the attachments as stored; one the store doesn't hold is left out, and said if it is taken
    // (or, when nothing else is left, why the message is refused)
    const media: Asset[] = [];
    const leftOut: string[] = [];
    for (const { kind, sha } of attachments) {
      const asset = assets.find(sha);
      if (asset?.kind === kind) media.push(asset);
      else leftOut.push(`${kind} ${shortSha(sha)}`);
    }
    return session.input(text, { ...forwarded, clientId: id, leftOut, media }).pipe(Effect.map((r) => receivedOf(id, r)));
  });
