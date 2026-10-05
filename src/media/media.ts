// The media service (SPEC "Media"): an upload in, a stored asset out (./assets.ts), its caption
// started at once in the background, and what each reader of an attachment needs: the engines
// its pictures (./part.ts), the log its marker line (wire.ts markerOf), zoom its MCP content.
import { Deferred, Effect, Option, type Scope } from "effect";
import { readFileSync } from "node:fs";
import type { MediaSettings } from "../config.ts";
import { type Asset, type ImageAsset, NOT_DESCRIBED, shortSha, splitMarkers, type VideoAsset } from "../wire.ts";
import { type AssetStore, assetStore, sha256 } from "./assets.ts";
import type { Captioner } from "./caption.ts";
import { contactSheet, MediaError, normalizeImage, type Tier, TIERS } from "./image.ts";
import type { Part, Picture } from "./part.ts";
import { EXT, sniff } from "./sniff.ts";
import { clock, extract, FRAME_EDGE } from "./video.ts";

// one block of an MCP tool result: text, or an image (base64) the model can look at
export type McpContent = { readonly type: "text"; readonly text: string } | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export type Media = {
  readonly store: AssetStore;
  // an upload's bytes to a stored asset; the same bytes give the same asset
  readonly ingest: (bytes: Uint8Array, tier: Tier) => Effect.Effect<Asset, MediaError>;
  readonly find: (id: string) => Asset | null;
  // the attachment's caption, waited for at most `captionWait`; "(not described)" when none came
  readonly caption: (a: Asset) => Effect.Effect<string>;
  // the caption if there is one yet
  readonly captionNow: (a: Asset) => string | null;
  // what an engine is sent of it: its picture, or a video's frames with their times and its transcript
  readonly parts: (a: Asset) => Part[];
  // zoom(id, 1) on a message: the pictures of its attachments (at most MAX_ZOOM)
  readonly zoomContent: (text: string) => McpContent[];
};

// images a zoom answers with, at most
export const MAX_ZOOM = 4;

const base64 = (path: string) => readFileSync(path).toString("base64");
// a write to the store, failing as a 500
const io = <A>(what: string, f: () => A) =>
  Effect.try({ catch: (error) => new MediaError({ message: `${what}: ${error instanceof Error ? error.message : String(error)}`, status: 500 }), try: f });

export const makeMedia = (o: {
  readonly root: string; // <home>/assets
  readonly settings: MediaSettings;
  readonly captioner: Captioner | null; // null: nothing is described (tests, or no chain)
  readonly report: (message: string) => Effect.Effect<void>;
}): Effect.Effect<Media, never, Scope.Scope> =>
  Effect.gen(function* () {
    const store = assetStore(o.root);
    const scope = yield* Effect.scope;
    const tools = { ffmpeg: o.settings.ffmpeg, ffprobe: o.settings.ffprobe, whisper: o.settings.whisper };

    const picture = (a: ImageAsset): Picture | null => {
      const file = store.file(a);
      return file ? { data: base64(file.path), mime: a.mime, type: "image" } : null;
    };
    const imageById = (sha: string) => {
      const a = store.find(sha);
      return a?.kind === "image" ? a : null;
    };
    // the one picture that shows an asset: the image, or a video's contact sheet
    const shownOf = (a: Asset) => {
      const img = a.kind === "image" ? a : imageById(a.sheet);
      return img && picture(img);
    };

    // an image's normalized bytes stored, with its metadata
    const keepImage = (bytes: Uint8Array, edge: number, quality?: number) =>
      Effect.gen(function* () {
        const n = yield* normalizeImage(bytes, edge, quality);
        const { sha } = yield* io("cannot store the image", () => store.put(n.data, n.mime));
        const asset: ImageAsset = { bytes: n.data.length, height: n.height, kind: "image", mime: n.mime, sha, width: n.width };
        yield* io("cannot store the image", () => {
          store.putMeta(asset);
        });
        return asset;
      });

    const ingestVideo = (bytes: Uint8Array, mime: VideoAsset["mime"]) =>
      Effect.gen(function* () {
        const x = yield* extract(tools, bytes, EXT[mime], o.settings.maxVideoSeconds);
        const sha = sha256(x.clean);
        const known = store.find(sha);
        if (known) return known;
        const frames = yield* Effect.forEach(x.frames, (f) => keepImage(f.data, FRAME_EDGE, 80).pipe(Effect.map((a) => ({ ...a, t: f.t }))));
        const stored = frames.flatMap((f) => {
          const file = store.file(f);
          return file ? [{ data: new Uint8Array(readFileSync(file.path)), t: f.t }] : [];
        });
        const sheet = yield* contactSheet(stored, clock);
        const kept = yield* io("cannot store the video", () => {
          const put = store.put(sheet.data, sheet.mime);
          store.putMeta({ bytes: sheet.data.length, height: sheet.height, kind: "image", mime: sheet.mime, sha: put.sha, width: sheet.width });
          store.put(x.clean, mime);
          return put;
        });
        // the metadata last: a video with metadata has all its parts on disk
        const asset: VideoAsset = {
          bytes: x.clean.length,
          duration: x.probe.duration,
          frames: frames.map((f) => ({ height: f.height, sha: f.sha, t: f.t, width: f.width })),
          height: x.probe.height,
          kind: "video",
          mime,
          notice: x.notice,
          sha,
          sheet: kept.sha,
          transcript: x.transcript,
          width: x.probe.width,
        };
        yield* io("cannot store the video", () => {
          store.putMeta(asset);
        });
        return asset;
      });

    // captions by asset, each started once; a failed one is forgotten, so the next ask tries again
    const captions = new Map<string, Deferred.Deferred<string>>();
    const ready = new Map<string, string>(); // the ones done
    const describe = (a: Asset) =>
      Effect.gen(function* () {
        const known = captions.get(a.sha);
        if (known) return known;
        const done = yield* Deferred.make<string>();
        captions.set(a.sha, done);
        const input = shownOf(a);
        const heard = a.kind === "video" ? a.transcript : null;
        const job =
          o.captioner === null || input === null
            ? Effect.succeed(NOT_DESCRIBED)
            : o.captioner({ heard, picture: input }).pipe(
                Effect.tapError((e) => Effect.sync(() => captions.delete(a.sha)).pipe(Effect.andThen(o.report(`no caption for ${a.kind} ${shortSha(a.sha)}: ${e.message}`)))),
                Effect.orElseSucceed(() => NOT_DESCRIBED),
              );
        yield* job.pipe(
          Effect.tap((c) => Effect.sync(() => c !== NOT_DESCRIBED && ready.set(a.sha, c))),
          Effect.flatMap((c) => Deferred.succeed(done, c)),
          Effect.forkIn(scope),
        );
        return done;
      });

    const caption = (a: Asset) =>
      describe(a).pipe(
        Effect.flatMap((d) => Deferred.await(d).pipe(Effect.timeoutOption(o.settings.captionWait))),
        Effect.map(Option.getOrElse(() => NOT_DESCRIBED)),
      );
    const captionNow = (a: Asset) => ready.get(a.sha) ?? null;

    const ingest = (bytes: Uint8Array, tier: Tier) =>
      Effect.gen(function* () {
        if (bytes.length === 0) return yield* new MediaError({ message: "the upload is empty", status: 400 });
        const what = sniff(bytes);
        if (what === null) return yield* new MediaError({ message: "not an image or video this server takes (JPEG, PNG, WebP, GIF; MP4, MOV, WebM)", status: 415 });
        const limit = what.kind === "image" ? o.settings.maxImageBytes : o.settings.maxVideoBytes;
        if (bytes.length > limit) return yield* new MediaError({ message: `the ${what.kind} is ${bytes.length} bytes; at most ${limit} are taken`, status: 413 });
        const asset: Asset = what.kind === "image" ? yield* keepImage(bytes, TIERS[tier]) : yield* ingestVideo(bytes, what.mime);
        yield* describe(asset);
        return asset;
      });

    const parts = (a: Asset): Part[] => {
      const missing = `(${a.kind} ${shortSha(a.sha)} is missing from the asset store)`;
      if (a.kind === "image") return [picture(a) ?? missing];
      const out: Part[] = [];
      for (const f of a.frames) {
        const img = imageById(f.sha);
        const pic = img && picture(img);
        out.push(`video ${shortSha(a.sha)} at ${clock(f.t)}:`, pic ?? missing);
      }
      out.push(a.transcript === null ? `video ${shortSha(a.sha)}: no transcript${a.notice ? ` (${a.notice})` : ""}` : `video ${shortSha(a.sha)} transcript: ${a.transcript}`);
      return out;
    };

    const zoomContent = (text: string): McpContent[] =>
      splitMarkers(text)
        .markers.slice(0, MAX_ZOOM)
        .flatMap((m): McpContent[] => {
          const a = store.find(m.sha);
          const shown = a && shownOf(a);
          if (a === null || shown === null) return [{ text: `(${m.kind} ${m.sha} is missing from the asset store)`, type: "text" }];
          const pic: McpContent = { data: shown.data, mimeType: shown.mime, type: "image" };
          if (a.kind === "image") return [pic];
          const heard = a.transcript === null ? `no transcript${a.notice ? ` (${a.notice})` : ""}` : `transcript: ${a.transcript}`;
          return [{ text: `video ${m.sha}: ${a.frames.length} frames over ${Math.round(a.duration)} s, shown as one sheet; ${heard}`, type: "text" }, pic];
        });

    return { caption, captionNow, find: store.find, ingest, parts, store, zoomContent };
  });

