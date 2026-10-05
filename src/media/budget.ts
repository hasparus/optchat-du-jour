// The pictures one request may hold (SPEC "Media"). Anthropic takes at most 100 images in a
// request, and when it has more than 20, none may be over 2000 px on a side. A turn's request
// grows as the turn goes: the opening message's pictures, each mid-run message's, and what zoom
// returns. This is the one place that decides, for each batch of attachments about to be sent,
// what of them goes: thin a video's frames first, then show it as its one contact sheet, then
// send the marker only. A high-detail image (up to 2576 px) goes at its standard-tier size
// whenever the request could pass 20 images. Zoom's own pictures are counted by a reserve.
import type { Asset, ImageAsset, VideoAsset } from "../wire.ts";

export const MAX_IMAGES = 100;
// images a zoom answers with, at most
export const MAX_ZOOM = 4;
// up to this many images a request may hold some over 2000 px
export const FEW_IMAGES = 20;
export const WIDE_EDGE = 2000;
// the pictures zoom may add to a turn (two answers of at most MAX_ZOOM): counted, not enforced, as
// the MCP server does not know which turn asked. Zoom answers at most WIDE_EDGE px, so it never
// breaks the limit on size.
export const ZOOM_RESERVE = 2 * MAX_ZOOM;
// a video thinned to fewer frames than this is shown as its sheet instead
export const MIN_FRAMES = 4;

// what is sent of one attachment
export type Look =
  | { readonly how: "all" } // an image; a video's every frame
  | { readonly how: "frames"; readonly keep: number } // a video's frames, thinned to `keep`
  | { readonly how: "sheet" } // a video's contact sheet
  | { readonly how: "none" }; // its marker only, and a line saying so

export const isWide = (a: Asset): a is ImageAsset => a.kind === "image" && Math.max(a.width, a.height) > WIDE_EDGE;

const costOf = (a: Asset, look: Look) => {
  switch (look.how) {
    case "all":
      return a.kind === "video" ? a.frames.length : 1;
    case "frames":
      return look.keep;
    case "sheet":
      return 1;
    case "none":
      return 0;
  }
};

// `keep` of a video's frames, the first and last among them and the rest evenly between
export const thin = <T>(frames: readonly T[], keep: number): T[] => {
  if (keep >= frames.length) return [...frames];
  if (keep <= 1) return frames.slice(0, Math.max(0, keep));
  return Array.from({ length: keep }, (_, k) => frames[Math.round((k * (frames.length - 1)) / (keep - 1))]).flatMap((f) => (f === undefined ? [] : [f]));
};

export type Plan = { readonly looks: readonly Look[]; readonly capped: boolean };

// The frames each video keeps when `room` is shared by them: the shortest first, so a short clip
// keeps all its frames and leaves its share to the others. null when one would be left with fewer
// than MIN_FRAMES.
const share = (videos: readonly VideoAsset[], room: number): readonly number[] | null => {
  const order = videos.map((v, k) => ({ frames: v.frames.length, k })).toSorted((a, b) => a.frames - b.frames);
  const keeps: number[] = [];
  let left = room;
  for (const [n, { frames, k }] of order.entries()) {
    const keep = Math.min(frames, Math.floor(left / (order.length - n)));
    if (keep < Math.min(frames, MIN_FRAMES)) return null;
    keeps[k] = keep;
    left -= keep;
  }
  return keeps;
};

// A turn's pictures so far, for one call of an engine: each batch (the opening message's
// attachments, then each mid-run message's) is planned against what the request already holds.
export const pictureBudget = () => {
  let used = 0;
  let wideSent = false; // a picture over WIDE_EDGE is in the request: it may never hold more than FEW_IMAGES
  const take = (assets: readonly Asset[]): Plan => {
    const full = assets.reduce((n, a) => n + costOf(a, { how: "all" }), 0);
    // images are capped when the request could pass FEW_IMAGES with this batch, or already holds a wide one
    const capped = wideSent || used + full + ZOOM_RESERVE > FEW_IMAGES;
    const room = Math.max(0, (wideSent ? FEW_IMAGES : MAX_IMAGES) - ZOOM_RESERVE - used);
    const looks = full <= room ? assets.map((): Look => ({ how: "all" })) : squeeze(assets, room);
    used += assets.reduce((n, a, k) => n + costOf(a, looks[k] ?? { how: "none" }), 0);
    if (!capped && assets.some(isWide)) wideSent = true;
    return { capped, looks };
  };
  return { take };
};

const squeeze = (assets: readonly Asset[], room: number): Look[] => {
  const videos = assets.flatMap((a) => (a.kind === "video" ? [a] : []));
  const stills = assets.length - videos.length;
  const kept = videos.length === 0 || stills > room ? null : share(videos, room - stills);
  if (kept !== null) {
    let n = 0;
    return assets.map((a): Look => {
      if (a.kind === "image") return { how: "all" };
      const keep = kept[n++] ?? 0;
      return keep >= a.frames.length ? { how: "all" } : { how: "frames", keep };
    });
  }
  // sheets for the videos, one picture each: the first attachments that fit, then markers only
  let left = room;
  return assets.map((a): Look => {
    if (left <= 0) return { how: "none" };
    left--;
    return a.kind === "video" ? { how: "sheet" } : { how: "all" };
  });
};
