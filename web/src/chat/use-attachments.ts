// The composer's tray (SPEC "Media", Web UI): what was attached, each upload's progress and
// outcome, a photo's tier, and uploads restored from a saved draft or a take-back. A picked file is
// downscaled here and uploaded at once; one removed, or a composer gone, while it is downscaled is
// never uploaded.
import { type Attachment, type Detail, detailOf, downscale, EDGE, HIGH_EDGE, kindOf, upload, type Uploader } from "@/lib/attach";
import { type Asset, MAX_ATTACHMENTS, shortSha } from "@wire";
import { useEffect, useRef, useState } from "react";

// an upload restored from a saved draft or a take-back: its file is gone, our own thumbnail stands for it
const restoredItem = (asset: Asset): Attachment => ({
  asset,
  detail: detailOf(asset),
  error: null,
  file: false,
  key: crypto.randomUUID(),
  kind: asset.kind,
  name: `${asset.kind} ${shortSha(asset.sha)}`,
  preview: `/api/assets/${shortSha(asset.sha)}/thumb`,
  progress: 1,
});
const tooMany = `at most ${MAX_ATTACHMENTS} attachments per message`;

// the tray: what was attached, each upload's progress and outcome; `notice` says why a file was refused here
export function useAttachments(uploader: Uploader = upload, initial: readonly Asset[] = []) {
  const [items, setItems] = useState<readonly Attachment[]>(() => initial.slice(0, MAX_ATTACHMENTS).map(restoredItem));
  const [notice, setNotice] = useState<string | null>(null);
  const held = useRef<readonly Attachment[]>(items);
  const files = useRef(new Map<string, File>()); // the picked file of each attachment, for another tier
  const aborts = useRef(new Map<string, () => void>());
  const runs = useRef(new Map<string, number>()); // each attachment's latest upload: an older one that ends is ignored
  const alive = useRef(true); // false once the composer is gone
  const commit = (next: readonly Attachment[]) => {
    held.current = next;
    setItems(next);
  };
  const update = (key: string, change: Partial<Attachment>) => {
    commit(held.current.map((a) => (a.key === key ? { ...a, ...change } : a)));
  };
  const forget = (a: Attachment) => {
    aborts.current.get(a.key)?.();
    files.current.delete(a.key);
    runs.current.delete(a.key);
    if (a.file) URL.revokeObjectURL(a.preview);
  };
  // previews are object URLs: let them go when the composer does
  useEffect(
    () => () => {
      for (const a of held.current) if (a.file) URL.revokeObjectURL(a.preview);
      for (const abort of aborts.current.values()) abort();
    },
    [],
  );
  // a downscale that ends after the composer is gone uploads nothing (it is set again if the effect re-runs)
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const start = async (key: string, file: File, detail: Detail) => {
    const run = (runs.current.get(key) ?? 0) + 1;
    runs.current.set(key, run);
    const current = () => alive.current && runs.current.get(key) === run && held.current.some((x) => x.key === key);
    const body = kindOf(file) === "image" ? await downscale(file, detail === "high" ? HIGH_EDGE : EDGE) : file;
    // removed, at another tier now, or the composer gone, while it was downscaled: nothing to upload
    if (!current()) return;
    const up = uploader(
      body,
      (progress) => {
        if (current()) update(key, { progress });
      },
      detail,
    );
    aborts.current.set(key, up.abort);
    try {
      const asset = await up.done;
      if (current()) update(key, { asset, progress: 1 });
    } catch (error) {
      if (current()) update(key, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (runs.current.get(key) === run) aborts.current.delete(key);
    }
  };

  const add = (picked: readonly File[]) => {
    const room = MAX_ATTACHMENTS - held.current.length;
    const usable = picked.filter((f) => kindOf(f) !== null);
    const taken = usable.slice(0, Math.max(0, room));
    setNotice(usable.length < picked.length ? "only images and videos can be attached" : taken.length < usable.length ? tooMany : null);
    const fresh = taken.map(
      (file): Attachment => ({
        asset: null,
        detail: "standard",
        error: null,
        file: true,
        key: crypto.randomUUID(),
        kind: kindOf(file) ?? "image",
        name: file.name || "pasted image",
        preview: URL.createObjectURL(file),
        progress: 0,
      }),
    );
    commit([...held.current, ...fresh]);
    for (const [k, a] of fresh.entries()) {
      const file = taken[k];
      if (!file) continue;
      files.current.set(a.key, file);
      void start(a.key, file, "standard");
    }
  };

  // uploads that are already on the server (a taken-back message's): back in the tray as they are
  const restore = (assets: readonly Asset[]) => {
    const room = Math.max(0, MAX_ATTACHMENTS - held.current.length);
    setNotice(assets.length > room ? tooMany : null);
    commit([...held.current, ...assets.slice(0, room).map(restoredItem)]);
  };

  // A photo at the other tier: uploaded again from its file with or without `?detail=high`. The
  // asset it was before stays on the server, unreferenced, like any upload never sent.
  const toggleDetail = (key: string) => {
    const a = held.current.find((x) => x.key === key);
    const file = files.current.get(key);
    if (!a || !file || a.kind !== "image") return;
    const detail: Detail = a.detail === "high" ? "standard" : "high";
    aborts.current.get(key)?.();
    update(key, { asset: null, detail, error: null, progress: 0 });
    void start(key, file, detail);
  };

  const remove = (key: string) => {
    const gone = held.current.find((a) => a.key === key);
    if (gone) forget(gone);
    commit(held.current.filter((a) => a.key !== key));
    setNotice(null);
  };

  // sent: the tray empties; the uploads are done, nothing to abort
  const clear = () => {
    for (const a of held.current) forget(a);
    commit([]);
    setNotice(null);
  };

  const ready = items.flatMap((a) => (a.asset ? [a.asset] : []));
  const uploading = items.filter((a) => a.asset === null && a.error === null).length;
  return { add, busy: uploading > 0, clear, items, notice, ready, remove, restore, toggleDetail, uploading };
}
