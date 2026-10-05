// The media service (SPEC "Media"): an upload in, a stored asset out (./assets.ts), its caption
// started at once in the background, and what each reader of an attachment needs: the engines
// its pictures (./part.ts), the log its marker line (wire.ts markerOf), zoom its MCP content.
import { Deferred, Effect, Option, type Scope, Semaphore } from "effect";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { MediaSettings } from "../config.ts";
import type { Content } from "../mcp.ts";
import { type Asset, type ImageAsset, NOT_DESCRIBED, shortSha, splitMarkers, type VideoAsset } from "../wire.ts";
import { type AssetStore, assetStore, sha256 } from "./assets.ts";
import type { Captioner } from "./caption.ts";
import { type Look, MAX_ZOOM, thin, WIDE_EDGE } from "./budget.ts";
import { contactSheet, MediaError, normalizeImage, type Tier, TIERS } from "./image.ts";
import type { Part, Picture } from "./part.ts";
import { sniff } from "./sniff.ts";
import { clock, extract, FRAME_EDGE } from "./video.ts";


export type Media = {
  readonly store: AssetStore;
  // an upload's bytes to a stored asset; the same bytes give the same asset
  readonly ingest: (bytes: Uint8Array, tier: Tier) => Effect.Effect<Asset, MediaError>;
  readonly find: (id: string) => Asset | null;
  // the attachment's caption, waited for at most `captionWait`; "(not described)" when none came
  readonly caption: (a: Asset) => Effect.Effect<string>;
  // what an engine is sent of it, as budget.ts decided (`look`, `capped`): its picture, or a video's
  // frames with their times, or its sheet, and its transcript; each picture after a line naming it
  readonly parts: (a: Asset, look: Look, capped: boolean) => Part[];
  // zoom(id, 1) on a message: the pictures of its attachments (at most MAX_ZOOM), each at most 2000 px
  readonly zoomContent: (text: string) => Content[];
  // the stored files (paths under `root`, "ab/<sha>.<ext>") that no message of these logged texts
  // names, directly or as a video's frame or sheet, or an image's standard-tier copy
  readonly unreferenced: (texts: Iterable<string>) => string[];
};

// uploads worked on at once: each holds its bytes and may run ffmpeg
const INGESTS = 2;

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
    const tools = { ffmpeg: o.settings.ffmpeg, ffprobe: o.settings.ffprobe, limit: o.settings.toolSeconds, whisper: o.settings.whisper, whisperLimit: o.settings.whisperSeconds };

    const picture = (a: ImageAsset): Picture | null => {
      const file = store.file(a);
      return file ? { data: base64(file.path), mime: a.mime, type: "image" } : null;
    };
    const imageById = (sha: string) => {
      const a = store.find(sha);
      return a?.kind === "image" ? a : null;
    };
    // the standard-tier copy of a high-detail image, else the image
    const smaller = (a: ImageAsset) => (a.small === undefined ? a : (imageById(a.small) ?? a));
    // the one picture that shows an asset, at most 2000 px: the image, or a video's contact sheet
    const shownOf = (a: Asset) => {
      const img = a.kind === "image" ? smaller(a) : imageById(a.sheet);
      return img && picture(img);
    };

    // An image's normalized bytes stored, with its metadata; they come back too, for what is made
    // of them next. One past 2000 px keeps its standard-tier copy as well (budget.ts).
    const keepImage = (bytes: Uint8Array, edge: number, quality?: number): Effect.Effect<{ readonly asset: ImageAsset; readonly data: Uint8Array }, MediaError> =>
      Effect.gen(function* () {
        const n = yield* normalizeImage(bytes, edge, quality);
        const small = Math.max(n.width, n.height) > WIDE_EDGE ? yield* keepImage(bytes, TIERS.standard, quality) : null;
        const { sha } = yield* io("cannot store the image", () => store.put(n.data, n.mime));
        const plain: ImageAsset = { bytes: n.data.length, height: n.height, kind: "image", mime: n.mime, sha, width: n.width };
        const asset: ImageAsset = small === null ? plain : { ...plain, small: small.asset.sha };
        yield* io("cannot store the image", () => {
          store.putMeta(asset);
        });
        return { asset, data: n.data };
      });

    const ingestVideo = (bytes: Uint8Array, mime: VideoAsset["mime"]) =>
      Effect.gen(function* () {
        const x = yield* extract(tools, bytes, mime, o.settings.maxVideoSeconds);
        const sha = sha256(x.clean);
        const known = store.find(sha);
        if (known) return known;
        const kept = yield* Effect.forEach(x.frames, (f) => keepImage(f.data, FRAME_EDGE, 80).pipe(Effect.map(({ asset, data }) => ({ asset, data, t: f.t }))));
        const frames = kept.map((f) => ({ ...f.asset, t: f.t }));
        const sheet = yield* contactSheet(kept, clock);
        const stored = yield* io("cannot store the video", () => {
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
          sheet: stored.sha,
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
    // The map is read and written in one synchronous step, so two callers never start two calls.
    const describe = (a: Asset) =>
      Effect.suspend(() => {
        const known = captions.get(a.sha);
        if (known) return Effect.succeed(known);
        const done = Deferred.makeUnsafe<string>();
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
        return job.pipe(
          Effect.flatMap((c) => Deferred.succeed(done, c)),
          Effect.forkIn(scope),
          Effect.as(done),
        );
      });

    const caption = (a: Asset) =>
      describe(a).pipe(
        Effect.flatMap((d) => Deferred.await(d).pipe(Effect.timeoutOption(o.settings.captionWait))),
        Effect.map(Option.getOrElse(() => NOT_DESCRIBED)),
      );

    // uploads are worked on a few at a time
    const gate = yield* Semaphore.make(INGESTS);
    const ingest = (bytes: Uint8Array, tier: Tier) =>
      gate.withPermits(1)(
        Effect.gen(function* () {
          if (bytes.length === 0) return yield* new MediaError({ message: "the upload is empty", status: 400 });
          const what = sniff(bytes);
          if (what === null) return yield* new MediaError({ message: "not an image or video this server takes (JPEG, PNG, WebP, GIF; MP4, MOV, WebM)", status: 415 });
          const limit = what.kind === "image" ? o.settings.maxImageBytes : o.settings.maxVideoBytes;
          if (bytes.length > limit) return yield* new MediaError({ message: `the ${what.kind} is ${bytes.length} bytes; at most ${limit} are taken`, status: 413 });
          const asset: Asset = what.kind === "image" ? (yield* keepImage(bytes, TIERS[tier])).asset : yield* ingestVideo(bytes, what.mime);
          yield* describe(asset);
          return asset;
        }),
      );

    // what is sent of an asset, as budget.ts planned it
    const parts = (a: Asset, look: Look, capped: boolean): Part[] => {
      const id = shortSha(a.sha);
      const missing = `(${a.kind} ${id} is missing from the asset store)`;
      const pictured = (label: string, img: ImageAsset | null): Part[] => {
        const pic = img && picture(img);
        return pic ? [label, pic] : [missing];
      };
      if (a.kind === "image") {
        if (look.how === "none") return [`image ${id}: (not sent: this request already holds as many pictures as it can; zoom shows it)`];
        return pictured(`image ${id}:`, capped ? smaller(a) : a);
      }
      const out: Part[] = [];
      switch (look.how) {
        case "none":
          out.push(`video ${id}: (frames not sent: this request already holds as many pictures as it can; zoom shows its sheet)`);
          break;
        case "sheet":
          out.push(...pictured(`video ${id}, its frames as one sheet, each with its time:`, imageById(a.sheet)));
          break;
        case "all":
        case "frames":
          for (const f of look.how === "all" ? a.frames : thin(a.frames, look.keep)) out.push(...pictured(`video ${id} at ${clock(f.t)}:`, imageById(f.sha)));
          break;
      }
      out.push(a.transcript === null ? `video ${id}: no transcript${a.notice ? ` (${a.notice})` : ""}` : `video ${id} transcript: ${a.transcript}`);
      return out;
    };

    // The shas a logged text names, an asset's own with those it is made of. An asset is looked up
    // once: it never changes under its name.
    const made = new Map<string, readonly string[]>();
    const madeOf = (id: string) => {
      const known = made.get(id);
      if (known) return known;
      const a = store.find(id);
      if (a === null) return [];
      const shas = [a.sha, ...(a.kind === "video" ? [a.sheet, ...a.frames.map((f) => f.sha)] : a.small === undefined ? [] : [a.small])];
      made.set(id, shas);
      return shas;
    };
    // Rescans every user entry and lists assets/ on each commit: linear in both, fine for one person's chat.
    const unreferenced = (texts: Iterable<string>) => {
      const named = new Set<string>();
      for (const text of texts) if (text.endsWith("]")) for (const m of splitMarkers(text).markers) for (const sha of madeOf(m.sha)) named.add(sha);
      if (!existsSync(o.root)) return [];
      return readdirSync(o.root, { recursive: true })
        .map(String)
        .filter((path) => !path.includes(".tmp") && /\/[0-9a-f]{64}\./.test(path) && !named.has(path.slice(path.lastIndexOf("/") + 1).split(".")[0] ?? ""));
    };

    const zoomContent = (text: string): Content[] =>
      splitMarkers(text)
        .markers.slice(0, MAX_ZOOM)
        .flatMap((m): Content[] => {
          const a = store.find(m.sha);
          const shown = a && shownOf(a);
          if (a === null || shown === null) return [{ text: `(${m.kind} ${m.sha} is missing from the asset store)`, type: "text" }];
          const pic: Content = { data: shown.data, mimeType: shown.mime, type: "image" };
          if (a.kind === "image") return [pic];
          const heard = a.transcript === null ? `no transcript${a.notice ? ` (${a.notice})` : ""}` : `transcript: ${a.transcript}`;
          return [{ text: `video ${m.sha}: ${a.frames.length} frames over ${Math.round(a.duration)} s, shown as one sheet; ${heard}`, type: "text" }, pic];
        });

    return { caption, find: store.find, ingest, parts, store, unreferenced, zoomContent };
  });

