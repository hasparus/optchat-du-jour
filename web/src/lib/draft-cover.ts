// What covers an artifact's frame while the model writes a version of it (SPEC "Artifacts"): the
// draft's picture, drawn without scripts. It stays a little past the draft's end, until the version
// it became has painted, so the reader sees no blank between the picture and the page.
import { Data } from "effect";

// None: the frame shows as it is. Drafting: the model is writing; `html` is the draft so far.
// Held: the draft is over, and its last picture stays until the new version has painted.
// `base`: the latest version when the draft began (null: none yet); the one it becomes is newer.
export type Cover = Data.TaggedEnum<{
  None: {};
  Drafting: { readonly html: string; readonly base: number | null };
  Held: { readonly html: string; readonly base: number | null };
}>;
export const Cover = Data.taggedEnum<Cover>();

// how long a draft's picture is held when no newer version paints (the turn was stopped before it
// saved one, or the frame never said it painted)
export const HOLD_MS = 4000;

export type CoverInput = {
  readonly draft: string | null; // the draft's html, while one is being written and can be drawn
  readonly latest: number | null; // the artifact's latest version
  readonly onLatest: boolean; // the pane follows the latest version: an older one is never covered
  readonly painted: boolean; // the frame shows the version the pane asks for, painted
};

// The cover after `now`, given what it was; the same object when nothing changed.
export function coverNext(was: Cover, now: CoverInput): Cover {
  if (!now.onLatest) return was._tag === "None" ? was : Cover.None();
  if (now.draft !== null) {
    const base = was._tag === "None" ? now.latest : was.base;
    return was._tag === "Drafting" && was.html === now.draft ? was : Cover.Drafting({ base, html: now.draft });
  }
  if (was._tag === "None") return was;
  // the draft is over: a newer version than it began from, painted, takes its place
  if (now.latest !== was.base && now.painted) return Cover.None();
  return was._tag === "Held" ? was : Cover.Held({ base: was.base, html: was.html });
}

export const coverHtml = (c: Cover) => (c._tag === "None" ? null : c.html);
