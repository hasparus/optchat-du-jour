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
import { Shimmer } from "@/components/ai-elements/shimmer";
import type { Link } from "@/lib/connection";
import { visible } from "@/lib/log";
import { chatRows, entryRows, planStates, type Row, rowFor, rowIndexFor, thoughtHolder, toolStateOf, turnSources } from "@/lib/rows";
import { type Marker as StatusMarker, type Queued, queued, type Session, type SessionStore } from "@/lib/session";
import { canonicalRef, type Device, engineLabel, type SessionState, shortSha } from "@wire";
import { cn } from "@/lib/utils";
import { AlertCircleIcon, FilmIcon, InfoIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import { Fragment, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SheetDrawer } from "@/components/sheet-drawer";
import { madeBy } from "@/lib/artifacts";
import { ArtifactCard, draftDetail } from "./artifact-card";
import { useArtifactList, useWide } from "./use-artifacts";
import type { Uploader } from "@/lib/attach";
import { loadModel, saveModel } from "@/lib/draft";
import { Composer } from "./composer";
import { shortLabel } from "./pickers";
import { ChatRow, ReplyActions } from "./row";
import { useStickToEnd } from "./use-stick-to-end";

// The preview pane is only fetched when an artifact is first opened (its draft preview and export
// with it), so the chat's first paint doesn't wait for it
const ArtifactPane = lazy(async () => {
  const module = await import("./artifact-pane");
  return { default: module.ArtifactPane };
});

// an engine of the master's chain by the label its picker shows (with its effort, src/wire.ts
// engineLabel), else as its ref reads
const labelOf = (state: SessionState | null, ref: string) => state?.engines.find((e) => e.ref === ref)?.label ?? engineLabel(ref);

function status(s: Session): string | null {
  if (s.status !== "open") return s.status === "connecting" ? "connecting…" : "disconnected; reconnecting…";
  switch (s.state?.phase) {
    case "waiting":
      return `waiting for ${s.state.waiting} summaries…`;
    case "running":
      return s.thinking ? "thinking…" : `running on ${s.state.device}${s.state.engine ? `, ${labelOf(s.state, s.state.engine)}` : ""}`;
    case "needs-model": // said by its own banner
    case "idle":
    case undefined:
      return null;
  }
}

function StatusRow({ marker }: { marker: StatusMarker }) {
  return (
    <Marker
      className={cn("w-fit max-w-full gap-1.5 self-center rounded-full px-2.5 py-1 text-xs", marker.tone === "error" ? "bg-destructive/8 text-destructive" : "text-muted-foreground")}
      data-testid={`marker-${marker.tone}`}
      role={marker.tone === "error" ? "alert" : "status"}
    >
      <MarkerIcon className="size-3.5 [&_svg:not([class*='size-'])]:size-3.5">{marker.tone === "error" ? <AlertCircleIcon /> : <InfoIcon />}</MarkerIcon>
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
function Waiting({ q, asking, model, state, onTakeBack }: { readonly q: Queued; readonly asking: boolean; readonly model: string | null; readonly state: SessionState | null; readonly onTakeBack: () => void }) {
  const queuedHere = q.where === "queued";
  const other = q.engine !== null && q.engine !== model ? labelOf(state, q.engine) : null;
  return (
    <QueueItem data-state={q.where} data-testid="queue-item">
      <QueueItemIndicator className={queuedHere ? "border-dashed" : q.where === "sent" ? "animate-breathe border-signal bg-signal" : q.where === "failed" ? "border-destructive bg-destructive" : undefined} />
      <span className="block min-w-0 grow">
        {q.text.trim() !== "" && <QueueItemContent>{q.text}</QueueItemContent>}
        {q.media.length > 0 && (
          <span className="mt-1 flex gap-1" data-testid="queue-media">
            {q.media.map((a) =>
              a.kind === "image" ? (
                <img
                  alt={`image ${shortSha(a.sha)}`}
                  className="size-9 rounded-md border object-cover"
                  key={a.sha}
                  src={`/api/assets/${shortSha(a.sha)}/thumb`}
                />
              ) : (
                <span aria-label={`video ${shortSha(a.sha)}`} className="flex size-9 items-center justify-center rounded-md border bg-muted" key={a.sha} role="img">
                  <FilmIcon className="size-4" />
                </span>
              ),
            )}
          </span>
        )}
        {(q.where !== "failed" || other !== null) && (
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
            {other !== null && (
              <span className="shrink-0 rounded-sm px-1 font-medium text-foreground hairline-strong" data-testid="queue-engine" title={`for ${other}`}>
                {shortLabel(other)}
              </span>
            )}
            {q.where !== "failed" && <span data-testid="queue-where">{queuedHere ? "queued for the next turn" : q.where === "sent" ? "the turn has it" : "sending…"}</span>}
          </span>
        )}
        {q.error !== null && (
          <span className="block text-xs text-destructive" data-testid="queue-error" role="alert">
            not logged: {q.error}
          </span>
        )}
      </span>
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
    <div className="flex gap-2.5 bg-warning-surface px-3.5 py-3 text-ui" data-testid="needs-model" role="alert">
      <TriangleAlertIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="min-w-0 space-y-2.5">
        <p className="text-foreground">
          <span className="font-semibold">{stopped.label}</span>: {stopped.why}. <span className="text-warning-foreground">Choose how to go on:</span>
        </p>
        <div className="flex flex-wrap gap-1.5">
          {state.engines.map((e) => {
            const again = e.ref === stopped.ref;
            const out = e.down !== null && !again;
            return (
              <Button
                className="h-8 rounded-lg pointer-coarse:h-10"
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
    </div>
  );
}

// A log with nothing in it yet: what this chat is, once, instead of a blank page
function EmptyChat() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-8" data-testid="empty-chat">
      <div className="max-w-sm space-y-2 text-center">
        <p className="text-xl font-semibold tracking-tight text-foreground">One chat, for good</p>
        <p className="text-read text-muted-foreground">Everything said here stays: it is folded into a memory the model reads at every turn, and can zoom back into.</p>
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
  // the running turn's status line was tapped: open Background work
  readonly onWork?: () => void;
  readonly uploader?: Uploader; // tests replace PUT /api/assets
};

export function Chat({ link, session, state, devices, target, onTargetShown, onWork, uploader }: ChatProps) {
  const [loading, setLoading] = useState(false);
  // the artifacts (SPEC "Artifacts"): their list, read again when a version is saved; the one the
  // pane shows (v null: its latest), beside the chat on a wide screen, in a sheet on a phone
  const artifacts = useArtifactList(state.saved, state.status === "open");
  const [pane, setPane] = useState<{ readonly name: string; readonly v: number | null } | null>(null);
  const wide = useWide();
  const openArtifact = useCallback((name: string, v: number | null) => {
    setPane({ name, v });
  }, []);
  const paneInfo = pane === null ? null : (artifacts.find((a) => a.name.toLowerCase() === pane.name.toLowerCase()) ?? null);
  const paneDraft = pane === null ? null : ([...state.drafts.values()].findLast((d) => d.name?.toLowerCase() === pane.name.toLowerCase()) ?? null);
  const drafting = [...state.drafts.values()].filter((d) => !d.closed);
  const [device, setDevice] = useState<string | null>(null);
  // the model picker: this page's own, kept in localStorage. Before the first state it is sent as
  // kept (a message sent then, or offline, still names it); once the state shows the chain, it is
  // read as the chain's refs are (an effort equal to the master's is the bare ref, so a pick kept
  // before that effort changed still finds its engine, and is kept so), and one the chain lacks
  // (or none) is the chain's first.
  const [chosen, setChosen] = useState(loadModel);
  const engines = state.state?.engines;
  const kept = chosen === null || state.state === null ? chosen : canonicalRef(chosen, state.state.effort);
  const model = engines === undefined ? chosen : engines.some((e) => e.ref === kept) ? kept : (engines[0]?.ref ?? null);
  const onModel = useCallback((ref: string) => {
    setChosen(ref);
    saveModel(ref);
  }, []);
  useEffect(() => {
    if (kept !== null && kept !== chosen && engines?.some((e) => e.ref === kept)) onModel(kept);
  }, [kept, chosen, engines, onModel]);
  const { scrollToEnd, scrollToMessage } = useMessageScroller();
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
  // a thought streaming in before anything it came before has arrived is a row of its own (rows.ts)
  const { thoughts } = state;
  const live = useMemo(() => [...thoughts.values()].find((t) => t.live), [thoughts]);
  const thinkingAt = live?.i ?? null;
  const rows = useMemo(() => chatRows(items, settled, draft, thinkingAt), [items, settled, draft, thinkingAt]);
  // the row the live thought shows above, given to it as is (rows.ts thoughtHolder)
  const holder = useMemo(() => (thinkingAt === null ? undefined : thoughtHolder(rows, thinkingAt)?.key), [rows, thinkingAt]);
  const placed = placeMarkers(state.markers, rows);
  const draftKey = draft ? `e${draft.i}` : null;
  const first = rows[0]?.id ?? 0;
  const busy = state.state !== null && state.state.phase !== "idle";
  const waiting = queued(state);
  // the tray on the composer's top edge shows a turn waiting for a model, or messages waiting
  const tray = state.state?.phase === "needs-model" || waiting.length > 0;
  const line = status(state);
  // the server says the log is empty: a first visit, not a page still loading
  const empty = state.state !== null && rows.length === 0 && state.markers.length === 0;
  // a reader at the newest row stays there as the dock grows (./use-stick-to-end.ts)
  const dock = useRef<HTMLDivElement>(null);
  const toEnd = useCallback(() => {
    scrollToEnd({ behavior: "auto" });
  }, [scrollToEnd]);
  const root = useRef<HTMLDivElement>(null);
  useStickToEnd(dock, root, atEnd && !busy && target === null, toEnd);

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
  // a plan is live only in the run that goes on now: from the user entry RUN_STARTED named
  const liveFrom = state.run !== null && state.state?.phase === "running" ? state.run : null;
  // each turn's plan (its last TodoWrite; one live per run) and its sources under its last reply;
  // a turn whose sources didn't change keeps its array (rows.ts), so its reply isn't drawn again
  const plans = useMemo(() => planStates(rows, liveFrom), [rows, liveFrom]);
  const sources = useMemo(() => turnSources(rows), [rows]);
  const picked = device ?? state.state?.device ?? devices.find((d) => d.local)?.name ?? null;

  const paneView =
    pane === null ? null : (
      <Suspense fallback={<p className="p-6 text-ui text-muted-foreground">Loading…</p>}>
        <ArtifactPane
          draft={paneDraft}
          heading={wide}
          info={paneInfo}
          name={pane.name}
          onClose={
            wide
              ? () => {
                  setPane(null);
                }
              : undefined
          }
          onVersion={(v) => {
            setPane({ name: pane.name, v });
          }}
          v={pane.v}
        />
      </Suspense>
    );

  return (
    <div className="flex min-h-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" ref={root}>
        <MessageScroller className="min-h-0 flex-1">
          {/* The sentinel and the "earlier" button sit outside the content: the scroller reads its
              content's first child to keep the view still when older rows are prepended, and opens
              at the newest row only when the first rows arrive into an empty content. */}
          {/* focus and scroll-into-view stop short of the floating dock (WCAG 2.4.11: a focused control
              is never hidden under it) */}
          <MessageScrollerViewport aria-label="Chat" className="relative scroll-pb-(--dock-h)" preserveScrollOnPrepend>
            <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px" ref={top} />
            {first > 0 && (
              <div className="flex justify-center pt-4">
                <button
                  className="min-h-8 rounded-full px-3 text-xs text-muted-foreground hairline transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60 pointer-coarse:min-h-10"
                  disabled={loading}
                  onClick={() => void loadOlder()}
                  type="button"
                >
                  {loading ? <Shimmer>loading…</Shimmer> : "earlier messages"}
                </button>
              </div>
            )}
            {empty && <EmptyChat />}
            {/* the dock floats over the transcript's end; the content keeps its height clear below
                the last row (--dock-h, set by useStickToEnd) */}
            <ReplyActions>
              <MessageScrollerContent className="mx-auto w-full max-w-184 gap-0 px-4 pt-6 pb-[calc(var(--dock-h,9rem)+1.5rem)] sm:px-6" data-region="chat-content">
                {placed.above.map((m) => (
                  <StatusRow key={`k${m.key}`} marker={m} />
                ))}
                {rows.map((row, k) => (
                  <Fragment key={row.key}>
                    <MessageScrollerItem data-kind={row.kind} data-log-index={row.id} messageId={row.key} scrollAnchor={row.kind === "user"}>
                      <ChatRow
                        plan={plans.get(row.key)}
                        row={row}
                        sources={sources.get(row.key)}
                        streaming={row.key === draftKey}
                        onThought={session.toggleThought}
                        thought={row.key === holder ? live : row.kind === "talk" || row.kind === "tool" ? thoughts.get(row.id) : undefined}
                        toolState={row.kind === "tool" ? toolStateOf(row, busy, row.key === lastTool) : "done"}
                        made={madeBy(row, artifacts)}
                        onArtifact={openArtifact}
                      />
                    </MessageScrollerItem>
                    {placed.after.get(k)?.map((m) => (
                      <StatusRow key={`k${m.key}`} marker={m} />
                    ))}
                  </Fragment>
                ))}
                {/* an artifact the model is still writing, after the running turn's rows until its
                    call is in the log (SPEC "Artifacts") */}
                {drafting.map((d) => (
                  <div className="py-1" data-testid="artifact-drafting" key={`draft-${d.id}`}>
                    <ArtifactCard
                      detail={draftDetail(d)}
                      live
                      name={d.name ?? "New artifact"}
                      onOpen={() => {
                        if (d.name !== null) openArtifact(d.name, null);
                      }}
                      testId="artifact-draft-card"
                    />
                  </div>
                ))}
              </MessageScrollerContent>
            </ReplyActions>
          </MessageScrollerViewport>
          <MessageScrollerButton className="size-9 rounded-full border-0 bg-raised text-foreground shadow-float hover:bg-raised hover:text-foreground data-[direction=end]:bottom-[calc(var(--dock-h,9rem)+0.75rem)]" />
        </MessageScroller>

        {/* The dock floats over the end of the transcript, which scrolls on under the composer's
            translucent surface: a fade from clear (24 px above it) to the sheet at 80% by the
            composer's top and solid at the bottom keeps what passes under it soft and the text on it
            legible (DESIGN.md, Composer). Only its controls take pointer events. */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 z-10 before:absolute before:inset-x-0 before:-top-6 before:bottom-0 before:bg-[linear-gradient(to_bottom,transparent,color-mix(in_oklch,var(--background)_80%,transparent)_3rem,var(--background))]"
          data-testid="dock"
          ref={dock}
        >
          <div className="pointer-events-auto relative mx-auto w-full max-w-184 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4 sm:pb-[max(1rem,env(safe-area-inset-bottom))]">
            {line !== null && (
              <div className="flex h-7 items-center gap-2 px-3 text-xs" data-testid="status" role="status">
                {busy ? (
                  // a tap on the running turn's line opens Background work (./background-work.tsx)
                  <button
                    className="relative -mx-1 flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 text-left after:absolute after:-inset-y-1.5 after:inset-x-0 hover:text-foreground"
                    onClick={onWork}
                    title="Background work"
                    type="button"
                  >
                    <span aria-hidden="true" className="size-1.5 shrink-0 animate-breathe rounded-full bg-signal" />
                    <Shimmer>{line}</Shimmer>
                  </button>
                ) : (
                  <span className="text-muted-foreground">{line}</span>
                )}
              </div>
            )}
            {tray && (
              // the tray on the composer's top edge: the same glass, as wide, its top corners on the
              // glass radius and the composer's squared under it, so the two read as one shape whose
              // rings meet in one line (and one focus ring, glass-tray)
              <div className="glass-surface glass-tray relative overflow-hidden rounded-t-glass [&>*+*]:border-t" data-testid="composer-tray">
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
                            <Waiting
                              asking={q.clientId !== null && state.asking.includes(q.clientId)}
                              key={q.key}
                              model={model}
                              onTakeBack={() => {
                                session.takeBack(q);
                              }}
                              q={q}
                              state={state.state}
                            />
                          ))}
                        </QueueList>
                      </QueueSectionContent>
                    </QueueSection>
                  </Queue>
                )}
              </div>
            )}
            <Composer
              attached={tray}
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
      </div>
      {/* the pane: a side panel from 1024 px, a sheet from the bottom on a phone (DESIGN.md, Artifacts) */}
      {wide && paneView !== null && (
        <aside className="flex w-[min(46rem,50vw)] shrink-0 flex-col border-l bg-background px-2 pb-2" data-testid="artifact-side">
          {paneView}
        </aside>
      )}
      {!wide && (
        <SheetDrawer
          className="h-[calc(100dvh-env(safe-area-inset-top)-1.5rem)] data-[vaul-drawer-direction=bottom]:max-h-none"
          description="The artifact, its versions, and copy, download or open it"
          onOpenChange={(open) => {
            if (!open) setPane(null);
          }}
          open={pane !== null}
          testId="artifact-sheet"
          title={paneInfo?.name ?? pane?.name ?? "Artifact"}
        >
          <div className="flex min-h-0 flex-1 flex-col pb-1">{paneView}</div>
        </SheetDrawer>
      )}
    </div>
  );
}
