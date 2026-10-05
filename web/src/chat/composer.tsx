// The composer (SPEC "Web UI", Chat; "Media"): the text, a tray of attachments, the device picker,
// send and stop. A picked, pasted or dropped photo is downscaled here and uploaded at once, so it
// is usually stored (and being described) by the time the text is typed; the message goes out
// over /ws naming each upload by its digest. Send waits for every upload, and is on when there is
// text or a finished attachment.
import {
  PromptInput,
  PromptInputAttach,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputStop,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { type Attachment, downscale, kindOf, refOf, upload, type Uploader } from "@/lib/attach";
import type { Link } from "@/lib/connection";
import type { SessionStore } from "@/lib/session";
import { type Device, MAX_ATTACHMENTS } from "@wire";
import { useEffect, useRef, useState } from "react";

// the tray: what was attached, each upload's progress and outcome; `notice` says why a file was refused here
export function useAttachments(uploader: Uploader = upload) {
  const [items, setItems] = useState<readonly Attachment[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const held = useRef<readonly Attachment[]>([]);
  const aborts = useRef(new Map<string, () => void>());
  const alive = useRef(true); // false once the composer is gone
  const commit = (next: readonly Attachment[]) => {
    held.current = next;
    setItems(next);
  };
  const update = (key: string, change: Partial<Attachment>) => {
    commit(held.current.map((a) => (a.key === key ? { ...a, ...change } : a)));
  };
  // previews are object URLs: let them go when the composer does
  useEffect(
    () => () => {
      for (const a of held.current) URL.revokeObjectURL(a.preview);
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

  const start = async (a: Attachment, file: File) => {
    const body = a.kind === "image" ? await downscale(file) : file;
    // removed, or the composer gone, while it was downscaled: there is nothing to upload any more
    if (!alive.current || !held.current.some((x) => x.key === a.key)) return;
    const up = uploader(body, (progress) => {
      update(a.key, { progress });
    });
    aborts.current.set(a.key, up.abort);
    try {
      const asset = await up.done;
      update(a.key, { asset, progress: 1 });
    } catch (error) {
      update(a.key, { error: error instanceof Error ? error.message : String(error) });
    } finally {
      aborts.current.delete(a.key);
    }
  };

  const add = (files: readonly File[]) => {
    const room = MAX_ATTACHMENTS - held.current.length;
    const usable = files.filter((f) => kindOf(f) !== null);
    const taken = usable.slice(0, Math.max(0, room));
    setNotice(
      usable.length < files.length ? "only images and videos can be attached" : taken.length < usable.length ? `at most ${MAX_ATTACHMENTS} attachments per message` : null,
    );
    const fresh = taken.map(
      (file): Attachment => ({ asset: null, error: null, key: crypto.randomUUID(), kind: kindOf(file) ?? "image", name: file.name || "pasted image", preview: URL.createObjectURL(file), progress: 0 }),
    );
    commit([...held.current, ...fresh]);
    for (const [k, a] of fresh.entries()) {
      const file = taken[k];
      if (file) void start(a, file);
    }
  };

  const remove = (key: string) => {
    aborts.current.get(key)?.();
    const gone = held.current.find((a) => a.key === key);
    if (gone) URL.revokeObjectURL(gone.preview);
    commit(held.current.filter((a) => a.key !== key));
    setNotice(null);
  };

  // sent: the tray empties; the uploads are done, nothing to abort
  const clear = () => {
    for (const a of held.current) URL.revokeObjectURL(a.preview);
    commit([]);
    setNotice(null);
  };

  const ready = items.flatMap((a) => (a.asset ? [a.asset] : []));
  const busy = items.some((a) => a.asset === null && a.error === null);
  return { add, busy, clear, items, notice, ready, remove };
}

export type ComposerProps = {
  readonly link: Link;
  readonly session: SessionStore;
  readonly busy: boolean; // a turn runs or waits
  readonly open: boolean; // the link is up
  readonly devices: readonly Device[];
  readonly device: string | null; // the device picked, or the state's
  readonly onDevice: (device: string) => void;
  readonly picked: string | null; // what the picker shows
  readonly uploader?: Uploader; // tests replace the upload
};

export function Composer({ link, session, busy, open, devices, device, onDevice, picked, uploader }: ComposerProps) {
  const tray = useAttachments(uploader);
  const [empty, setEmpty] = useState(true);
  const failed = tray.items.some((a) => a.error !== null);
  // a message goes when its uploads are done and none failed (a failed one is removed first)
  const sendable = (text: string) => !tray.busy && !failed && (text.trim() !== "" || tray.ready.length > 0);
  return (
    <PromptInput
      canSubmit={sendable}
      onFiles={tray.add}
      onReset={() => {
        setEmpty(true);
      }}
      onSubmit={(text) => {
        session.send(text, device, tray.ready.map(refOf));
        tray.clear();
      }}
    >
      {(tray.items.length > 0 || tray.notice !== null) && (
        <PromptInputAttachments>
          {tray.items.map((a) => (
            <PromptInputAttachment
              done={a.asset !== null}
              error={a.error}
              key={a.key}
              kind={a.kind}
              name={a.name}
              onRemove={() => {
                tray.remove(a.key);
              }}
              preview={a.preview}
              progress={a.progress}
            />
          ))}
          {tray.notice !== null && (
            <p className="w-full text-xs text-destructive" role="alert">
              {tray.notice}
            </p>
          )}
        </PromptInputAttachments>
      )}
      <PromptInputBody>
        <PromptInputTextarea
          aria-label="Message"
          onChange={(e) => {
            setEmpty(e.currentTarget.value.trim() === "");
          }}
          placeholder={busy ? "Add to the running turn" : "Message"}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputAttach accept="image/*,video/*" label="Attach" onFiles={tray.add} />
          <PromptInputAttach accept="image/*" capture="environment" label="Take a photo" onFiles={tray.add} />
          {devices.length > 1 && (
            <NativeSelect
              aria-label="Device"
              onChange={(e) => {
                onDevice(e.currentTarget.value);
              }}
              size="sm"
              value={picked ?? ""}
            >
              {devices.map((d) => (
                <NativeSelectOption key={d.name} value={d.name}>
                  {d.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </PromptInputTools>
        <div className="flex items-center gap-1">
          {busy && (
            <PromptInputStop
              disabled={!open}
              onClick={() => {
                link.abort();
              }}
            />
          )}
          <PromptInputSubmit disabled={tray.busy || failed || (empty && tray.ready.length === 0)} />
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
}
