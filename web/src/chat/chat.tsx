// The Chat screen (SPEC "Web UI", Chat): the log in a MessageScroller, newest last, older entries
// prepended as the top comes into view; status and errors as markers between rows; the composer
// with send, cancel and the device picker; messages that wait for the model in a Queue above it.
import { Queue, QueueItem, QueueItemContent, QueueItemIndicator, QueueList, QueueSection, QueueSectionContent, QueueSectionLabel, QueueSectionTrigger } from "@/components/ai-elements/queue";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputStop,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Spinner } from "@/components/ui/spinner";
import type { Link } from "@/lib/connection";
import { visible } from "@/lib/log";
import { chatRows, entryRows, type Row, rowFor, rowIndexFor } from "@/lib/rows";
import { type Marker as StatusMarker, queued, type Session, type SessionStore } from "@/lib/session";
import type { Device } from "@wire";
import { AlertCircleIcon, InfoIcon } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatRow } from "./row";

function status(s: Session): string | null {
  if (s.status !== "open") return s.status === "connecting" ? "connecting…" : "disconnected; reconnecting…";
  switch (s.state?.phase) {
    case "waiting":
      return `waiting for ${s.state.waiting} summaries…`;
    case "running":
      return s.thinking ? "thinking…" : `running on ${s.state.device}${s.state.engine ? ` (${s.state.engine})` : ""}`;
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

export type ChatProps = {
  readonly link: Link;
  readonly session: SessionStore;
  readonly state: Session;
  readonly devices: readonly Device[];
  // a log index to show (from the Memory screen); done() once it is in view
  readonly target: number | null;
  readonly onTargetShown: () => void;
};

export function Chat({ link, session, state, devices, target, onTargetShown }: ChatProps) {
  const [loading, setLoading] = useState(false);
  const [device, setDevice] = useState<string | null>(null);
  const { scrollToMessage } = useMessageScroller();
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
        {waiting.length > 0 && (
          <Queue data-testid="queue">
            <QueueSection>
              <QueueSectionTrigger>
                <QueueSectionLabel count={waiting.length} label="waiting for the model" />
              </QueueSectionTrigger>
              <QueueSectionContent>
                <QueueList>
                  {waiting.map(({ error, text }, k) => (
                    // the same text can wait twice; the position tells them apart
                    // oxlint-disable-next-line react/no-array-index-key
                    <QueueItem key={`${k}:${text}`}>
                      <QueueItemIndicator />
                      <div className="min-w-0">
                        <QueueItemContent>{text}</QueueItemContent>
                        {error !== null && (
                          <p className="text-xs text-destructive" data-testid="queue-error" role="alert">
                            not logged: {error}
                          </p>
                        )}
                      </div>
                    </QueueItem>
                  ))}
                </QueueList>
              </QueueSectionContent>
            </QueueSection>
          </Queue>
        )}
        <PromptInput
          onSubmit={(text) => {
            session.send(text, device);
          }}
        >
          <PromptInputBody>
            <PromptInputTextarea aria-label="Message" placeholder={busy ? "Add to the running turn" : "Message"} />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              {devices.length > 1 && (
                <NativeSelect
                  aria-label="Device"
                  onChange={(e) => {
                    setDevice(e.currentTarget.value);
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
                  disabled={state.status !== "open"}
                  onClick={() => {
                    link.abort();
                  }}
                />
              )}
              <PromptInputSubmit />
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
