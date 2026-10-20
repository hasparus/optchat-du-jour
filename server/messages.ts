// A client's message, from /ws (a RunAgentInput's user message) or POST /api/messages: its
// attachments looked up in the asset store, then the session's, answered by its id (E41). The
// session looks the id up once, as it takes the message: one it has seen is answered as it stands
// now and nothing more, so what is said of an attachment the store doesn't hold is said once. One
// left with nothing to send once those are left out is refused, and its sender alone told why.
import { Effect } from "effect";
import { receivedOf } from "../src/once.ts";
import type { InputOptions, Named, Session } from "../src/session.ts";
import type { Asset, Received } from "../src/wire.ts";

// the asset store's lookup
export type Assets = { readonly find: (sha: string) => Asset | null };

export type Message = Omit<InputOptions, "clientId" | "media" | "leftOut"> & { readonly id: string; readonly text: string; readonly attachments: readonly Named[] };

export const takeMessage = (session: Pick<Session, "input">, assets: Assets, { attachments, id, text, ...forwarded }: Message): Effect.Effect<Received> =>
  Effect.suspend(() => {
    // the attachments as stored; one the store doesn't hold is left out, and said if it is taken
    // (or, when nothing else is left, why the message is refused)
    const media: Asset[] = [];
    const leftOut: Named[] = [];
    for (const named of attachments) {
      const asset = assets.find(named.sha);
      if (asset?.kind === named.kind) media.push(asset);
      else leftOut.push(named);
    }
    return session.input(text, { ...forwarded, clientId: id, leftOut, media }).pipe(Effect.map((r) => receivedOf(id, r)));
  });
