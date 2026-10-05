// Image normalization (SPEC "Media"): decode, turn upright by the EXIF orientation, downscale to
// the tier's long edge, re-encode, and keep no metadata (EXIF, GPS, ICC: sharp writes none unless
// asked). Opaque images become JPEG at q85, ones with transparency WebP at q90. Only this
// normalized image is stored; it is what the engines are sent and what zoom returns, so what the
// model saw can be looked at again exactly.
import { Data, Effect } from "effect";
import sharp from "sharp";

// the long edge per detail tier: standard is what the older Claude models take whole (1568 px,
// at most ~1.6k tokens); high is the 2576 px tier of Claude 4.7 and later (~4.8k tokens)
export const TIERS = { high: 2576, standard: 1568 } as const;
export type Tier = keyof typeof TIERS;

// what can go wrong with an upload, with the HTTP status it is answered with
export class MediaError extends Data.TaggedError("MediaError")<{ readonly status: number; readonly message: string }> {}

export type Normalized = { readonly data: Uint8Array; readonly mime: "image/jpeg" | "image/webp"; readonly width: number; readonly height: number };

// a decoder bomb is refused before it is decoded: 100 megapixels is past any phone camera
const MAX_PIXELS = 100_000_000;

export const normalizeImage = (bytes: Uint8Array, edge: number, quality = 85): Effect.Effect<Normalized, MediaError> =>
  Effect.tryPromise({
    catch: (error) => new MediaError({ message: `cannot read the image: ${error instanceof Error ? error.message : String(error)}`, status: 422 }),
    try: async () => {
      // the first frame of an animated GIF or WebP: what the models read of one anyway
      const input = sharp(bytes, { animated: false, failOn: "error", limitInputPixels: MAX_PIXELS });
      const { isOpaque } = await input.stats();
      const sized = input.rotate().resize(edge, edge, { fit: "inside", withoutEnlargement: true });
      const encoded = isOpaque ? sized.jpeg({ mozjpeg: true, quality }) : sized.webp({ quality: 90 });
      const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data), height: info.height, mime: isOpaque ? ("image/jpeg" as const) : ("image/webp" as const), width: info.width };
    },
  });

// One image of a video's frames in a grid, each labelled with its time: what a
// thumbnail and zoom show of a video, instead of every frame.
export const contactSheet = (frames: readonly { readonly data: Uint8Array; readonly t: number }[], label: (t: number) => string): Effect.Effect<Normalized, MediaError> =>
  Effect.tryPromise({
    catch: (error) => new MediaError({ message: `cannot make the contact sheet: ${error instanceof Error ? error.message : String(error)}`, status: 500 }),
    try: async () => {
      const first = frames[0];
      const meta = first ? await sharp(first.data).metadata() : { height: 9, width: 16 };
      const aspect = meta.width / meta.height;
      // portrait frames go six across; the sheet stays within the standard tier both ways
      const cols = Math.min(aspect < 1 ? 6 : 4, Math.max(1, frames.length));
      const rows = Math.max(1, Math.ceil(frames.length / cols));
      const cellW = Math.max(16, Math.floor(Math.min(TIERS.standard / cols, (TIERS.standard * aspect) / rows)));
      const cellH = Math.max(1, Math.round(cellW / aspect));
      const cells = await Promise.all(
        frames.map(async (f, k) => {
          const text = label(f.t);
          // the time in a dark box at the cell's corner
          const tag = Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${cellH}"><rect x="4" y="4" width="${12 + text.length * 11}" height="26" rx="4" fill="black" fill-opacity="0.7"/><text x="10" y="23" font-family="sans-serif" font-size="18" fill="white">${text}</text></svg>`,
          );
          const input = await sharp(f.data).resize(cellW, cellH, { fit: "cover" }).composite([{ input: tag }]).png().toBuffer();
          return { input, left: (k % cols) * cellW, top: Math.floor(k / cols) * cellH };
        }),
      );
      const sheet = sharp({ create: { background: { b: 0, g: 0, r: 0 }, channels: 3, height: rows * cellH, width: cols * cellW } }).composite(cells);
      const { data, info } = await sheet.jpeg({ mozjpeg: true, quality: 80 }).toBuffer({ resolveWithObject: true });
      return { data: new Uint8Array(data), height: info.height, mime: "image/jpeg" as const, width: info.width };
    },
  });
