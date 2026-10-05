// Media in (SPEC "Media"): what an upload becomes in the asset store. A big phone photo with EXIF
// and GPS is turned upright, downscaled and stored without its metadata; a file whose bytes are
// not an image is refused whatever it claims; the same upload twice is one asset; a video becomes
// frames at their times, a contact sheet and (with a local whisper) a transcript, and is stored
// without its location. Markers: the grammar the log, the web UI and zoom read.
import { afterAll, expect, test } from "bun:test";
import { Effect } from "effect";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { mediaSettings, NODE, parseSettings } from "../src/config.ts";
import { MediaError } from "../src/media/image.ts";
import { makeMedia } from "../src/media/media.ts";
import { textOnly } from "../src/media/part.ts";
import { sniff } from "../src/media/sniff.ts";
import { extract, frameTimes } from "../src/media/video.ts";
import { type Asset, CAPTION_MAX, cleanCaption, markerOf, splitMarkers, withMarkers } from "../src/wire.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});
const fresh = () => {
  const d = mkdtempSync(`${tmpdir()}/oc-media-`);
  dirs.push(d);
  return d;
};

const BASE = {
  allowedLogins: [],
  cache: { apiKeyTtls: ["5m"], claudeCodeTtl: "1h", primeTtl: "1h" },
  compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
  defaultDevice: "mini",
  devices: { mini: { folders: ["/tmp"], url: "http://127.0.0.1:1" } },
  master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
} as const;
type MediaConfig = NonNullable<Parameters<typeof parseSettings>[0]["media"]>;
const settingsWith = (media: MediaConfig = {}) => mediaSettings(parseSettings({ ...BASE, media }));

// the media service on a fresh asset store, no captions
const withMedia = async <A, E>(f: (m: Effect.Success<ReturnType<typeof makeMedia>>, root: string) => Effect.Effect<A, E>, media: MediaConfig = {}) => {
  const root = `${fresh()}/assets`;
  return Effect.runPromise(
    Effect.gen(function* () {
      const m = yield* makeMedia({ captioner: null, report: () => Effect.void, root, settings: settingsWith(media) });
      return yield* f(m, root);
    }).pipe(Effect.scoped),
  );
};

// a 3000x2000 landscape photo whose EXIF says "rotate 90° clockwise", with a camera and a place
const phonePhoto = async () =>
  sharp({ create: { background: { b: 40, g: 120, r: 200 }, channels: 3, height: 2000, width: 3000 } })
    .png()
    .withExif({ IFD0: { Make: "PhoneCo", Model: "P1" }, IFD3: { GPSLatitude: "52/1 13/1 0/1", GPSLatitudeRef: "N" } })
    .withMetadata({ orientation: 6 })
    .toBuffer();

const files = (root: string) => readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);

test("a big PNG with EXIF becomes an upright JPEG on the standard tier's long edge, with no metadata; high detail keeps more", async () => {
  const photo = new Uint8Array(await phonePhoto());
  const before = await sharp(photo).metadata();
  expect(before.exif).toBeDefined();
  const { file, high, standard } = await withMedia((m) =>
    Effect.gen(function* () {
      const s = yield* m.ingest(photo, "standard");
      const h = yield* m.ingest(photo, "high");
      return { file: s.kind === "image" ? m.store.file(s) : null, high: h, standard: s };
    }),
  );
  // turned upright first (2000 wide, 3000 tall), then 1568 on the long edge
  expect(standard).toMatchObject({ height: 1568, kind: "image", mime: "image/jpeg", width: 1045 });
  expect(high).toMatchObject({ height: 2576, width: 1717 });
  // the high tier past 2000 px keeps its standard-tier copy too, as an image of its own
  expect(standard.kind === "image" ? standard.small : "video").toBeUndefined();
  expect(high.kind === "image" ? high.small : undefined).toBe(standard.sha);
  const stored = readFileSync(file?.path ?? "");
  expect(standard.bytes).toBe(stored.length);
  const meta = await sharp(stored).metadata();
  expect(meta).toMatchObject({ format: "jpeg", height: 1568, width: 1045 });
  expect(meta.exif).toBeUndefined();
  expect(meta.orientation).toBeUndefined();
  expect(meta.icc).toBeUndefined();
  expect(stored.includes("PhoneCo")).toBe(false);
});

test("the real type is read from the bytes: a disguised file is refused, and so is anything too big or empty", async () => {
  const png = await sharp({ create: { background: "#fff", channels: 3, height: 10, width: 10 } }).png().toBuffer();
  expect(sniff(png)).toEqual({ kind: "image", mime: "image/png" });
  expect(sniff(Buffer.from("GIF89a..."))).toEqual({ kind: "image", mime: "image/gif" });
  expect(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toEqual({ kind: "image", mime: "image/webp" });
  expect(sniff(Buffer.from("\0\0\0\u0018ftypqt  \0\0\0\0"))).toEqual({ kind: "video", mime: "video/quicktime" });
  expect(sniff(Buffer.from("\0\0\0\u0018ftypisom\0\0\0\0"))).toEqual({ kind: "video", mime: "video/mp4" });
  // an iPhone's HEIC is a still image in the same box format
  expect(sniff(Buffer.from("\0\0\0\u0018ftypheic\0\0\0\0"))).toBeNull();
  // a script saved as photo.png, an SVG (it can carry script), a PDF
  const refused = await withMedia((m) =>
    Effect.forEach(
      [
        Buffer.from("#!/bin/sh\nrm -rf ~\n"),
        Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
        Buffer.from("%PDF-1.7\n"),
        Buffer.alloc(0),
        // the right magic bytes and nothing after them
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3]),
        png,
      ],
      (bytes) => m.ingest(new Uint8Array(bytes), "standard").pipe(Effect.flip, Effect.map((e: MediaError) => e.status)),
    ),
    { maxImageBytes: 50 },
  );
  expect(png.length).toBeGreaterThan(50);
  expect(refused).toEqual([415, 415, 415, 400, 422, 413]);
});

test("the same upload twice is one asset; the store holds the bytes and their metadata, nothing half-written", async () => {
  const png = await sharp({ create: { background: { alpha: 0.5, b: 255, g: 136, r: 0 }, channels: 4, height: 300, width: 400 } }).png().toBuffer();
  const { first, found, second, root } = await withMedia((m, root) =>
    Effect.gen(function* () {
      const a = yield* m.ingest(new Uint8Array(png), "standard");
      const b = yield* m.ingest(new Uint8Array(png), "standard");
      return { first: a, found: m.find(a.sha.slice(0, 12)), root, second: b };
    }),
  );
  expect(second).toEqual(first);
  // transparency is kept, as WebP
  expect(first).toMatchObject({ height: 300, kind: "image", mime: "image/webp", width: 400 });
  expect(files(root).toSorted()).toEqual([`${first.sha}.json`, `${first.sha}.webp`]);
  expect(readdirSync(root)).toEqual([first.sha.slice(0, 2)]);
  // a 12-character prefix finds it, as a marker names it
  expect(found).toEqual(first);
  // no temporary file is left behind
  expect(files(root).some((f) => f.endsWith(".tmp"))).toBe(false);
});

const makeVideo = (dir: string, seconds: number) => {
  const out = `${dir}/clip.mp4`;
  const r = Bun.spawnSync([
    "ffmpeg", "-v", "error", "-y",
    "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=1280x720:rate=10`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "mpeg4", "-c:a", "aac", "-shortest",
    "-metadata", "location=+52.2297+021.0122/",
    out,
  ]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return new Uint8Array(readFileSync(out));
};

test("a video becomes frames every 2 s at 768 px, a contact sheet and no location; its audio is transcribed only by a local whisper", async () => {
  const dir = fresh();
  const clip = makeVideo(dir, 5);
  const plain = await withMedia((m) => m.ingest(clip, "standard"));
  if (plain.kind !== "video") throw new Error("not a video");
  expect(plain.frames.map((f) => f.t)).toEqual([0, 2, 4]);
  expect(plain.frames.map((f) => [f.width, f.height])).toEqual([[768, 432], [768, 432], [768, 432]]);
  expect(plain).toMatchObject({ height: 720, mime: "video/mp4", notice: "audio not transcribed: no local whisper is configured (media.whisper)", transcript: null, width: 1280 });
  expect(Math.round(plain.duration)).toBe(5);

  // a "whisper" that prints what it was given: the 16 kHz WAV's path
  const whisper = `${dir}/whisper.sh`;
  writeFileSync(whisper, '#!/bin/sh\necho "heard $(basename "$1")"\n');
  chmodSync(whisper, 0o755);
  const { heard, root, stored } = await withMedia(
    (m, root) =>
      Effect.gen(function* () {
        const v = yield* m.ingest(clip, "standard");
        const again = yield* m.ingest(clip, "standard");
        expect(again).toEqual(v);
        const file = v.kind === "video" ? m.store.file(v) : null;
        const sheet = v.kind === "video" ? m.find(v.sheet) : null;
        return { heard: v, root, stored: { file, parts: textOnly(m.parts(v, { how: "all" }, false)), sheet } };
      }),
    { whisper: [whisper] },
  );
  if (heard.kind !== "video") throw new Error("not a video");
  expect(heard.transcript).toBe("heard audio.wav");
  expect(heard.notice).toBeNull();
  // the stored clip has the streams and no location
  const tags = Bun.spawnSync(["ffprobe", "-v", "error", "-show_format", "-show_streams", stored.file?.path ?? ""]).stdout.toString();
  expect(tags).toContain("codec_type=video");
  expect(tags).toContain("codec_type=audio");
  expect(tags).not.toContain("TAG:location");
  expect(tags).not.toContain("52.2297");
  expect(stored.sheet).toMatchObject({ kind: "image", mime: "image/jpeg" });
  // three frames, a sheet and the clip, each with its metadata
  expect(files(root).filter((f) => f.endsWith(".json"))).toHaveLength(5);
  const sha12 = heard.sha.slice(0, 12);
  expect(stored.parts).toEqual([`video ${sha12} at 0:00:`, `video ${sha12} at 0:02:`, `video ${sha12} at 0:04:`, `video ${sha12} transcript: heard audio.wav`]);
  // a clip over the limit is refused
  const long = await withMedia((m) => m.ingest(clip, "standard").pipe(Effect.flip), { maxVideoSeconds: 3 });
  expect(long.status).toBe(413);
});

test("frames: one per 2 s, at most 24, spread over a longer clip", () => {
  expect(frameTimes(1)).toEqual({ count: 1, step: 2 });
  expect(frameTimes(47)).toEqual({ count: 24, step: 2 });
  expect(frameTimes(120)).toEqual({ count: 24, step: 5 });
});

test("markers: one line per attachment after the typed text, read back the same, short enough for a node", () => {
  const image: Asset = { bytes: 217_000, height: 1176, kind: "image", mime: "image/jpeg", sha: "9d0c38e7aafe062c".padEnd(64, "0"), width: 1568 };
  const video: Asset = {
    bytes: 1,
    duration: 46.6,
    frames: Array.from({ length: 24 }, (_, k) => ({ height: 432, sha: "f".repeat(64), t: k * 2, width: 768 })),
    height: 720,
    kind: "video",
    mime: "video/mp4",
    notice: null,
    sha: "ab".repeat(32),
    sheet: "c".repeat(64),
    transcript: null,
    width: 1280,
  };
  const a = markerOf(image, "a whiteboard: [Queue] -> [Turn]\nthree arrows");
  expect(a).toBe("[image 9d0c38e7aafe 1568x1176 212KB: a whiteboard: (Queue) -> (Turn) three arrows]");
  expect(markerOf(video, "a cat jumps")).toBe("[video abababababab 47s, 24 frames: a cat jumps]");
  const text = withMarkers("look at these\n[not a marker]", [a, markerOf(video, "a cat jumps")]);
  const split = splitMarkers(text);
  expect(split.body).toBe("look at these\n[not a marker]");
  expect(split.markers.map((m) => [m.kind, m.sha])).toEqual([
    ["image", "9d0c38e7aafe"],
    ["video", "abababababab"],
  ]);
  expect(withMarkers("  ", [a])).toBe(a);
  expect(splitMarkers("just text").markers).toEqual([]);
});

// the size of a message of four of these markers
const fourBytes = (marker: string) => Buffer.byteLength(`user: look\n${[marker, marker, marker, marker].join("\n")}`);

test("a caption is cut by code points under a byte cap, never inside a surrogate pair; what that makes of a marker's size", () => {
  const long = cleanCaption("x".repeat(500));
  expect(Buffer.byteLength(long)).toBe(CAPTION_MAX);
  expect(long).toBe(`${"x".repeat(CAPTION_MAX - 3)}…`);
  // 4 bytes each: 29 fit beside the ellipsis, and the 30th is not cut in half
  const emoji = cleanCaption("😀".repeat(100));
  expect(emoji).toBe(`${"😀".repeat(29)}…`);
  expect(emoji.isWellFormed()).toBe(true);
  expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(CAPTION_MAX);
  // an odd boundary: 2-byte letters, then a 4-byte one that would straddle the cap
  const mixed = cleanCaption(`${"ł".repeat(58)}😀😀`);
  expect(mixed.isWellFormed()).toBe(true);
  expect(Buffer.byteLength(mixed)).toBeLessThanOrEqual(CAPTION_MAX);
  // short ones are left alone, flattened and bracket-free; nothing is "not described"
  expect(cleanCaption("  a [red]\n square  ")).toBe("a (red) square");
  expect(cleanCaption("ł".repeat(60))).toBe("ł".repeat(60));
  expect(cleanCaption(" \n ")).toBe("(not described)");

  // The size of a marker: its words and the caption, so at most ~160 bytes. One with the text
  // beside it is well inside a node (NODE bytes); four with captions of a typical length fit
  // with room for text; four with the longest captions do not (the compactor then sees the
  // message, and keeps its shas: test/vision.test.ts).
  const image: Asset = { bytes: 31_000_000, height: 2576, kind: "image", mime: "image/jpeg", sha: "9d0c38e7aafe062c".padEnd(64, "0"), width: 2576 };
  const biggest = markerOf(image, "x".repeat(500));
  expect(Buffer.byteLength(biggest)).toBeLessThanOrEqual(160);
  expect(Buffer.byteLength(`user: look\n${biggest}`)).toBeLessThan(NODE);
  const typical = markerOf(image, "a whiteboard with three arrows and a queue");
  expect(fourBytes(typical)).toBeLessThan(NODE - 100);
  expect(fourBytes(biggest)).toBeGreaterThan(NODE);
});

// ---------------------------------------------------------------------------------------------
// a stranger's bytes: every ffmpeg call is bounded (SPEC "Media", Video)

const script = (dir: string, name: string, body: string) => {
  const path = `${dir}/${name}`;
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
// the right first bytes and nothing else: sniffed as MP4, a video to nothing that reads it
const HEAD = Buffer.from("\0\0\0\u0018ftypisom\0\0\0\0isomiso2");

test("a truncated clip, garbage behind an MP4 header and bytes of another container fail cleanly, and fast", async () => {
  const dir = fresh();
  const clip = makeVideo(dir, 5);
  const webm = `${dir}/clip.webm`;
  const made = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-i", `${dir}/clip.mp4`, "-an", "-c:v", "libvpx", "-t", "1", webm]);
  const matroska = made.exitCode === 0 ? new Uint8Array(readFileSync(webm)) : null;
  const started = Date.now();
  const refused = await withMedia((m) =>
    Effect.forEach(
      [
        clip.slice(0, Math.floor(clip.length / 3)), // the moov atom is at the end: gone
        new Uint8Array(Buffer.concat([HEAD, Buffer.from("this is not a video at all, only text ".repeat(50))])),
        new Uint8Array(Buffer.concat([HEAD, Buffer.from("#EXTM3U\n#EXTINF:1,\nhttp://127.0.0.1:1/a.ts\n")])), // a playlist behind a header
      ],
      (bytes) => m.ingest(bytes, "standard").pipe(Effect.flip, Effect.map((e: MediaError) => [e.status, e.message])),
    ),
  );
  expect(Date.now() - started).toBeLessThan(15_000);
  for (const [status, message] of refused) {
    expect(status).toBe(422);
    expect(message).toContain("cannot read the video");
  }
  // the demuxer is the sniffed type's, not the one ffmpeg would guess: a WebM read as MP4 fails
  if (matroska !== null) {
    const tools = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", limit: 30, whisper: null };
    const wrong = await Effect.runPromise(extract(tools, matroska, "video/mp4", 180).pipe(Effect.flip));
    expect(wrong.status).toBe(422);
    const right = await Effect.runPromise(extract(tools, matroska, "video/webm", 180));
    expect(right.frames.length).toBeGreaterThan(0);
  }
});

test("a call that runs past its time is killed and the upload is refused; at most two are worked on at once", async () => {
  const dir = fresh();
  // a ffprobe that never answers, and one that notes when it starts and ends
  const hang = script(dir, "hang.sh", "exec sleep 30");
  const log = `${dir}/probes.log`;
  const slow = script(dir, "slow.sh", `echo s >> ${log}\nsleep 0.3\necho e >> ${log}\nexit 1`);
  const started = Date.now();
  const timedOut = await withMedia((m) => m.ingest(new Uint8Array(HEAD), "standard").pipe(Effect.flip), { ffprobe: hang, toolSeconds: 0.4 });
  expect(timedOut.status).toBe(422);
  expect(timedOut.message).toContain("took longer");
  expect(Date.now() - started).toBeLessThan(5000);

  await withMedia((m) => Effect.forEach([1, 2, 3, 4, 5], () => m.ingest(new Uint8Array(HEAD), "standard").pipe(Effect.flip), { concurrency: "unbounded" }), { ffprobe: slow });
  let running = 0;
  let most = 0;
  for (const line of readFileSync(log, "utf8").trim().split("\n")) {
    running += line === "s" ? 1 : -1;
    most = Math.max(most, running);
  }
  expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(10);
  expect(most).toBe(2);
});

test("every ffmpeg and ffprobe call reads the file protocol only, with the sniffed demuxer, and at most maxVideoSeconds; a video past ~8K is refused", async () => {
  const dir = fresh();
  const clip = makeVideo(dir, 3);
  const log = `${dir}/calls.log`;
  const ffmpeg = script(dir, "ffmpeg.sh", `echo "$@" >> ${log}\nexec ffmpeg "$@"`);
  const ffprobe = script(dir, "ffprobe.sh", `echo "$@" >> ${log}\nexec ffprobe "$@"`);
  const whisper = script(dir, "whisper.sh", 'echo "words"');
  const asset = await withMedia((m) => m.ingest(clip, "standard"), { ffmpeg, ffprobe, maxVideoSeconds: 90, whisper: [whisper] });
  expect(asset.kind).toBe("video");
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls).toHaveLength(4); // probe, copy, frames, audio
  for (const call of calls) {
    expect(call).toContain("-protocol_whitelist file");
    expect(call).toContain("-f mov");
  }
  for (const call of calls.slice(1)) expect(call).toContain("-t 90");

  // 9000 px wide
  const wide = `${dir}/wide.mov`;
  const made = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=9000x16:rate=2", "-an", "-c:v", "mjpeg", wide]);
  expect(made.exitCode).toBe(0);
  const refused = await withMedia((m) => m.ingest(new Uint8Array(readFileSync(wide)), "standard").pipe(Effect.flip));
  expect(refused.status).toBe(413);
  expect(refused.message).toContain("9000x16");
});

test("an upload no logged message names is left out of the commits; what a message names, a frame, a sheet and a standard-tier copy included, is not", async () => {
  const dir = fresh();
  const clip = makeVideo(dir, 3);
  const photo = await sharp({ create: { background: "#c33", channels: 3, height: 2000, width: 3000 } }).png().toBuffer();
  const other = await sharp({ create: { background: "#3c3", channels: 3, height: 200, width: 300 } }).png().toBuffer();
  const { named, stray, store } = await withMedia(
    (m) =>
      Effect.gen(function* () {
        const video = yield* m.ingest(clip, "standard");
        const high = yield* m.ingest(new Uint8Array(photo), "high");
        const never = yield* m.ingest(new Uint8Array(other), "standard");
        const texts = [`look\n${markerOf(video, "a clip")}\n${markerOf(high, "a field")}`, "no marker here"];
        return { named: m.unreferenced(texts), stray: never, store: { high, video } };
      }),
    {},
  );
  // only the picture nobody sent: its bytes and its metadata
  expect(named.toSorted()).toEqual([`${stray.sha.slice(0, 2)}/${stray.sha}.jpg`, `${stray.sha.slice(0, 2)}/${stray.sha}.json`].toSorted());
  expect(store.high.kind === "image" && store.high.small !== undefined).toBe(true);
});
