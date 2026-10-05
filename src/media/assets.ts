// The asset store (SPEC "Media"): a content-addressed sidecar next to the streams, one shared
// `assets/` under the data home (~/.optchat/assets/<sha[:2]>/<sha>.<ext>), committed and pushed by
// persist with the rest of the home. Each asset is its bytes plus `<sha>.json`, the metadata the
// marker, the engines and zoom read (wire.ts Asset); the json is written after the bytes, so an
// asset with metadata is whole. File names come only from the digest and the fixed extension
// table (./sniff.ts EXT), never from a client. Every file is written to a temporary name, synced,
// renamed into place, and its directory synced: an asset is on disk before any log line can name
// it. Writes are idempotent: the same bytes have the same name, and a file already there is kept.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { Option, Schema } from "effect";
import { Asset } from "../wire.ts";
import { EXT, type StoredMime } from "./sniff.ts";

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// a full digest, or the 12-character prefix markers carry; anything else names no asset
const SHA = /^[0-9a-f]{12,64}$/;

const syncDir = (path: string) => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

// bytes to `path` through a temporary file in the same directory: written, synced, renamed, and
// the directory synced, so a crash leaves the old state or the whole file, never part of it
function writeAtomic(path: string, bytes: Uint8Array) {
  const dir = path.slice(0, path.lastIndexOf("/"));
  const tmp = `${dir}/.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    let done = 0;
    while (done < bytes.length) {
      const wrote = writeSync(fd, bytes, done, bytes.length - done);
      if (wrote <= 0) throw new Error(`${tmp}: wrote ${done} of ${bytes.length} bytes`);
      done += wrote;
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(tmp);
    throw error;
  }
  closeSync(fd);
  renameSync(tmp, path);
  syncDir(dir);
}

const decodeAsset = Schema.decodeUnknownOption(Schema.fromJsonString(Asset));
const encodeAsset = Schema.encodeSync(Schema.fromJsonString(Asset));

export type AssetStore = ReturnType<typeof assetStore>;

export function assetStore(root: string) {
  const folder = (sha: string) => `${root}/${sha.slice(0, 2)}`;
  const pathOf = (sha: string, mime: StoredMime) => `${folder(sha)}/${sha}.${EXT[mime]}`;

  // the folder for this digest, made (and its parents synced) if it is new
  const ensure = (sha: string) => {
    const sub = folder(sha);
    if (existsSync(sub)) return sub;
    const fresh = !existsSync(root);
    mkdirSync(sub, { mode: 0o700, recursive: true });
    syncDir(root);
    if (fresh) syncDir(root.slice(0, root.lastIndexOf("/")) || "/");
    return sub;
  };

  // the bytes under their digest; a file already there is the same bytes and is kept
  const put = (bytes: Uint8Array, mime: StoredMime) => {
    const sha = sha256(bytes);
    ensure(sha);
    const path = pathOf(sha, mime);
    if (!existsSync(path)) writeAtomic(path, bytes);
    return { path, sha };
  };

  // the metadata of an asset whose bytes are stored; written once
  const putMeta = (asset: Asset) => {
    ensure(asset.sha);
    const path = pathOf(asset.sha, "application/json");
    if (!existsSync(path)) writeAtomic(path, Buffer.from(encodeAsset(asset)));
  };

  // an asset by its digest or its 12-character prefix; null when none, or when a prefix is ambiguous
  const find = (id: string): Asset | null => {
    if (!SHA.test(id)) return null;
    const sub = folder(id);
    if (!existsSync(sub)) return null;
    const named = readdirSync(sub).filter((name) => name.startsWith(id) && name.endsWith(".json"));
    const [only] = named;
    if (only === undefined || named.length > 1) return null;
    return Option.getOrNull(decodeAsset(readFileSync(`${sub}/${only}`, "utf8")));
  };

  // the stored bytes of an asset found by `find`, with their type; null when the file is gone
  const file = (asset: Asset) => {
    const path = pathOf(asset.sha, asset.mime);
    return existsSync(path) ? { mime: asset.mime, path } : null;
  };

  return { file, find, pathOf, put, putMeta, root };
}
