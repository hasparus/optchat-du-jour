// What an upload really is (SPEC "Media"), read from its first bytes: the type a client declares
// is never trusted. Only the formats every engine in our chains takes are let in (JPEG, PNG, WebP,
// GIF), plus short videos in the containers phones record (MP4, QuickTime, WebM), which are only
// ever turned into frames.

export type Sniffed =
  | { readonly kind: "image"; readonly mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif" }
  | { readonly kind: "video"; readonly mime: "video/mp4" | "video/quicktime" | "video/webm" };

const ascii = (bytes: Uint8Array, at: number, text: string) => {
  for (let k = 0; k < text.length; k++) if (bytes[at + k] !== text.codePointAt(k)) return false;
  return true;
};
const starts = (bytes: Uint8Array, prefix: readonly number[]) => prefix.every((b, k) => bytes[k] === b);

// ISO base media files (MP4, MOV) start with a box whose type is "ftyp" and whose first brand
// says which: "qt  " is QuickTime, anything else is read as MP4
const isoBrand = (bytes: Uint8Array) => (ascii(bytes, 4, "ftyp") ? String.fromCodePoint(...bytes.subarray(8, 12)) : null);

export function sniff(bytes: Uint8Array): Sniffed | null {
  if (starts(bytes, [0xFF, 0xD8, 0xFF])) return { kind: "image", mime: "image/jpeg" };
  if (starts(bytes, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return { kind: "image", mime: "image/png" };
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return { kind: "image", mime: "image/gif" };
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return { kind: "image", mime: "image/webp" };
  const brand = isoBrand(bytes);
  if (brand !== null) return { kind: "video", mime: brand === "qt  " ? "video/quicktime" : "video/mp4" };
  // EBML, the Matroska family; WebM is the one browsers record
  if (starts(bytes, [0x1A, 0x45, 0xDF, 0xA3])) return { kind: "video", mime: "video/webm" };
  return null;
}

// the file extension of each type the asset store keeps; nothing else names a stored file
export const EXT = {
  "application/json": "json",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
} as const;
export type StoredMime = keyof typeof EXT;
