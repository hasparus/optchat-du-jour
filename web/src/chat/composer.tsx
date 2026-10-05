// The composer (SPEC "Web UI", Chat; "Media"): the text, a tray of attachments, the device picker,
// the session's settings (follow-ups, the lead engine), send and stop. A picked, pasted or dropped
// photo is downscaled here and uploaded at once, so it is usually stored (and being described) by
// the time the text is typed; the message goes out over /ws naming each upload by its digest.
// Send waits for every upload, says why while it does, and is on when there is text or a finished
// attachment. The draft (the text and the finished uploads) survives a reload (lib/draft.ts).
// While a turn runs, send follows the session's follow-up setting and a second button (Mod+Enter
// on a keyboard) sends the other way for this one message; with nothing to send, send is stop.
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
  useCoarsePointer,
} from "@/components/ai-elements/prompt-input";
import { InputGroupButton } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type Attachment, type Detail, detailOf, downscale, EDGE, HIGH_EDGE, kindOf, upload, type Uploader } from "@/lib/attach";
import type { Link } from "@/lib/connection";
import { loadDraft, loadHistory, remember, saveDraft } from "@/lib/draft";
import type { Restored, SessionStore } from "@/lib/session";
import { cn } from "@/lib/utils";
import { type Asset, type Device, type FollowUp, MAX_ATTACHMENTS, type SessionState, shortSha } from "@wire";
import { ChevronDownIcon, ListEndIcon, SlidersHorizontalIcon, ZapIcon } from "lucide-react";
import { type ComponentProps, type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";

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

// What a message sent mid-run does, in a popover off the tools; its trigger names the behavior
// (on a narrow screen only in its label), so the mode is never hidden.
function FollowUps({ link, followUp }: { readonly link: Link; readonly followUp: FollowUp }) {
  const choices: readonly { readonly value: FollowUp; readonly label: string; readonly hint: string }[] = [
    { hint: "joins the running turn", label: "Steer", value: "steer" },
    { hint: "waits for the next turn", label: "Queue", value: "queue" },
  ];
  return (
    <Popover>
      <PopoverTrigger asChild>
        <InputGroupButton aria-label={`Follow-ups: ${followUp}`} size="xs" title="What a message sent while a turn runs does" variant="ghost">
          <SlidersHorizontalIcon />
          <span className="hidden capitalize min-[400px]:inline">{followUp}</span>
        </InputGroupButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2 text-sm">
        <p className="font-medium">A message sent while a turn runs</p>
        <div className="grid grid-cols-2 gap-1.5">
          {choices.map((c) => (
            <button
              aria-pressed={followUp === c.value}
              className={cn("rounded-md border px-2 py-1.5 text-left transition-colors", followUp === c.value ? "border-primary bg-primary/10" : "hover:bg-muted")}
              key={c.value}
              onClick={() => {
                link.configure({ followUp: c.value });
              }}
              type="button"
            >
              <span className="block font-medium">{c.label}</span>
              <span className="block text-xs text-muted-foreground">{c.hint}</span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">Shared by every device. The other button next to send, or Ctrl/⌘+Enter, does the other for one message.</p>
      </PopoverContent>
    </Popover>
  );
}

// "Claude Opus (Claude Code)" → "Opus", "GPT-6.1 Sol (ChatGPT plan)" → "GPT-6.1 Sol": what the
// closed picker shows on a phone's narrow footer; the options say it all
const shortLabel = (label: string) => label.replace(/ \(.*\)$/, "").replace(/^Claude /, "");

// A native select (the phone's own picker) laid over a compact label, so a picker in the footer
// takes the width of its value, not of its longest option
type CompactSelectProps = ComponentProps<"select"> & { readonly label: string; readonly shown: string; readonly alert?: boolean; readonly testId?: string };

function CompactSelect({ label, shown, title, alert = false, testId, children, ...props }: CompactSelectProps) {
  return (
    <span
      className={cn(
        "relative flex h-6 max-w-28 min-w-0 items-center gap-1 rounded-sm px-1.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground has-[select:focus-visible]:ring-[3px] has-[select:focus-visible]:ring-ring/50",
        alert && "bg-destructive/10 text-destructive ring-2 ring-destructive/60",
      )}
      data-testid={testId}
      title={title}
    >
      <span className="truncate">{shown}</span>
      <ChevronDownIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
      <select aria-label={label} className="absolute inset-0 cursor-pointer opacity-0" {...props}>
        {children}
      </select>
    </span>
  );
}

// The model picker: the engines of the master's chain, the one turns run on picked. An engine
// that hit a usage limit is disabled with why, unless it is the one in use (picking it again
// retries it). While a turn waits for a pick, the picker is highlighted.
function ModelPicker({ link, state }: { readonly link: Link; readonly state: SessionState }) {
  const current = state.engines.find((e) => e.ref === state.lead);
  return (
    <CompactSelect
      alert={state.phase === "needs-model"}
      label="Model"
      onChange={(e) => {
        link.configure({ lead: e.currentTarget.value });
      }}
      shown={shortLabel(current?.label ?? state.lead)}
      testId="model-picker"
      title={current?.label}
      value={state.lead}
    >
      {state.engines.map((e) => (
        <option disabled={e.down !== null && e.ref !== state.lead} key={e.ref} value={e.ref}>
          {e.down === null ? e.label : `${e.label}: unavailable, ${e.down}`}
        </option>
      ))}
    </CompactSelect>
  );
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export type ComposerProps = {
  readonly link: Link;
  readonly session: SessionStore;
  readonly state: SessionState | null; // the server's
  readonly busy: boolean; // a turn runs or waits
  readonly open: boolean; // the link is up
  readonly devices: readonly Device[];
  readonly device: string | null; // the device picked, or the state's
  readonly onDevice: (device: string) => void;
  readonly picked: string | null; // what the picker shows
  readonly restored: Restored | null; // a message taken back, to hold again
  readonly uploader?: Uploader; // tests replace the upload
};

export function Composer({ link, session, state, busy, open, devices, device, onDevice, picked, restored, uploader }: ComposerProps) {
  const saved = useMemo(loadDraft, []); // read once: the composer owns the draft from here
  const tray = useAttachments(uploader, saved?.media);
  const [text, setText] = useState(saved?.text ?? "");
  const box = useId(); // the textarea's id, to focus it
  const touch = useCoarsePointer();
  const hint = useId();
  // this client's sent texts, oldest first, and which one Up has recalled
  const history = useRef<string[]>([...loadHistory()]);
  const [recalled, setRecalled] = useState<number | null>(null);
  const failed = tray.items.some((a) => a.error !== null);
  const running = state?.phase === "running";
  const followUp = state?.followUp ?? "steer";
  const other: FollowUp = followUp === "steer" ? "queue" : "steer";
  const content = text.trim() !== "" || tray.items.length > 0;

  // the draft as it stands, kept for a reload: the text and the uploads that finished
  const readyKey = tray.ready.map((a) => a.sha).join(",");
  useEffect(() => {
    saveDraft({ media: tray.ready, text });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- readyKey stands for tray.ready, a new array each render
  }, [text, readyKey]);

  // a message taken back: its text before what is typed now, its uploads into the tray
  const restoredKey = useRef(restored?.key ?? null);
  useEffect(() => {
    if (!restored || restored.key === restoredKey.current) return;
    restoredKey.current = restored.key;
    setText((now) => (now.trim() === "" ? restored.text : `${restored.text}\n${now}`));
    tray.restore(restored.media);
    document.getElementById(box)?.focus();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per take-back, told by its key
  }, [restored]);

  // why send is off while there is something to send
  const blocked = tray.busy ? `waiting for ${plural(tray.uploading, "upload")}…` : failed ? "remove the failed attachment to send" : null;
  const sendable = (typed: string) => !tray.busy && !failed && (typed.trim() !== "" || tray.ready.length > 0);

  const send = (how?: FollowUp) => {
    if (!sendable(text)) return;
    session.send(text, device, tray.ready, running ? how : undefined);
    if (text.trim() !== "") {
      remember(text);
      history.current = [...history.current.filter((t) => t !== text), text];
    }
    setText("");
    setRecalled(null);
    tray.clear();
  };

  // Up in an empty composer (on a keyboard) recalls this client's previous messages, Down goes
  // back toward the newest; only while the text is what was recalled, so editing it keeps it.
  // Mod+Enter sends the other way while a turn runs.
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send(other);
      return;
    }
    if (touch || e.altKey || e.shiftKey || e.metaKey || e.ctrlKey) return;
    const kept = history.current;
    const showing = recalled !== null && text === kept[recalled];
    const el = e.currentTarget;
    if (e.key === "ArrowUp" && (text === "" || (showing && el.selectionStart === 0 && el.selectionEnd === 0))) {
      const k = (showing ? recalled : kept.length) - 1;
      const past = kept[k];
      if (past === undefined) return;
      e.preventDefault();
      setText(past);
      setRecalled(k);
    } else if (e.key === "ArrowDown" && showing && el.selectionStart === text.length) {
      e.preventDefault();
      const next = kept[recalled + 1];
      setText(next ?? "");
      setRecalled(next === undefined ? null : recalled + 1);
    }
  };

  const placeholder = running ? (followUp === "steer" ? "Add to the running turn" : "Queue a follow-up") : "Message";
  const sendLabel = running && followUp === "queue" ? "Send (queued for the next turn)" : running ? "Send (joins the running turn)" : "Send";
  const otherLabel = other === "steer" ? "Send now" : "Queue for the next turn";
  return (
    <PromptInput
      canSubmit={sendable}
      onFiles={tray.add}
      onSubmit={() => {
        send();
      }}
    >
      {(tray.items.length > 0 || tray.notice !== null) && (
        <PromptInputAttachments>
          {tray.items.map((a) => (
            <PromptInputAttachment
              done={a.asset !== null}
              error={a.error}
              high={a.detail === "high"}
              key={a.key}
              kind={a.kind}
              name={a.name}
              onHigh={
                a.file && a.kind === "image"
                  ? () => {
                      tray.toggleDetail(a.key);
                    }
                  : undefined
              }
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
          aria-describedby={hint}
          aria-label="Message"
          onChange={(e) => {
            setText(e.currentTarget.value);
          }}
          onKeyDown={keyDown}
          id={box}
          placeholder={placeholder}
          value={text}
        />
      </PromptInputBody>
      <PromptInputFooter className="flex-wrap">
        <PromptInputTools>
          <PromptInputAttach accept="image/*,video/*" label="Attach" onFiles={tray.add} />
          <PromptInputAttach accept="image/*" capture="environment" label="Take a photo" onFiles={tray.add} />
          {devices.length > 1 && (
            <CompactSelect
              label="Device"
              onChange={(e) => {
                onDevice(e.currentTarget.value);
              }}
              shown={picked ?? "device"}
              title="Where the next turn runs"
              value={picked ?? ""}
            >
              {devices.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name}
                </option>
              ))}
            </CompactSelect>
          )}
          {state && state.engines.length > 0 && <ModelPicker link={link} state={state} />}
          {state && <FollowUps followUp={state.followUp} link={link} />}
        </PromptInputTools>
        <div className="ml-auto flex items-center gap-1">
          {running && content && (
            <InputGroupButton
              aria-label={otherLabel}
              disabled={blocked !== null}
              onClick={() => {
                send(other);
              }}
              size="sm"
              title={`${otherLabel} (Ctrl/⌘+Enter)`}
              variant="outline"
            >
              {other === "steer" ? <ZapIcon /> : <ListEndIcon />}
              <span className="hidden min-[400px]:inline">{other === "steer" ? "Now" : "Queue"}</span>
            </InputGroupButton>
          )}
          {busy && !content ? (
            <PromptInputStop
              disabled={!open}
              onClick={() => {
                link.abort();
              }}
              title="Stop the turn"
            />
          ) : (
            <PromptInputSubmit aria-describedby={hint} disabled={blocked !== null || !content} title={blocked ?? sendLabel} />
          )}
        </div>
        <p
          aria-live="polite"
          className={cn("w-full px-1 text-xs", blocked ? "text-muted-foreground" : "hidden text-muted-foreground/80 pointer-fine:sm:block")}
          data-testid="composer-hint"
          id={hint}
        >
          {blocked ??
            (touch
              ? null
              : `Enter to send · Shift+Enter new line${running ? ` · Ctrl/⌘+Enter ${other === "steer" ? "sends now" : "queues"}` : ""}${history.current.length > 0 ? " · ↑ last message" : ""}`)}
        </p>
      </PromptInputFooter>
    </PromptInput>
  );
}
