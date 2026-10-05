// Attachments from the composer (SPEC "Media", Web UI): a photo is downscaled here before it
// leaves the phone (canvas, JPEG q0.85, 1568 px on the long edge: the standard tier, so a 12 MP
// photo goes up as ~300 KB instead of ~4 MB), then PUT to /api/assets with its progress, which
// fetch can't report. The server still sniffs, normalizes and strips it; this only saves the
// upload. A video goes up as it is.
import { Asset } from "@wire";
import { Schema } from "effect";
import type { AttachmentRef } from "./protocol.ts";

export const EDGE = 1568;
const QUALITY = 0.85;

export const kindOf = (file: Blob): "image" | "video" | null =>
  file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : null;

const encode = async (canvas: HTMLCanvasElement, type: string) =>
  new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, type, QUALITY);
  });

// The image at most EDGE on its long edge, re-encoded once: JPEG, or WebP for a PNG (it may be
// transparent; a browser that can't write WebP gives PNG). One already small enough is sent as it
// is, never compressed twice. Anything the browser can't decode is sent as it is, for the server
// to judge.
export async function downscale(file: File, edge = EDGE): Promise<Blob> {
  if (kindOf(file) !== "image" || !("createImageBitmap" in globalThis)) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const heic = /hei[cf]/.test(file.type); // the server takes no HEIC: re-encode it whatever its size
    if (scale === 1 && !heic) {
      bitmap.close();
      return file;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await encode(canvas, file.type === "image/png" ? "image/webp" : "image/jpeg");
    return blob ?? file;
  } catch {
    return file;
  }
}

const decodeAsset = Schema.decodeUnknownSync(Schema.fromJsonString(Asset));

export type Upload = { readonly done: Promise<Asset>; readonly abort: () => void };
export type Uploader = (body: Blob, progress: (fraction: number) => void) => Upload;

// PUT /api/assets with XMLHttpRequest, for its upload progress; the error is the server's own words
export const upload: Uploader = (body, progress) => {
  const xhr = new XMLHttpRequest();
  const done = new Promise<Asset>((resolve, reject) => {
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && e.total > 0) progress(e.loaded / e.total);
    });
    xhr.addEventListener("load", () => {
      if (xhr.status === 200) {
        try {
          resolve(decodeAsset(xhr.responseText));
        } catch {
          reject(new Error("the server's answer was not an asset"));
        }
      } else reject(new Error(xhr.responseText.trim() || `upload failed (${xhr.status})`));
    });
    xhr.addEventListener("error", () => {
      reject(new Error("upload failed: no connection"));
    });
    xhr.addEventListener("abort", () => {
      reject(new Error("upload cancelled"));
    });
  });
  xhr.open("PUT", "/api/assets");
  xhr.send(body);
  return {
    abort: () => {
      xhr.abort();
    },
    done,
  };
};

// One attachment in the composer's tray: the file picked, its preview (an object URL of the file
// itself, nothing fetched), how far its upload is, and what it became or why not.
export type Attachment = {
  readonly key: string;
  readonly name: string;
  readonly kind: "image" | "video";
  readonly preview: string;
  readonly progress: number; // 0..1
  readonly asset: Asset | null;
  readonly error: string | null;
};

export const refOf = (a: Asset): AttachmentRef => ({ kind: a.kind, mime: a.mime, sha: a.sha });
