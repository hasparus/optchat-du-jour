// The pictures of one request (SPEC "Media", src/media/budget.ts): at most 100, and over 20 of
// them each at most 2000 px. A video is thinned to fewer frames first, then shown as its sheet,
// then left to its marker; a high-detail image goes at its standard-tier size once the request
// could pass 20. Planned for the opening message and each mid-run message of one call, in one place.
import { afterAll, expect, test } from "bun:test";
import { Effect, PubSub } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { openChat } from "../src/chat.ts";
import { FEW_IMAGES, MAX_IMAGES, MIN_FRAMES, pictureBudget, thin, WIDE_EDGE, ZOOM_RESERVE } from "../src/media/budget.ts";
import { mediaSettings, parseSettings } from "../src/config.ts";
import { makeMedia } from "../src/media/media.ts";
import { isPicture, type Part, textOnly } from "../src/media/part.ts";
import { makeSession, type SessionEvent } from "../src/session.ts";
import type { Mid, TurnEngine, TurnInput } from "../src/turn/engine.ts";
import type { Asset, ImageAsset, VideoAsset } from "../src/wire.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { force: true, recursive: true });
});
const fresh = () => {
  const d = mkdtempSync(`${tmpdir()}/oc-budget-`);
  dirs.push(d);
  return d;
};

const sha = (n: number) => n.toString(16).padStart(64, "0");
const still = (n: number, edge = 1568): ImageAsset => ({ bytes: 1000, height: edge, kind: "image", mime: "image/jpeg", sha: sha(n), width: edge });
const clip = (n: number, frames = 24): VideoAsset => ({
  bytes: 1,
  duration: frames * 2,
  frames: Array.from({ length: frames }, (_, k) => ({ height: 432, sha: sha(1000 * n + k + 1), t: k * 2, width: 768 })),
  height: 720,
  kind: "video",
  mime: "video/mp4",
  notice: null,
  sha: sha(n),
  sheet: sha(1000 * n),
  transcript: null,
  width: 1280,
});
const kept = (a: readonly Asset[], budget = pictureBudget()) => {
  const { capped, looks } = budget.take(a);
  return { capped, looks: looks.map((l) => (l.how === "frames" ? l.keep : l.how)) };
};
const ROOM = MAX_IMAGES - ZOOM_RESERVE;

test("a few pictures go whole; a high-detail one is capped once the request could pass 20", () => {
  // one 2576 px image, and the 8 zoom may add, are under 20: it goes as it is
  expect(kept([still(1, 2576)])).toEqual({ capped: false, looks: ["all"] });
  // 13 images and the reserve pass 20: every image goes at 2000 px or less
  const many = kept(Array.from({ length: FEW_IMAGES - ZOOM_RESERVE + 1 }, (_, k) => still(k)));
  expect(many.capped).toBe(true);
  expect(many.looks.every((l) => l === "all")).toBe(true);
  // a wide picture already sent keeps the request at 20: a later batch is squeezed to what is left
  const budget = pictureBudget();
  expect(kept([still(1, 2576)], budget).capped).toBe(false);
  const later = kept(Array.from({ length: 14 }, (_, k) => still(10 + k)), budget);
  expect(later.capped).toBe(true);
  expect(later.looks.filter((l) => l === "all")).toHaveLength(FEW_IMAGES - ZOOM_RESERVE - 1);
  expect(later.looks.filter((l) => l === "none")).toHaveLength(14 - (FEW_IMAGES - ZOOM_RESERVE - 1));
});

test("four videos and a high-detail image: the frames are thinned to fit 100 images with zoom's share left", () => {
  const assets = [still(1, 2576), clip(1), clip(2), clip(3), clip(4)];
  const plan = kept(assets);
  expect(plan.capped).toBe(true);
  // 92 left for 1 + 4 × 24: the videos share the other 91, 22 or 23 frames each
  expect(plan.looks).toEqual(["all", 22, 23, 23, 23]);
  // a short clip keeps all its frames and leaves its share to the others
  expect(kept([clip(1, 6), clip(2), clip(3), clip(4), clip(5), clip(6)]).looks).toEqual(["all", 17, 17, 17, 17, 18]);
});

test("too many videos to thin: each is its sheet, then the rest are markers only", () => {
  // 25 videos share 92: 3 frames each is under MIN_FRAMES, so sheets
  expect(MIN_FRAMES).toBe(4);
  expect(kept(Array.from({ length: 25 }, (_, k) => clip(k + 1))).looks).toEqual(Array.from({ length: 25 }, () => "sheet"));
  const crowd = kept(Array.from({ length: ROOM + 3 }, (_, k) => clip(k + 1)));
  expect(crowd.looks.filter((l) => l === "sheet")).toHaveLength(ROOM);
  expect(crowd.looks.slice(ROOM)).toEqual(["none", "none", "none"]);
});

test("mid-run messages are planned against what the request holds already", () => {
  const budget = pictureBudget();
  expect(kept([still(1), clip(1), clip(2), clip(3)], budget).looks).toEqual(["all", "all", "all", "all"]); // 73 pictures
  // 19 left of 92: a video is thinned to them
  expect(kept([clip(4)], budget).looks).toEqual([19]);
  // none left: markers only
  expect(kept([still(2), clip(5)], budget).looks).toEqual(["none", "none"]);
});

test("frames are thinned evenly, the first and last kept", () => {
  const times = Array.from({ length: 24 }, (_, k) => k * 2);
  expect(thin(times, 24)).toEqual(times);
  expect(thin(times, 4)).toEqual([0, 16, 30, 46]);
  expect(thin(times, 1)).toEqual([0]);
  expect(thin(times, 30)).toEqual(times);
});

// ---------------------------------------------------------------------------------------------
// end to end: the real media service, a session, an engine that sees

const makeVideo = (dir: string, n: number, seconds: number) => {
  const out = `${dir}/clip${n}.mp4`;
  const r = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=${160 + 16 * n}x120:rate=2`, "-an", "-c:v", "mpeg4", out]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return new Uint8Array(readFileSync(out));
};
// what the engine under test was given
type Seen = { opening: TurnInput | null };
const pictures = (parts: readonly Part[]) => parts.filter(isPicture);
// the widths of the pictures among these parts
const widths = async (parts: readonly Part[]) =>
  Promise.all(
    pictures(parts).map(async (p) => {
      const meta = await sharp(Buffer.from(p.data, "base64")).metadata();
      return meta.width;
    }),
  );
const until = (what: string, ok: () => boolean, ms = 20_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > deadline) yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("10 millis");
    }
  });

test("a turn's pictures: three videos and a high-detail image in the opening, a fourth video mid-run; none over 2000 px, 100 at most, each labelled", async () => {
  const dir = fresh();
  const settings = mediaSettings(
    parseSettings({
      allowedLogins: [],
      cache: { apiKeyTtls: ["1h"], claudeCodeTtl: "1h", primeTtl: "1h" },
      compactor: { byLevel: [{ chain: ["claude-code:sonnet"], from: 0 }], effort: "medium" },
      defaultDevice: "mini",
      devices: { mini: { folders: ["/tmp"], url: "http://127.0.0.1:1" } },
      master: { chain: ["claude-code:opus"], effort: "high", permissionMode: "bypassPermissions" },
    }),
  );
  const photo = await sharp({ create: { background: "#369", channels: 3, height: 2000, width: 3000 } }).png().toBuffer();
  await Effect.runPromise(
    Effect.gen(function* () {
      const media = yield* makeMedia({ captioner: null, report: () => Effect.void, root: `${dir}/assets`, settings });
      const high = yield* media.ingest(new Uint8Array(photo), "high");
      if (high.kind !== "image" || high.small === undefined) throw new Error("no standard-tier copy");
      expect([high.width, high.height]).toEqual([2576, 1717]);
      const videos: Asset[] = [];
      for (const n of [1, 2, 3, 4]) videos.push(yield* media.ingest(makeVideo(dir, n, 48), "standard"));
      expect(videos.map((v) => (v.kind === "video" ? v.frames.length : 0))).toEqual([24, 24, 24, 24]);

      const got: Seen = { opening: null };
      const mids: Mid[] = [];
      const seeing: TurnEngine = {
        ref: "seeing:x",
        run: (input, out) =>
          Effect.gen(function* () {
            got.opening = input;
            const m = yield* input.mid.next;
            mids.push(m);
            yield* out.took(m);
          }),
        vision: true,
        warm: () => Effect.void,
      };
      const chat = yield* openChat(`${dir}/chat`, { summarize: (job) => Effect.succeed(`summary ${job.l}.${job.i}`) });
      const session = yield* makeSession({ chat, commit: Effect.succeed(null), defaultDevice: "mini", devices: ["mini"], engines: [seeing], idle: "1 hour", logUsage: () => Effect.void, media });
      const events: SessionEvent[] = [];
      const sub = yield* PubSub.subscribe(session.events);
      yield* PubSub.take(sub).pipe(
        Effect.tap((e) => Effect.sync(() => events.push(e))),
        Effect.forever,
        Effect.forkScoped,
      );
      const [v1, v2, v3, v4] = videos;
      if (!v1 || !v2 || !v3 || !v4) throw new Error("videos");
      yield* session.input("look", undefined, "c1", [high, v1, v2, v3]);
      yield* until("the opening message", () => got.opening !== null);
      yield* session.input("and one more", undefined, "c2", [v4]);
      yield* until("the run's end", () => events.some((e) => e.type === "run-finished"));

      const first = got.opening?.media ?? [];
      const second = mids[0]?.media ?? [];
      const wide1 = yield* Effect.promise(async () => widths(first));
      const wide2 = yield* Effect.promise(async () => widths(second));
      // 1 image and 3 × 24 frames, then 19 of the 4th's 24: 92 pictures, and 8 left for zoom
      expect([wide1.length, wide2.length]).toEqual([73, 19]);
      expect(73 + 19 + ZOOM_RESERVE).toBeLessThanOrEqual(MAX_IMAGES);
      // none past 2000 px: the high-detail image went at the standard tier, its own copy
      expect(Math.max(...wide1, ...wide2)).toBeLessThanOrEqual(WIDE_EDGE);
      expect(wide1[0]).toBe(1568);
      // each picture follows the text that names it
      expect(first[0]).toBe(`image ${high.sha.slice(0, 12)}:`);
      expect(first[2]).toBe(`video ${v1.sha.slice(0, 12)} at 0:00:`);
      expect(second[0]).toBe(`video ${v4.sha.slice(0, 12)} at 0:00:`);
      // thinned evenly: 19 of its 24 frames, the last one in, then a line for the transcript
      expect(textOnly(second).filter((p) => p.startsWith("video") && p.includes(" at "))).toHaveLength(19);
      expect(second.at(-3)).toBe(`video ${v4.sha.slice(0, 12)} at 0:46:`);
      expect(second.at(-1)).toBe(`video ${v4.sha.slice(0, 12)}: no transcript`);
      // zoom answers at 2000 px or less too: the high-detail one comes back at the standard tier
      const [zoomed] = media.zoomContent(`[image ${high.sha.slice(0, 12)} 2576x1717 1KB: a blue field]`);
      const zoomedWidths = yield* Effect.promise(async () => widths(zoomed?.type === "image" ? [{ data: zoomed.data, mime: zoomed.mimeType, type: "image" }] : []));
      expect(zoomedWidths).toEqual([1568]);
    }).pipe(Effect.scoped),
  );
}, 60_000);
