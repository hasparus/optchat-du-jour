// Background work (DESIGN.md, Background work): what the server is doing besides the chat in front
// of you, in the app's sheet (components/sheet-drawer.tsx: from the bottom on a phone, a side panel
// on a wide screen), opened from the header or from the status line. Modelled on Claude's
// "Background tasks" sheet: groups of trace lines (shadcn's Trace), each with an icon, a title, its
// kind and its state, and a Stop or take-back beside the lines that have one.
//
// It shows only what the server tells: the running turn (its engine, device, how long, and Stop),
// the messages held for a later turn (each with take-back), the compactor's calls per level of the
// tree (SessionState.compactions) and the device runners' connection (/api/devices, read again
// each time the sheet opens). Nothing is kept once it ends: there is no "finished" history, since
// the server has none to give, but for the subagents (SPEC M7a), which the server lists done too:
// they come in `extra` (./subagents.tsx), a group of AI Elements' Subagent cards.
import { SheetDrawer } from "@/components/sheet-drawer";
import { Button } from "@/components/ui/button";
import { TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import type { Link } from "@/lib/connection";
import { queued, type Queued, type Session, type SessionStore } from "@/lib/session";
import type { Loaded } from "@/lib/use-api";
import { cn } from "@/lib/utils";
import { engineLabel, type Device, type SessionState } from "@wire";
import { BotIcon, ClockIcon, LayersIcon, LaptopIcon, ServerIcon, SquareIcon, Undo2Icon } from "lucide-react";
import { type ReactElement, type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { shortLabel } from "./pickers";

const WIDE = "(min-width: 768px)";

// a wide screen gets the side panel; a phone, the sheet from the bottom
const wide = () => matchMedia(WIDE).matches;
const onWidthChange = (changed: () => void) => {
  const query = matchMedia(WIDE);
  query.addEventListener("change", changed);
  return () => {
    query.removeEventListener("change", changed);
  };
};
const useWide = () => useSyncExternalStore(onWidthChange, wide);

// "4 s", "2 min 05 s", "1 h 03 min": how long the turn has run. The server says how long as of the
// state it sent (its own clock); this page adds the time since it got that state (its own clock),
// so the two clocks are never compared
export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, "0")} s`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
};

// the clock, once a second while something runs
export function useNow(ticking: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now()); // from the moment it starts, not from when the component mounted
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [ticking]);
  return now;
}

const engineName = (state: SessionState, ref: string) => shortLabel(state.engines.find((e) => e.ref === ref)?.label ?? engineLabel(ref));

// what the server is busy with, for the header's mark: a turn, a compactor call, a held message,
// a subagent running
export const busyWith = (s: Session) =>
  (s.state !== null && s.state.phase !== "idle" ? 1 : 0) +
  (s.state?.compactions ?? []).filter((c) => c.running > 0).length +
  queued(s).filter((q) => q.where === "queued").length +
  (s.state?.subagents ?? []).filter((a) => a.state === "running").length;

// one collapsible group of lines, open by default, with its count
export function Group({ title, count, icon, children }: { readonly title: string; readonly count: number; readonly icon: ReactNode; readonly children: ReactNode }) {
  return (
    <TraceCollapsible defaultOpen>
      <TraceCollapsibleTrigger className="min-h-8 pointer-coarse:min-h-10">
        <TraceLine className="text-ui font-medium">
          <TraceIcon>{icon}</TraceIcon>
          <TraceTitle>{title}</TraceTitle>
          <TraceDescription className="text-muted-foreground">{count}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="mt-1 text-foreground">
        <div className="flex flex-col gap-1" role="list">
          {children}
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

// One line: icon, title, then its kind and state on a second line, and an action beside it.
function Row({ icon, title, kind, state, status, action, testId }: { readonly icon: ReactNode; readonly title: string; readonly kind: string; readonly state: string; readonly status?: "running" | "error" | undefined; readonly action?: ReactNode; readonly testId: string }) {
  return (
    <div className="flex min-h-10 w-full items-center gap-2" data-testid={testId} role="listitem">
      <TraceLine className="min-w-0 flex-1 items-start text-ui text-foreground" status={status}>
        <TraceIcon className="mt-0.5">{icon}</TraceIcon>
        <span className="flex min-w-0 flex-col">
          <TraceTitle>{title}</TraceTitle>
          <span className={cn("truncate text-xs", status === "error" ? "text-destructive" : "text-muted-foreground")}>
            {kind} · {state}
          </span>
        </span>
      </TraceLine>
      {action}
    </div>
  );
}

const DEVICE_STATE = { offline: "offline", online: "connected", refused: "refused the connection" } satisfies Record<Device["status"], string>;

export function BackgroundWork({
  session,
  link,
  devices,
  open,
  onOpenChange,
  trigger,
  extra,
}: {
  readonly session: SessionStore;
  readonly link: Link;
  readonly devices: Loaded<readonly Device[]>;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger?: ReactNode;
  // more groups, after the running work: the subagents (SPEC M7a, ./subagents.tsx)
  readonly extra?: readonly ReactElement[];
}) {
  const s = useSyncExternalStore(session.subscribe, session.get);
  const side = useWide() ? "right" : "bottom";
  const { state } = s;
  const turn = state !== null && state.phase !== "idle" ? state : null;
  const now = useNow(open && turn !== null);
  const held: readonly Queued[] = queued(s).filter((q) => q.where === "queued");
  const levels = (state?.compactions ?? []).filter((c) => c.running + c.queued + c.failed > 0);
  const { reload } = devices;
  useEffect(() => {
    if (open) reload();
  }, [open, reload]);

  const running = (turn === null ? 0 : 1) + levels.length;
  const none = (extra?.length ?? 0) === 0;
  return (
    <SheetDrawer
      className={side === "bottom" ? "max-h-[85dvh]" : undefined}
      description="What the server is doing besides this chat: the running turn, held messages, the compactor, the subagents and the devices"
      onOpenChange={onOpenChange}
      open={open}
      side={side}
      testId="background-work"
      title="Background work"
      trigger={trigger}
    >
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-2 pt-1 pb-3">
        {running === 0 && held.length === 0 && none && <p className="text-ui text-muted-foreground">Nothing is running. The next message starts a turn.</p>}
        {running > 0 && state !== null && (
          <Group count={running} icon={<BotIcon className="size-3.5" />} title="Running">
            {turn !== null && (
              <Row
                action={
                  turn.phase === "needs-model" ? undefined : (
                    <Button
                      aria-label="Stop the turn"
                      className="shrink-0 rounded-full bg-soft text-foreground hover:bg-soft-strong"
                      onClick={() => {
                        link.abort();
                      }}
                      size="icon-sm"
                      title="Stop the turn"
                      variant="ghost"
                    >
                      <SquareIcon className="size-3 fill-current" strokeWidth={0} />
                    </Button>
                  )
                }
                icon={<BotIcon className="size-3.5" />}
                kind="Turn"
                state={
                  turn.phase === "needs-model"
                    ? "stopped: needs a model"
                    : turn.phase === "waiting"
                      ? "waiting for summaries"
                      : `on ${turn.device}${turn.elapsed === undefined ? "" : `, ${elapsed(turn.elapsed + now - s.stateAt)}`}`
                }
                status={turn.phase === "needs-model" ? "error" : "running"}
                testId="work-turn"
                title={turn.engine === null ? "The turn" : engineName(turn, turn.engine)}
              />
            )}
            {levels.map((c) => (
              <Row
                icon={<LayersIcon className="size-3.5" />}
                key={c.level}
                kind="Compactor"
                state={[c.running > 0 && `${c.running} running`, c.queued > 0 && `${c.queued} queued`, c.failed > 0 && `${c.failed} failed, tried again at the next message`].filter(Boolean).join(", ")}
                status={c.failed > 0 && c.running === 0 ? "error" : c.running > 0 ? "running" : undefined}
                testId="work-compaction"
                title={c.level === 0 ? "Summaries of messages" : `Summaries, level ${c.level}`}
              />
            ))}
          </Group>
        )}
        {extra}
        {held.length > 0 && state !== null && (
          <Group count={held.length} icon={<ClockIcon className="size-3.5" />} title="Waiting for a turn">
            {held.map((q) => (
              <Row
                action={
                  q.back === null ? undefined : (
                    <Button
                      aria-label={`Take back: ${q.text.trim() === "" ? `${q.media.length} attachments` : q.text}`}
                      className="shrink-0"
                      onClick={() => {
                        session.takeBack(q);
                      }}
                      size="icon-sm"
                      title="Back into the composer, to edit or send later"
                      variant="ghost"
                    >
                      <Undo2Icon className="size-4" />
                    </Button>
                  )
                }
                icon={<ClockIcon className="size-3.5" />}
                key={q.key}
                kind="Message"
                state={q.engine === null ? "queued for the next turn" : `queued for ${engineName(state, q.engine)}`}
                testId="work-held"
                title={q.text.trim() === "" ? `${q.media.length} attachments` : q.text}
              />
            ))}
          </Group>
        )}
        {devices.data !== null && devices.data.length > 0 && (
          <Group count={devices.data.length} icon={<ServerIcon className="size-3.5" />} title="Devices">
            {devices.data.map((d) => (
              <Row
                icon={<LaptopIcon className="size-3.5" />}
                key={d.name}
                kind={d.local ? "This server" : "Runner"}
                state={`${DEVICE_STATE[d.status]}${d.claudeVersion === null ? "" : `, Claude Code ${d.claudeVersion}`}`}
                status={d.status === "refused" ? "error" : undefined}
                testId="work-device"
                title={d.name}
              />
            ))}
          </Group>
        )}
        {devices.error !== null && <p className="text-xs text-destructive">Devices: {devices.error}</p>}
      </div>
    </SheetDrawer>
  );
}
