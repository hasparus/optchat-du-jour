// The Chat screen (SPEC "Web UI", Chat): the log in a MessageScroller, newest last, older entries
// prepended as the top comes into view; status and errors as markers between rows; the composer
// (./composer.tsx); messages that wait for the model in a Queue above it, each with its
// attachments, whether it is queued for a later turn, and (while it can be) a take-back.
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemContent,
  QueueItemIndicator,
  QueueList,
  QueueSection,
  QueueSectionContent,
  QueueSectionLabel,
  QueueSectionTrigger,
} from "@/components/ai-elements/queue";
import { Button } from "@/components/ui/button";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
  useMessageScroller,
  useMessageScrollerScrollable,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import type { Link } from "@/lib/connection";
import { visible } from "@/lib/log";
import { chatRows, entryRows, type Row, rowFor, rowIndexFor } from "@/lib/rows";
import { type Marker as StatusMarker, type Queued, queued, type Session, type SessionStore } from "@/lib/session";
import { type Device, engineLabel, type SessionState, shortSha } from "@wire";
import { AlertCircleIcon, FilmIcon, InfoIcon, Undo2Icon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Uploader } from "@/lib/attach";
import { loadModel, saveModel } from "@/lib/draft";
import { Composer } from "./composer";
import { shortLabel } from "./pickers";
import { ChatRow } from "./row";

function status(s: Session): string | null {
  if (s.status !== "open") return s.status === "connecting" ? "connecting…" : "disconnected; reconnecting…";
  switch (s.state?.phase) {
    case "waiting":
      return `waiting for ${s.state.waiting} summaries…`;
    case "running":
      return s.thinking ? "thinking…" : `running on ${s.state.device}${s.state.engine ? ` (${s.state.engine})` : ""}`;
    case "needs-model": // said by its own banner
    case "idle":
    case undefined:
      return null;
  }
}

function StatusRow({ marker }: { marker: StatusMarker }) {
  return (
    <Marker className={marker.tone === "error" ? "text-destructive" : undefined} data-testid={`marker-${marker.tone}`} role={marker.tone === "error" ? "alert" : "status"}>
      <MarkerIcon>{marker.tone === "error" ? <AlertCircleIcon /> : <InfoIcon />}</MarkerIcon>
      <MarkerContent>{marker.text}</MarkerContent>
    </Marker>
  );
}

// The markers by the row they follow (the last one starting at or before their log index), in the
// order they came; `above` are those over the first row. One pass, with a streamed token each.
const placeMarkers = (markers: readonly StatusMarker[], rows: readonly Row[]) => {
  const above: StatusMarker[] = [];
  const after = new Map<number, StatusMarker[]>();
  for (const m of markers) {
    const k = rowIndexFor(rows, m.after);
    if (k === -1) above.push(m);
    else after.set(k, [...(after.get(k) ?? []), m]);
  }
  return { above, after };
};

// One message in the queue: its text, its attachments' thumbnails (our own /api/assets, as the
// chat shows a logged message's), where it stands, its engine when it is not the composer's
// `model`, and a take-back while it is still held. `asking`: its take-back is asked for and not
// answered yet (a reconnect forgets that)
function Waiting({ q, asking, model, onTakeBack }: { readonly q: Queued; readonly asking: boolean; readonly model: string | null; readonly onTakeBack: () => void }) {
  const queuedHere = q.where === "queued";
  const other = q.engine !== null && q.engine !== model ? engineLabel(q.engine) : null;
  return (
    <QueueItem data-state={q.where} data-testid="queue-item">
      <QueueItemIndicator className={queuedHere ? "border-dashed" : q.where === "sent" ? "border-primary bg-primary/30" : undefined} />
      <div className="min-w-0 grow">
        {q.text.trim() !== "" && <QueueItemContent>{q.text}</QueueItemContent>}
        {q.media.length > 0 && (
          <div className="mt-1 flex gap-1" data-testid="queue-media">
            {q.media.map((a) =>
              a.kind === "image" ? (
                <img
                  alt={`image ${shortSha(a.sha)}`}
                  className="size-8 rounded-sm border object-cover"
                  key={a.sha}
                  src={`/api/assets/${shortSha(a.sha)}/thumb`}
                />
              ) : (
                <span aria-label={`video ${shortSha(a.sha)}`} className="flex size-8 items-center justify-center rounded-sm border bg-muted" key={a.sha} role="img">
                  <FilmIcon className="size-4" />
                </span>
              ),
            )}
          </div>
        )}
        {(q.where !== "failed" || other !== null) && (
          <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            {other !== null && (
              <span className="shrink-0 rounded-sm border px-1 font-medium text-foreground" data-testid="queue-engine" title={`for ${other}`}>
                {shortLabel(other)}
              </span>
            )}
            {q.where !== "failed" && <span data-testid="queue-where">{queuedHere ? "queued for the next turn" : q.where === "sent" ? "the turn has it" : "sending…"}</span>}
          </p>
        )}
        {q.error !== null && (
          <p className="text-xs text-destructive" data-testid="queue-error" role="alert">
            not logged: {q.error}
          </p>
        )}
      </div>
      {q.back !== null && (
        <QueueItemAction
          aria-label={`Take back: ${q.text.trim() === "" ? `${q.media.length} attachments` : q.text}`}
          disabled={asking && q.back === "server"}
          onClick={() => {
            onTakeBack();
          }}
          title="Back into the composer, to edit or send later"
        >
          <Undo2Icon />
        </QueueItemAction>
      )}
    </QueueItem>
  );
}

// A turn stopped on a usage limit or an offline device: which engine and why, and a button per
// engine to resume it on (the stopped one again is a retry; another that hit a limit is disabled,
// with why). A resume is the one model frame the page sends; the composer's picker follows it.
// Stop, in the composer, ends the turn instead.
function NeedsModel({ session, state, onModel }: { readonly session: Pick<SessionStore, "resume">; readonly state: SessionState; readonly onModel: (ref: string) => void }) {
  const { stopped } = state;
  if (stopped === null) return null;
  return (
    <div className="space-y-2 rounded-lg border border-destructive/50 bg-destructive/5 p-2.5 text-sm" data-testid="needs-model" role="alert">
      <p>
        <span className="font-medium">{stopped.label}</span>: {stopped.why}. Pick a model to go on.
      </p>
      <div className="flex flex-wrap gap-1.5">
        {state.engines.map((e) => {
          const again = e.ref === stopped.ref;
          const out = e.down !== null && !again;
          return (
            <Button
              disabled={out}
              key={e.ref}
              onClick={() => {
                if (session.resume(e.ref)) onModel(e.ref);
              }}
              size="sm"
              title={e.down !== null && !again ? `unavailable: ${e.down}` : undefined}
              variant={again ? "outline" : "default"}
            >
              {again ? `Try ${e.label} again` : `Continue with ${e.label}`}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export type ChatProps = {
  readonly link: Link;
  readonly session: SessionStore;
  readonly state: Session;
  readonly devices: readonly Device[];
  // a log index to show (from the Memory screen); done() once it is in view
  readonly target: number | null;
  readonly onTargetShown: () => void;
  readonly uploader?: Uploader; // tests replace PUT /api/assets
};

export function Chat({ link, session, state, devices, target, onTargetShown, uploader }: ChatProps) {
  const [loading, setLoading] = useState(false);
  const [device, setDevice] = useState<string | null>(null);
  // the model picker: this page's own, kept in localStorage; one the chain no longer has (or none)
  // shows as the chain's first
  const [chosen, setChosen] = useState(loadModel);
  const engines = state.state?.engines ?? [];
  const model = engines.some((e) => e.ref === chosen) ? chosen : (engines[0]?.ref ?? null);
  const onModel = useCallback((ref: string) => {
    setChosen(ref);
    saveModel(ref);
  }, []);
  const { scrollToMessage } = useMessageScroller();
  // at the newest end (nothing more to scroll to): the store may drop what is far out of sight
  const atEnd = !useMessageScrollerScrollable().end;
  useEffect(() => {
    session.scrolled(atEnd);
  }, [session, atEnd]);
  const top = useRef<HTMLDivElement>(null);

  // the entries change when one is logged, the draft with every streamed piece
  const { base, draft, items: held } = state.log;
  const items = useMemo(() => visible({ base, items: held }), [base, held]);
  const settled = useMemo(() => entryRows(items), [items]);
  const rows = useMemo(() => chatRows(items, settled, draft), [items, settled, draft]);
  const placed = placeMarkers(state.markers, rows);
  const draftKey = draft ? `e${draft.i}` : null;
  const first = rows[0]?.id ?? 0;
  const busy = state.state !== null && state.state.phase !== "idle";
  const waiting = queued(state);
  const line = status(state);

  // one older page, prepended: true while there may be more, null when it couldn't be read
  const loadOlder = useCallback(async () => {
    if (loading || first <= 0) return false;
    setLoading(true);
    try {
      return await session.loadOlder();
    } catch {
      return null;
    } finally {
      setLoading(false);
    }
  }, [first, loading, session]);

  // the top in view: the page before it
  useEffect(() => {
    const el = top.current;
    if (!el || !("IntersectionObserver" in globalThis)) return;
    const io = new IntersectionObserver((seen) => {
      if (seen.some((e) => e.isIntersecting)) void loadOlder();
    });
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [loadOlder]);

  // "show in chat": load pages until the message is among the rows, then scroll to it
  useEffect(() => {
    if (target === null || loading) return;
    if (rows.length > 0 && first > target) {
      void loadOlder().then((more) => {
        if (more === null) onTargetShown(); // offline: give up rather than retry for ever
      });
      return;
    }
    const row = rowFor(rows, target);
    if (row) scrollToMessage(row.key, { align: "start" });
    onTargetShown();
  }, [target, rows, first, loading, loadOlder, scrollToMessage, onTargetShown]);

  const lastTool = rows.findLast((r) => r.kind === "tool")?.key;
  const picked = device ?? state.state?.device ?? devices.find((d) => d.local)?.name ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport aria-label="Chat" preserveScrollOnPrepend>
          <MessageScrollerContent className="gap-4 p-4">
            <div className="flex justify-center" ref={top}>
              {first > 0 && (
                <button className="text-xs text-muted-foreground underline" disabled={loading} onClick={() => void loadOlder()} type="button">
                  {loading ? "loading…" : "earlier messages"}
                </button>
              )}
            </div>
            {placed.above.map((m) => (
              <StatusRow key={`k${m.key}`} marker={m} />
            ))}
            {rows.map((row, k) => (
              <Fragment key={row.key}>
                <MessageScrollerItem data-log-index={row.id} messageId={row.key} scrollAnchor={row.kind === "user"}>
                  <ChatRow
                    row={row}
                    streaming={row.key === draftKey}
                    toolState={row.kind === "tool" && row.output !== null ? "done" : busy && row.key === lastTool ? "running" : "ended"}
                  />
                </MessageScrollerItem>
                {placed.after.get(k)?.map((m) => (
                  <StatusRow key={`k${m.key}`} marker={m} />
                ))}
              </Fragment>
            ))}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>

      <div className="space-y-2 border-t bg-background p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
        {line !== null && (
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground" data-testid="status" role="status">
            {busy && <Spinner className="size-3" />}
            {line}
          </div>
        )}
        {state.state?.phase === "needs-model" && <NeedsModel onModel={onModel} session={session} state={state.state} />}
        {waiting.length > 0 && (
          <Queue data-testid="queue">
            <QueueSection>
              <QueueSectionTrigger>
                <QueueSectionLabel count={waiting.length} label="waiting for the model" />
              </QueueSectionTrigger>
              <QueueSectionContent>
                <QueueList>
                  {waiting.map((q) => (
                    <Waiting asking={q.clientId !== null && state.asking.includes(q.clientId)} key={q.key} model={model} onTakeBack={() => {
                        session.takeBack(q);
                      }} q={q} />
                  ))}
                </QueueList>
              </QueueSectionContent>
            </QueueSection>
          </Queue>
        )}
        <Composer
          busy={busy}
          device={device}
          devices={devices}
          link={link}
          model={model}
          onDevice={setDevice}
          onModel={onModel}
          open={state.status === "open"}
          picked={picked}
          restored={state.restored}
          session={session}
          state={state.state}
          uploader={uploader}
        />
      </div>
    </div>
  );
}
