// The composer (SPEC "Web UI", Chat; "Media"): the text, a tray of attachments, the device picker,
// the model picker (this client's own: each message names its engine), the session's follow-up
// setting, send and stop. A picked, pasted or dropped
// photo is downscaled here and uploaded at once, so it is usually stored (and being described) by
// the time the text is typed; the message goes out over /ws naming each upload by its digest.
// Send waits for every upload, says why while it does, and is on when there is text or a finished
// attachment. The draft (the text and the finished uploads) survives a reload (lib/draft.ts).
// While a turn runs (or waits for a model), send follows the session's follow-up
// setting and a second button (Mod+Enter on a keyboard) sends the other way for this one
// message; stop is beside them, and with nothing to send, send is stop.
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
import type { Uploader } from "@/lib/attach";
import type { Link } from "@/lib/connection";
import { loadDraft, loadHistory, remember, saveDraft } from "@/lib/draft";
import type { Restored, SessionStore } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { Device, FollowUp, SessionState } from "@wire";
import { ListEndIcon, ZapIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { CompactSelect, FollowUps, ModelPicker } from "./pickers";
import { useAttachments } from "./use-attachments";

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
  readonly model: string | null; // the engine the next message is for (the model picker's)
  readonly onModel: (ref: string) => void;
  readonly restored: Restored | null; // a message taken back, to hold again
  readonly uploader?: Uploader; // tests replace the upload
};

export function Composer({ link, session, state, busy, open, devices, device, onDevice, picked, model, onModel, restored, uploader }: ComposerProps) {
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
  // a message sent now meets a turn: one running, or one waiting for a model, which it joins (if
  // it steers and is for the stopped engine) once the turn is resumed
  const running = state?.phase === "running" || state?.phase === "needs-model";
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
    session.send(text, device, tray.ready, running ? how : undefined, model ?? undefined);
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

  const placeholder = running
    ? followUp === "queue"
      ? "Queue a follow-up"
      : state.phase === "needs-model"
        ? "Add to the turn, once it goes on"
        : "Add to the running turn"
    : "Message";
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
          {state && model !== null && <ModelPicker model={model} onModel={onModel} state={state} />}
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
          {busy && (
            <PromptInputStop
              disabled={!open}
              onClick={() => {
                link.abort();
              }}
              title="Stop the turn"
            />
          )}
          {(!busy || content) && <PromptInputSubmit aria-describedby={hint} disabled={blocked !== null || !content} title={blocked ?? sendLabel} />}
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
