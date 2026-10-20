// An artifact's live draft (SPEC "Artifacts"): while the model writes a publish_artifact or an
// edit_artifact call, the page so far goes to clients, which show it without its scripts
// (web/src/lib/draft-preview.ts); only the version the call saves runs them. The JSON field
// decoder is fx0's htmlFieldExtractor (lib/gateway-session.ts) and the batching fx0's
// createDraftBatch (lib/design-draft.ts), both Apache-2.0, © Vercel, modified: on an Effect fiber
// instead of a timer, and an edit's draft is the latest version with the edits written so far.
import { Effect, Fiber, Option, Schema, type Scope } from "effect";
import { type ArtifactDraft, artifactTool } from "../wire.ts";
import { MAX_ARTIFACT_BYTES } from "./html.ts";
import { applyEdits, type Edit } from "./store.ts";

// how often a draft goes out while it streams, at most
export const DRAFT_EVERY = "150 millis";

// Decodes the string field `field` of a call's partial JSON as the model writes it, emitting each
// newly decoded piece. Escapes split across deltas wait for the rest; the closing quote ends it.
export function fieldExtractor(field: string, emit: (chunk: string) => void): (delta: string) => void {
  let raw = "";
  let pos = -1;
  let done = false;
  const escapes = new Map([
    ["b", "\b"],
    ["f", "\f"],
    ["n", "\n"],
    ["r", "\r"],
    ["t", "\t"],
  ]);
  const start = new RegExp(`"${field}"\\s*:\\s*"`);
  return (delta) => {
    if (done) return;
    raw += delta;
    if (pos < 0) {
      const found = start.exec(raw);
      if (!found) return;
      pos = found.index + found[0].length;
    }
    let out = "";
    while (pos < raw.length) {
      const char = raw[pos] ?? "";
      if (char === '"') {
        done = true;
        break;
      }
      if (char !== "\\") {
        out += char;
        pos++;
        continue;
      }
      if (pos + 1 >= raw.length) break;
      const next = raw[pos + 1] ?? "";
      if (next === "u") {
        if (pos + 6 > raw.length) break;
        const code = Number.parseInt(raw.slice(pos + 2, pos + 6), 16);
        out += Number.isInteger(code) ? String.fromCodePoint(code) : "\uFFFD";
        pos += 6;
        continue;
      }
      out += escapes.get(next) ?? next;
      pos += 2;
    }
    if (out) emit(out);
  };
}

const decodeString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String));
// the call's `name`, once the model has written it whole
export const nameIn = (raw: string): string | null => {
  const found = /"name"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(raw);
  return found?.[1] === undefined ? null : Option.getOrNull(decodeString(found[1]));
};

const decodeEdit = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({ new: Schema.String, old: Schema.String })));
// The edits of an edit_artifact call that the model has written whole so far: each object of the
// `edits` array once its closing brace is in, read on its own
export const editsIn = (raw: string): Edit[] => {
  const at = /"edits"\s*:\s*\[/.exec(raw);
  if (!at) return [];
  const edits: Edit[] = [];
  let depth = 0;
  let quote = false;
  let from = -1;
  for (let k = at.index + at[0].length; k < raw.length; k++) {
    const char = raw[k];
    if (quote) {
      if (char === "\\") k++;
      else if (char === '"') quote = false;
      continue;
    }
    if (char === '"') quote = true;
    else if (char === "{") {
      if (depth === 0) from = k;
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0 && from >= 0) {
        const edit = Option.getOrUndefined(decodeEdit(raw.slice(from, k + 1)));
        if (edit) edits.push(edit);
      }
    } else if (char === "]" && depth === 0) break;
  }
  return edits;
};

// What clients are told of one call's draft (src/wire.ts ArtifactDraft); a draft as it stands, for
// a client that joins while it streams
export type DraftOut = ArtifactDraft;
export type DraftNow = Pick<ArtifactDraft, "closed" | "id" | "name" | "tool"> & { readonly html: string };

type Call = {
  readonly id: string;
  readonly tool: "publish" | "edit";
  raw: string;
  html: string; // the page so far
  sent: number; // how much of `html` clients have (publish: it only grows)
  base: string | null | undefined; // edit: the latest version (undefined: not read yet)
  edits: number; // edit: the edits applied to `base` so far
  due: boolean; // a flush is scheduled and has not started
  last: Fiber.Fiber<void> | null; // the newest flush's fiber, scheduled, running or done
  feed: ((delta: string) => void) | null; // publish: the html field's decoder
  closed: boolean;
};

// One run's drafts. `base`: an artifact's latest version, for an edit's draft. `send`: a draft
// goes out (each call's at most every DRAFT_EVERY while it streams, and once more as it closes).
export const makeDrafts = (o: {
  readonly runId: string;
  readonly base: (name: string) => Effect.Effect<string | null>;
  readonly send: (d: DraftOut) => Effect.Effect<void>;
  readonly scope: Scope.Scope;
}) => {
  const calls = new Map<string, Call>();

  const flush = (call: Call): Effect.Effect<void> =>
    Effect.gen(function* () {
      call.due = false;
      const name = nameIn(call.raw);
      if (call.tool === "edit") {
        if (name !== null && call.base === undefined) call.base = yield* o.base(name);
        const edits = editsIn(call.raw);
        if (call.base == null || (edits.length === call.edits && !call.closed)) return;
        if (edits.length !== call.edits) {
          call.edits = edits.length;
          // the edits so far, each that matches once; one that doesn't is left out of the picture
          let html = call.base;
          for (const e of edits) {
            const done = applyEdits(html, [e]);
            if ("html" in done) html = done.html;
          }
          call.html = html;
        }
        return yield* o.send({ closed: call.closed, delta: call.html, id: call.id, name, offset: 0, replace: true, runId: o.runId, tool: "edit" });
      }
      const delta = call.html.slice(call.sent);
      if (delta === "" && !call.closed) return;
      const offset = call.sent;
      call.sent = call.html.length;
      yield* o.send({ closed: call.closed, delta, id: call.id, name, offset, replace: false, runId: o.runId, tool: "publish" });
    });

  // a piece of a call's input: an artifact tool's goes into its draft, any other is not looked at
  const delta = (c: { readonly id: string; readonly name: string }, piece: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      let call = calls.get(c.id);
      if (!call) {
        const tool = artifactTool(c.name);
        if (tool !== "publish_artifact" && tool !== "edit_artifact") return Effect.void;
        const made: Call = { base: undefined, closed: false, due: false, edits: 0, feed: null, html: "", id: c.id, last: null, raw: "", sent: 0, tool: tool === "publish_artifact" ? "publish" : "edit" };
        if (made.tool === "publish")
          made.feed = fieldExtractor("html", (chunk) => {
            made.html += chunk;
          });
        calls.set(c.id, made);
        call = made;
      }
      if (call.closed) return Effect.void;
      call.raw += piece;
      call.feed?.(piece);
      // A page past what a version may hold is refused when the call ends anyway: its draft stops
      // here, closed, so no client holds or is sent more than MAX_ARTIFACT_BYTES of it
      if (call.html.length > MAX_ARTIFACT_BYTES || call.raw.length > 2 * MAX_ARTIFACT_BYTES) return end(call.id);
      if (call.due) return Effect.void;
      const it = call;
      it.due = true;
      return Effect.sleep(DRAFT_EVERY).pipe(
        // whole or not at all: a close that comes meanwhile waits for it, so no piece is lost
        Effect.andThen(Effect.uninterruptible(Effect.suspend(() => flush(it)))),
        Effect.forkIn(o.scope),
        Effect.tap((fiber) => Effect.sync(() => void (it.last = fiber))),
        Effect.asVoid,
      );
    });

  // The call's input is whole: a flush still waiting is called off, one running is waited for, and
  // what is left goes out at once, closed; no timer stays behind
  function end(id: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      const call = calls.get(id);
      if (!call || call.closed) return Effect.void;
      const settle = Effect.suspend(() => (call.last === null ? Effect.void : Fiber.interrupt(call.last)));
      // the flush in flight first, as it was (open), then nothing more is taken, then the close
      return settle.pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (call.closed) return Effect.void; // another end got here first
            call.closed = true;
            if (call.tool === "publish" && call.html.length > MAX_ARTIFACT_BYTES) call.html = call.html.slice(0, call.sent);
            return settle.pipe(Effect.andThen(flush(call)));
          }),
        ),
      );
    });
  }

  // every draft as it stands, for a client that joins now
  const now = (): DraftNow[] => [...calls.values()].map((c) => ({ closed: c.closed, html: c.html, id: c.id, name: nameIn(c.raw), tool: c.tool }));

  // the run is over: no timer stays behind
  const stop = Effect.suspend(() => Effect.forEach([...calls.values()], (c) => (c.last === null ? Effect.void : Fiber.interrupt(c.last)), { discard: true })).pipe(
    Effect.andThen(
      Effect.sync(() => {
        calls.clear();
      }),
    ),
  );

  return { delta, end, now, stop };
};
