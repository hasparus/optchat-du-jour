// applyEdits from fx0 lib/agent.ts, editDesign (Apache-2.0, © Vercel, modified); the rest is ours.
// The artifacts on disk (SPEC "Artifacts"), beside the stream's chat/ as a subagent's side log is:
//   streams/<device>/artifacts/<Name>/v<N>.html   each version, whole, as the master wrote it
//   streams/<device>/artifacts/<Name>/artifact.json  what it is: its name and its versions
//                                                (number, bytes, date, the tool that made it and
//                                                the log index of that tool call)
// Every file is written to a temp file, synced, and renamed into place (store.ts replaceFile): the
// version first, then artifact.json, so a crash between the two leaves a file no version names,
// which the next version of that number overwrites. Only the lock holder writes, one change at a
// time. persist commits the folder with the rest of the data dir unless `artifacts.commit` is off.
// A name is a subagent's (src/mcp.ts SUBAGENT_NAME: a letter, then up to 31 letters, digits, "-"
// or "_"), so it is a folder name on every system and never a path; two names that differ only in
// case are one name, since a Mac's disk doesn't tell them apart.
import { Clock, Effect, Option, Schema, Semaphore } from "effect";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { replaceFile, StoreError } from "../store.ts";
import { type ArtifactInfo, ArtifactInfo as ArtifactInfoSchema, type ArtifactVersion } from "../wire.ts";
import { validateArtifactHtml } from "./html.ts";

export const ARTIFACT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
// edits in one edit_artifact call, as fx0's edit_design takes them
export const MAX_EDITS = 20;

// what a call that changes an artifact comes to: its new version (or the one it already was, when
// the HTML didn't change), or why nothing was saved, which the model reads as its tool's error
export type Outcome =
  | { readonly ok: true; readonly name: string; readonly version: ArtifactVersion; readonly changed: boolean }
  | { readonly ok: false; readonly error: string };
export type Read = { readonly name: string; readonly version: ArtifactVersion; readonly latest: number; readonly html: string };
export type Edit = { readonly old: string; readonly new: string };

export type Artifacts = {
  // every artifact, the most recently changed first
  readonly list: () => readonly ArtifactInfo[];
  // one by its name, in any case; null for a name it doesn't know (or none at all)
  readonly info: (name: string) => ArtifactInfo | null;
  // a version's HTML (the latest when `v` is left out); null for an unknown name or version
  readonly read: (name: string, v?: number) => Effect.Effect<Read | null, StoreError>;
  // a new version, made of `html` whole or of the latest with `edits` applied; `at`, the log index
  // of the tool call that asked for it (null: not in the log)
  readonly publish: (name: string, html: string, at: number | null) => Effect.Effect<Outcome, StoreError>;
  readonly edit: (name: string, edits: readonly Edit[], at: number | null) => Effect.Effect<Outcome, StoreError>;
};

const decodeInfo = Schema.decodeUnknownOption(Schema.fromJsonString(ArtifactInfoSchema));
const fail = (error: string): Outcome => ({ error, ok: false });
const fileOf = (v: number) => `v${v}.html`;

// "12.4 KB": a size as the tools and the log stubs say it
export const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

// Whether `name` may name an artifact: the reason when it may not, said to the model
export const badName = (name: string): string | null =>
  ARTIFACT_NAME.test(name) ? null : `"${name}" is not an artifact name: a letter, then up to 31 letters, digits, - or _`;

// fx0's edit_design: every edit applied in order to the text as it stands after the ones before,
// each old text matching exactly once; any that doesn't, and nothing is saved
export const applyEdits = (html: string, edits: readonly Edit[]): { readonly html: string } | { readonly error: string } => {
  if (edits.length === 0 || edits.length > MAX_EDITS) return { error: `edits must contain 1 to ${MAX_EDITS} replacements` };
  let out = html;
  for (const [index, edit] of edits.entries()) {
    if (edit.old === "") return { error: `edit ${index + 1}: old must be a non-empty string` };
    const matches = out.split(edit.old).length - 1;
    if (matches !== 1) return { error: `edit ${index + 1}: old matched ${matches} times; it must match exactly once (nothing was saved)` };
    out = out.replace(edit.old, () => edit.new);
  }
  return { html: out };
};

// The artifacts folder of a stream: what an earlier run left is read at once (a folder whose
// artifact.json doesn't read, or names another folder, is reported and left alone), the HTML of a
// version only when it is asked for.
export const openArtifacts = (dir: string, o: { readonly report: (message: string) => Effect.Effect<void> }): Effect.Effect<Artifacts> =>
  Effect.gen(function* () {
    const root = `${dir}/artifacts`;
    const known = new Map<string, ArtifactInfo>(); // by lowercase name
    const problems: string[] = [];
    if (existsSync(root) && statSync(root).isDirectory()) {
      for (const folder of readdirSync(root)) {
        const meta = `${root}/${folder}/artifact.json`;
        if (!ARTIFACT_NAME.test(folder) || !existsSync(meta)) continue;
        const info = Option.getOrUndefined(decodeInfo(readFileSync(meta, "utf8")));
        if (info === undefined || info.name !== folder) {
          problems.push(`artifacts: ${folder}/artifact.json can't be read; that artifact is left out`);
          continue;
        }
        known.set(folder.toLowerCase(), info);
      }
    }
    for (const p of problems) yield* o.report(p);
    const one = yield* Semaphore.make(1);

    const info = (name: string) => known.get(name.toLowerCase()) ?? null;
    const list = () => [...known.values()].toSorted((a, b) => (b.versions.at(-1)?.date ?? "").localeCompare(a.versions.at(-1)?.date ?? ""));

    const read = (name: string, v?: number) =>
      Effect.suspend(() => {
        const found = info(name);
        const latest = found?.versions.at(-1)?.v ?? 0;
        const version = found?.versions.find((x) => x.v === (v ?? latest));
        if (!found || !version) return Effect.succeed(null);
        const path = `${root}/${found.name}/${fileOf(version.v)}`;
        return Effect.try({
          catch: (error) => new StoreError({ message: `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` }),
          try: () => ({ html: readFileSync(path, "utf8"), latest, name: found.name, version }),
        });
      });

    // A new version of `name` (made now if it is new), unless the HTML is the latest's already. The
    // version's file, then artifact.json, each replaced whole; memory changes only once both are on
    // disk, so a write that fails leaves the artifact as it was.
    const save = (name: string, html: string, by: ArtifactVersion["by"], at: number | null, existing: ArtifactInfo | null): Effect.Effect<Outcome, StoreError> =>
      Effect.gen(function* () {
        const checked = validateArtifactHtml(html);
        if (!checked.ok) return fail(checked.error);
        const last = existing?.versions.at(-1);
        if (existing && last) {
          const before = yield* read(existing.name, last.v);
          if (before?.html === html) return { changed: false, name: existing.name, ok: true, version: last } satisfies Outcome;
        }
        const own = existing?.name ?? name;
        const now = yield* Clock.currentTimeMillis;
        const version: ArtifactVersion = { bytes: checked.bytes, by, date: new Date(now).toISOString(), i: at, v: (last?.v ?? 0) + 1 };
        const next: ArtifactInfo = { name: own, versions: [...(existing?.versions ?? []), version] };
        yield* replaceFile(`${root}/${own}`, fileOf(version.v), html);
        yield* replaceFile(`${root}/${own}`, "artifact.json", `${JSON.stringify(next)}\n`);
        known.set(own.toLowerCase(), next);
        return { changed: true, name: own, ok: true, version } satisfies Outcome;
      });

    // publish_artifact: the whole page. One name in any case is one artifact, written as it was
    // first published; another spelling of it is refused, so the model names it the same way.
    const publish = (name: string, html: string, at: number | null) =>
      one.withPermit(
        Effect.suspend(() => {
          const bad = badName(name);
          if (bad !== null) return Effect.succeed(fail(bad));
          const existing = info(name);
          if (existing && existing.name !== name) return Effect.succeed(fail(`there is an artifact named ${existing.name}: use that name`));
          return save(name, html, "publish", at, existing);
        }),
      );

    // edit_artifact: exact replacements in the latest version, saved as one new version
    const edit = (name: string, edits: readonly Edit[], at: number | null) =>
      one.withPermit(
        Effect.gen(function* () {
          const bad = badName(name);
          if (bad !== null) return fail(bad);
          const existing = info(name);
          if (!existing) return fail(`there is no artifact named ${name}: publish_artifact makes one`);
          const latest = yield* read(existing.name);
          if (!latest) return fail(`there is no artifact named ${name}: publish_artifact makes one`);
          const edited = applyEdits(latest.html, edits);
          if ("error" in edited) return fail(edited.error);
          return yield* save(existing.name, edited.html, "edit", at, existing);
        }),
      );

    return { edit, info, list, publish, read };
  });

// the folder persist leaves out of its commits with artifacts.commit off (src/persist.ts, a
// pattern in the data repo's own .git/info/exclude); files committed before stay tracked
export const ARTIFACTS_UNCOMMITTED = "/streams/*/artifacts/";
export const artifactsLeftOut = (commit: boolean): readonly string[] => (commit ? [] : [ARTIFACTS_UNCOMMITTED]);

