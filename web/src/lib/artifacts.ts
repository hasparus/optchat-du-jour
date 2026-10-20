// From fx0 lib/design-draft.ts, applyDesignDraft (Apache-2.0, © Vercel, modified).
// The artifacts as this client sees them (SPEC "Artifacts"): the live drafts of the run going on,
// from CUSTOM "artifact-draft" frames (fx0's applyDesignDraft, one draft per tool call here, held
// by its id), and what a tool row says of the version it made.
import { type ArtifactDraft, artifactTool, type ArtifactInfo, type ArtifactVersion, savedVersion } from "@wire";
import { Option, Schema } from "effect";
import type { Row } from "./rows.ts";

// a call's draft as it stands: the page so far, and `closed` once the model finished writing it
export type Draft = {
  readonly id: string;
  readonly runId: string;
  readonly tool: "publish" | "edit";
  readonly name: string | null;
  readonly html: string;
  readonly closed: boolean;
};
export type Drafts = ReadonlyMap<string, Draft>;
export const noDrafts: Drafts = new Map();

// one CUSTOM "artifact-draft" frame (src/wire.ts)
export type DraftPiece = ArtifactDraft;

/** Offsets are UTF-16 positions, as in String.slice, including across JSON escapes. A piece that
 * leaves a gap, or disagrees with what is held, is not applied; one already held is not doubled
 * (a client that reconnects gets the draft whole again). */
export function applyDraft(drafts: Drafts, piece: DraftPiece): Drafts {
  const current = drafts.get(piece.id);
  const next = (html: string): Drafts =>
    new Map([...drafts, [piece.id, { closed: piece.closed || (current?.closed ?? false), html, id: piece.id, name: piece.name ?? current?.name ?? null, runId: piece.runId, tool: piece.tool }]]);
  if (piece.replace) return piece.offset === 0 ? next(piece.delta) : drafts;
  if (!current || current.runId !== piece.runId) return piece.offset === 0 ? next(piece.delta) : drafts;
  if (piece.offset > current.html.length) return drafts;
  const overlap = Math.min(piece.delta.length, current.html.length - piece.offset);
  if (current.html.slice(piece.offset, piece.offset + overlap) !== piece.delta.slice(0, overlap)) return drafts;
  if (overlap === piece.delta.length && (!piece.closed || current.closed) && (piece.name ?? current.name) === current.name) return drafts;
  return next(current.html + piece.delta.slice(overlap));
}

// A version was saved: the closed drafts of that artifact are done (fx0 holds the last picture
// until the artifact event, so the published page replaces it without a blank between)
export const savedOver = (drafts: Drafts, name: string): Drafts => {
  const left = [...drafts.values()].filter((d) => !(d.closed && d.name?.toLowerCase() === name.toLowerCase()));
  return left.length === drafts.size ? drafts : new Map(left.map((d) => [d.id, d]));
};

// ---- a tool row of an artifact call ----

const Named = Schema.fromJsonString(Schema.Struct({ name: Schema.String }));
const decodeNamed = Schema.decodeUnknownOption(Named);

// What a publish or an edit row made: the artifact's name (from its input as logged, a stub
// holding no HTML, E31) and its version, which its echo alone says, at its end ("… [v3]", src/wire.ts
// savedVersion); its size and date are that version's in the list. Null for any other row, and
// for a call the server refused (its echo, flagged, says why: the row stays a tool line).
export type Made = { readonly name: string; readonly tool: "publish" | "edit"; readonly v: number | null; readonly version: ArtifactVersion | null };
// read once per row object and list, so a memoized row isn't drawn again on every streamed token
const made = new WeakMap<object, { readonly list: readonly ArtifactInfo[]; readonly made: Made | null }>();
export function madeBy(row: Row, list: readonly ArtifactInfo[]): Made | null {
  const known = made.get(row);
  if (known?.list === list) return known.made;
  const found = readMade(row, list);
  made.set(row, { list, made: found });
  return found;
}
function readMade(row: Row, list: readonly ArtifactInfo[]): Made | null {
  if (row.kind !== "tool") return null;
  const tool = artifactTool(row.name);
  if (tool !== "publish_artifact" && tool !== "edit_artifact") return null;
  if (row.failed) return null;
  const name = Option.getOrUndefined(decodeNamed(row.args))?.name;
  if (name === undefined) return null;
  const info = list.find((a) => a.name.toLowerCase() === name.toLowerCase());
  const v = row.output === null ? null : savedVersion(row.output);
  const version = v === null ? null : (info?.versions.find((x) => x.v === v) ?? null);
  return { name: info?.name ?? name, tool: tool === "publish_artifact" ? "publish" : "edit", v, version };
}


// the routes (server/routes/artifacts.ts)
export const frameUrl = (name: string, v: number | null) => `/artifact/frame?${new URLSearchParams(v === null ? { name } : { name, v: String(v) })}`;
export const rawUrl = (name: string, v: number) => `/api/artifact?${new URLSearchParams({ name, v: String(v) })}`;
export const DRAFT_URL = "/artifact/draft";

// "landing page!" → landing-page (fx0's designFileName), with the version
export const fileName = (name: string, v: number) => `${name.replaceAll(/[^A-Za-z0-9_-]+/g, "-") || "artifact"}-v${v}.html`;
