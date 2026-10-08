// The pictures of one request (SPEC "Media", src/media/budget.ts): at most 100, and over 20 of
// them each at most 2000 px; a call's attachments take at most 60, the rest is left to its tools.
// A video is thinned to fewer frames first, then shown as its sheet, then left to its marker; a
// high-detail image goes at its standard-tier size once the request could pass 20. Planned for
// the opening message and each mid-run message of one call, in one place.
import { afterAll, expect, test } from "bun:test";
import { Effect, PubSub } from "effect";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { openChat } from "../src/chat.ts";
import { FEW_IMAGES, MAX_ATTACHED, MAX_IMAGES, MAX_ZOOM, MIN_FRAMES, pictureBudget, thin, WIDE_EDGE, ZOOM_RESERVE } from "../src/media/budget.ts";
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
const ROOM = MAX_ATTACHED;

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

test("four videos and a high-detail image: the frames are thinned to the attachments' 60, the rest left to the tools", () => {
  // the tools' share holds ten zoom answers, so a turn that zooms or reads pictures stays under 100
  expect([MAX_ATTACHED, MAX_IMAGES - MAX_ATTACHED]).toEqual([60, 10 * MAX_ZOOM]);
  const assets = [still(1, 2576), clip(1), clip(2), clip(3), clip(4)];
  const plan = kept(assets);
  expect(plan.capped).toBe(true);
  // 60 for 1 + 4 × 24: the videos share the other 59, 14 or 15 frames each
  expect(plan.looks).toEqual(["all", 14, 15, 15, 15]);
  // a short clip keeps all its frames and leaves its share to the others
  expect(kept([clip(1, 6), clip(2), clip(3), clip(4), clip(5), clip(6)]).looks).toEqual(["all", 10, 11, 11, 11, 11]);
});

test("too many videos to thin: each is its sheet, then the rest are markers only", () => {
  // 25 videos share 60: 2 frames each is under MIN_FRAMES, so sheets
  expect(MIN_FRAMES).toBe(4);
  expect(kept(Array.from({ length: 25 }, (_, k) => clip(k + 1))).looks).toEqual(Array.from({ length: 25 }, () => "sheet"));
  const crowd = kept(Array.from({ length: ROOM + 3 }, (_, k) => clip(k + 1)));
  expect(crowd.looks.filter((l) => l === "sheet")).toHaveLength(ROOM);
  expect(crowd.looks.slice(ROOM)).toEqual(["none", "none", "none"]);
});

test("when not every video can keep 4 frames, the first attachments in order keep a picture (an image whole, a video its sheet) and the rest are markers only", () => {
  // thinning is tried only when the stills fit and leave every video MIN_FRAMES; otherwise it is
  // sheets, and the room is spent in the order sent, stills and videos alike
  // a budget that already holds `n` stills
  const holding = (n: number) => {
    const budget = pictureBudget();
    kept(Array.from({ length: n }, (_, k) => still(k + 1)), budget);
    return budget;
  };
  // 2 of 60 left: a video, a still, a video: the sheet, the still, then a marker
  expect(kept([clip(1), still(60), clip(2)], holding(58)).looks).toEqual(["sheet", "all", "none"]);
  // a still first keeps its place, then one sheet; the second video is a marker
  expect(kept([still(60), clip(1), clip(2)], holding(58)).looks).toEqual(["all", "sheet", "none"]);
  // and a still sent after the videos is the one left out: with room < videos + stills, thinning (room >= stills + 4 per video) was never possible
  expect(kept([clip(1), clip(2), still(60)], holding(58)).looks).toEqual(["sheet", "sheet", "none"]);

  // 5 pictures of room for two videos: 2 frames each is under MIN_FRAMES, so both are sheets
  expect(kept([clip(1), clip(2)], holding(55)).looks).toEqual(["sheet", "sheet"]);

  // a batch of 61 stills is over the 60: the first 60 are whole, the last is a marker
  expect(kept(Array.from({ length: 61 }, (_, k) => still(k + 1))).looks).toEqual([...Array.from({ length: 60 }, () => "all" as const), "none" as const]);
  // more stills than room plus a video: the video comes after them all and gets nothing
  expect(kept([...Array.from({ length: 60 }, (_, k) => still(k + 1)), clip(1)]).looks.at(-1)).toBe("none");
  // 30 videos and 31 stills, videos first: 30 sheets, 30 stills, the last still left out;
  // stills first: 31 stills, 29 sheets, the last video left out
  const videosFirst = kept([...Array.from({ length: 30 }, (_, k) => clip(k + 1)), ...Array.from({ length: 31 }, (_, k) => still(k + 100))]).looks;
  expect(videosFirst.slice(0, 30).every((l) => l === "sheet")).toBe(true);
  expect(videosFirst.slice(30, 60).every((l) => l === "all")).toBe(true);
  expect(videosFirst.at(-1)).toBe("none");
  const stillsFirst = kept([...Array.from({ length: 31 }, (_, k) => still(k + 100)), ...Array.from({ length: 30 }, (_, k) => clip(k + 1))]).looks;
  expect(stillsFirst.slice(0, 31).every((l) => l === "all")).toBe(true);
  expect(stillsFirst.slice(31, 60).every((l) => l === "sheet")).toBe(true);
  expect(stillsFirst.at(-1)).toBe("none");
  // when thinning does work, every still stays whole and only the videos are thinned
  expect(kept([...Array.from({ length: 10 }, (_, k) => still(k + 1)), clip(1), clip(2), clip(3)]).looks).toEqual([...Array.from({ length: 10 }, () => "all" as const), 16, 17, 17]);
});

test("mid-run messages are planned against what the request holds already", () => {
  const budget = pictureBudget();
  expect(kept([still(1), clip(1), clip(2)], budget).looks).toEqual(["all", "all", "all"]); // 49 pictures
  // 11 left of 60: a video is thinned to them
  expect(kept([clip(3)], budget).looks).toEqual([11]);
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
      if (Date.now() > deadline) return yield* Effect.die(new Error(`timed out waiting for ${what}`));
      yield* Effect.sleep("10 millis");
    }
  });

test("a turn's pictures: two videos and a high-detail image in the opening, a third video mid-run; none over 2000 px, 60 at most, each labelled", async () => {
  const dir = fresh();
  const settings = mediaSettings(
    parseSettings({
      allowedLogins: [],
      cache: { claudeCodeTtl: "1h", primeTtl: "1h" },
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
      for (const n of [1, 2, 3]) videos.push(yield* media.ingest(makeVideo(dir, n, 48), "standard"));
      expect(videos.map((v) => (v.kind === "video" ? v.frames.length : 0))).toEqual([24, 24, 24]);

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
      const [v1, v2, v3] = videos;
      if (!v1 || !v2 || !v3) throw new Error("videos");
      yield* session.input("look", { clientId: "c1", media: [high, v1, v2] });
      yield* until("the opening message", () => got.opening !== null);
      yield* session.input("and one more", { clientId: "c2", media: [v3] });
      yield* until("the run's end", () => events.some((e) => e.type === "run-finished"));

      const first = got.opening?.media ?? [];
      const second = mids[0]?.media ?? [];
      const wide1 = yield* Effect.promise(async () => widths(first));
      const wide2 = yield* Effect.promise(async () => widths(second));
      // 1 image and 2 × 24 frames, then 11 of the 3rd's 24: 60 pictures, and 40 left for the tools
      expect([wide1.length, wide2.length]).toEqual([49, 11]);
      expect(49 + 11).toBe(MAX_ATTACHED);
      // none past 2000 px: the high-detail image went at the standard tier, its own copy
      expect(Math.max(...wide1, ...wide2)).toBeLessThanOrEqual(WIDE_EDGE);
      expect(wide1[0]).toBe(1568);
      // each picture follows the text that names it
      expect(first[0]).toBe(`image ${high.sha.slice(0, 12)}:`);
      expect(first[2]).toBe(`video ${v1.sha.slice(0, 12)} at 0:00:`);
      expect(second[0]).toBe(`video ${v3.sha.slice(0, 12)} at 0:00:`);
      // thinned evenly: 11 of its 24 frames, the last one in, then a line for the transcript
      expect(textOnly(second).filter((p) => p.startsWith("video") && p.includes(" at "))).toHaveLength(11);
      expect(second.at(-3)).toBe(`video ${v3.sha.slice(0, 12)} at 0:46:`);
      expect(second.at(-1)).toBe(`video ${v3.sha.slice(0, 12)}: no transcript`);
      // zoom answers at 2000 px or less too: the high-detail one comes back at the standard tier
      const [zoomed] = media.zoomContent(`[image ${high.sha.slice(0, 12)} 2576x1717 1KB: a blue field]`);
      const zoomedWidths = yield* Effect.promise(async () => widths(zoomed?.type === "image" ? [{ data: zoomed.data, mime: zoomed.mimeType, type: "image" }] : []));
      expect(zoomedWidths).toEqual([1568]);
    }).pipe(Effect.scoped),
  );
}, 60_000);
