// The composer (SPEC "Web UI", Chat; "Media"): the text, a tray of attachments, the device picker,
// the model picker (this client's own: each message names its engine), the session's follow-up
// setting, send and stop. A picked, pasted or dropped
// photo is downscaled here and uploaded at once, so it is usually stored (and being described) by
// the time the text is typed; the message goes out over /ws naming each upload by its digest.
// Send waits for every upload, says why while it does, and is on when there is text or a finished
// attachment. The draft (the text, the folded pastes and the finished uploads) survives a reload
// (lib/draft.ts).
// While a turn runs (or waits for a model), send follows the session's follow-up
// setting and a second button (Mod+Enter on a keyboard) sends the other way for this one
// message; stop is beside them, and with nothing to send, send is stop (and so is Enter). A long
// paste folds into a token and a chip (lib/paste.ts); the message sent has the block in its place.
import {
  PromptInput,
  PromptInputFileInput,
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
import { expand, folds, insert, nextId, type Paste, present, removeToken, tokenOf } from "@/lib/paste";
import { emptyEnterStops, ENTER_AFTER_SEND_MS } from "@/lib/stop-keys";
import type { Restored, SessionStore } from "@/lib/session";
import { cn } from "@/lib/utils";
import type { Device, FollowUp, SessionState } from "@wire";
import { ListEndIcon, ZapIcon } from "lucide-react";
import { type ClipboardEvent, type KeyboardEvent, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AddContext, addContextChoices } from "./add-context";
import { PastedChip, PastePreview } from "./pasted";
import { CompactSelect, FollowUps, ModelPicker } from "./pickers";
import { useAttachments } from "./use-attachments";

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export type ComposerProps = {
  readonly link: Link;
  readonly session: SessionStore;
  readonly state: SessionState | null; // the server's
  readonly busy: boolean; // a turn runs or waits
  readonly attached?: boolean; // the held/queue tray sits on the composer's top edge
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

export function Composer({ link, session, state, busy, attached = false, open, devices, device, onDevice, picked, model, onModel, restored, uploader }: ComposerProps) {
  const saved = useMemo(loadDraft, []); // read once: the composer owns the draft from here
  const tray = useAttachments(uploader, saved?.media);
  const [text, setText] = useState(saved?.text ?? "");
  // the long pastes folded into the text's tokens; only those whose token is still there count
  const [pastes, setPastes] = useState<readonly Paste[]>(saved?.pastes ?? []);
  const folded = present(text, pastes);
  const [peek, setPeek] = useState<number | null>(null); // the paste whose preview is open
  const caret = useRef<number | null>(null); // where the caret goes once a token is in the text
  const sentAt = useRef(Number.NEGATIVE_INFINITY); // when this composer last sent, on this page's clock
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
  // the turn's engine (the stopped one while it waits): a message for another one waits for a
  // turn of its own, whatever the follow-up setting, so there is no other way to send it
  const turnEngine = state?.engine ?? state?.stopped?.ref ?? null;
  const elsewhere = running && model !== null && turnEngine !== null && model !== turnEngine;
  const followUp = state?.followUp ?? "steer";
  const other: FollowUp = followUp === "steer" ? "queue" : "steer";
  const content = text.trim() !== "" || tray.items.length > 0; // a folded paste is a token in the text
  // the second send button shows: a narrow footer has to make room for it
  const crowded = running && !elsewhere && content;
  // the hidden pickers the "+" sheet opens (./add-context.tsx)
  const library = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);

  // the draft as it stands, kept for a reload: the text and the uploads that finished
  const readyKey = tray.ready.map((a) => a.sha).join(",");
  useEffect(() => {
    saveDraft({ media: tray.ready, pastes: present(text, pastes), text });
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- readyKey stands for tray.ready, a new array each render
  }, [text, readyKey, pastes]);

  // a token just pasted: the caret after it, as after any paste
  useLayoutEffect(() => {
    const at = caret.current;
    const el = document.getElementById(box);
    if (at === null || !(el instanceof HTMLTextAreaElement)) return;
    caret.current = null;
    el.setSelectionRange(at, at);
  }, [text, box]);

  // A pasted block long enough to fold goes in as its token, over the selection; a shorter one, or
  // files (the tray's), are pasted as ever. Line ends are the textarea's own, \n, as when it pastes.
  const paste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (e.clipboardData.files.length > 0) return;
    const block = e.clipboardData.getData("text/plain").replaceAll(/\r\n?/g, "\n");
    if (!folds(block)) return;
    e.preventDefault();
    const p = { id: nextId(pastes), text: block };
    const el = e.currentTarget;
    const put = insert(text, el.selectionStart, el.selectionEnd, tokenOf(p));
    caret.current = put.caret;
    setPastes([...folded, p]);
    setText(put.text);
    setRecalled(null);
  };
  const unpaste = (p: Paste) => {
    setText((now) => removeToken(now, p));
    setPastes((now) => now.filter((q) => q.id !== p.id));
    if (peek === p.id) setPeek(null);
    document.getElementById(box)?.focus();
  };

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
    // the text as typed, each folded paste back in its token's place; where they are goes with it, to fold them in the chat
    const whole = expand(text, folded);
    session.send(whole.text, { device: device ?? undefined, engine: model ?? undefined, followUp: running ? how : undefined, media: tray.ready, spans: whole.spans });
    if (whole.text.trim() !== "") {
      remember(whole.text);
      history.current = [...history.current.filter((t) => t !== whole.text), whole.text];
    }
    sentAt.current = Date.now();
    setText("");
    setPastes([]);
    setPeek(null);
    setRecalled(null);
    tray.clear();
  };

  // Up in an empty composer (on a keyboard) recalls this client's previous messages, Down goes
  // back toward the newest; only while the text is what was recalled, so editing it keeps it.
  // Mod+Enter sends the other way while a turn runs.
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    // nothing to send while a turn runs: Enter is Stop, as the button is; not an Enter that comes
    // right after one that sent (pressed twice), which would stop the turn the message just joined
    const settled = Date.now() - sentAt.current > ENTER_AFTER_SEND_MS;
    if (busy && open && settled && emptyEnterStops(e.nativeEvent, { empty: !content, touch })) {
      e.preventDefault();
      if (state?.loop !== undefined) link.abort(state.loop); // the run the user saw (E41), as Stop sends
      return;
    }
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

  const placeholder = elsewhere
    ? "For the next turn (another model)"
    : running
      ? followUp === "queue"
        ? "Queue a follow-up"
        : state.phase === "needs-model"
          ? "Add to the turn, once it goes on"
          : "Add to the running turn"
      : "Message";
  const sendLabel = elsewhere
    ? "Send (waits for the next turn: another model)"
    : running && followUp === "queue"
      ? "Send (queued for the next turn)"
      : running
        ? "Send (joins the running turn)"
        : "Send";
  const otherLabel = other === "steer" ? "Send now" : "Queue for the next turn";
  return (
    <PromptInput
      attached={attached}
      below={
        <p
          aria-live="polite"
          className={cn("px-4 pt-2 text-center text-2xs text-muted-foreground", blocked === null && "hidden pointer-fine:sm:block")}
          data-testid="composer-hint"
          id={hint}
        >
          {blocked ??
            (touch
              ? null
              : `Enter to send · Shift+Enter new line${running && !elsewhere ? ` · Ctrl/⌘+Enter ${other === "steer" ? "sends now" : "queues"}` : ""}${busy ? " · Esc stops" : history.current.length > 0 ? " · ↑ last message" : ""}`)}
        </p>
      }
      canSubmit={sendable}
      // Esc closes an open paste preview, and is taken so it stops nothing (lib/stop-keys.ts)
      onKeyDown={(e) => {
        if (e.key !== "Escape" || peek === null || e.nativeEvent.isComposing) return;
        e.preventDefault();
        setPeek(null);
      }}
      onFiles={tray.add}
      onSubmit={() => {
        send();
      }}
    >
      {(tray.items.length > 0 || tray.notice !== null || folded.length > 0) && (
        <PromptInputAttachments>
          {folded.map((p) => (
            <PastedChip
              key={`paste-${p.id}`}
              onOpen={() => {
                setPeek(peek === p.id ? null : p.id);
              }}
              onRemove={() => {
                unpaste(p);
              }}
              open={peek === p.id}
              paste={p}
            />
          ))}
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
          {folded
            .filter((p) => p.id === peek)
            .map((p) => (
              <PastePreview key={`peek-${p.id}`} paste={p} />
            ))}
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
          onPaste={paste}
          id={box}
          placeholder={placeholder}
          value={text}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <PromptInputTools>
          <PromptInputFileInput accept="image/*,video/*" label="Attach" onFiles={tray.add} ref={library} />
          <PromptInputFileInput accept="image/*" capture="environment" label="Take a photo" onFiles={tray.add} ref={camera} />
          <AddContext choices={addContextChoices(library, camera, touch)} />
          {state && model !== null && <ModelPicker model={model} onModel={onModel} state={state} />}
          {devices.length > 1 && (
            // on a narrow screen with the second send button showing, the device makes room: it
            // is for the next turn, and comes back when the draft is sent
            <span className={cn("contents", crowded && "max-[419px]:hidden")}>
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
            </span>
          )}
          {state && <FollowUps followUp={state.followUp} link={link} />}
        </PromptInputTools>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {crowded && (
            <InputGroupButton
              aria-label={otherLabel}
              disabled={blocked !== null}
              onClick={() => {
                send(other);
              }}
              className="h-9 rounded-full bg-soft px-3 text-ui text-foreground hover:bg-soft-strong max-[399px]:w-9 max-[399px]:px-0 pointer-coarse:h-10 max-[399px]:pointer-coarse:w-10"
              size="sm"
              title={`${otherLabel} (Ctrl/⌘+Enter)`}
              variant="ghost"
            >
              {other === "steer" ? <ZapIcon /> : <ListEndIcon />}
              <span className="hidden min-[400px]:inline">{other === "steer" ? "Now" : "Queue"}</span>
            </InputGroupButton>
          )}
          {busy && (
            <PromptInputStop
              disabled={!open}
              onClick={() => {
                if (state?.loop !== undefined) link.abort(state.loop);
              }}
              title="Stop the turn"
            />
          )}
          {(!busy || content) && <PromptInputSubmit aria-describedby={hint} disabled={blocked !== null || !content} title={blocked ?? sendLabel} />}
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
}
