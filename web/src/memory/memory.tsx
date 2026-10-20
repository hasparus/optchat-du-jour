// The Memory screen (SPEC "Web UI", Memory; E2, E46): what the model reads each turn, as the chat's
// Memory mode draws it (./memory-view.tsx, rows by ../chat/log-row.tsx), with how full the view is:
// its lines, its size and a Context meter against the high mark. Live: a line appended, merged or
// summarized shows as it happens, with nothing to reload. "Show in the log" opens the chat at a
// block's first message. This replaces the reference's `optchat browse`.
import { Context, ContextContent, ContextContentHeader, ContextTrigger, kb } from "@/components/ai-elements/context";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { memoryItems, type MemoryStore } from "@/lib/memory";
import type { Session, SessionStore } from "@/lib/session";
import type { ArtifactInfo } from "@wire";
import { useEffect, useMemo } from "react";
import { LogRowProvider } from "../chat/log-row";
import { MemoryError, MemoryItems, MemoryParts, useMemory } from "./memory-view";

export function Memory({
  memory,
  session,
  state,
  onShowInChat,
  artifacts,
}: {
  readonly memory: MemoryStore;
  readonly session: Pick<SessionStore, "toggleThought">;
  readonly state: Session;
  readonly onShowInChat: (i: number) => void;
  // every artifact and its versions, App's (one reader of /api/artifacts for both screens)
  readonly artifacts: readonly ArtifactInfo[];
}) {
  useEffect(() => memory.show(), [memory]);
  const m = useMemory(memory);
  const items = useMemo(() => memoryItems(m.lines, m.want), [m.lines, m.want]);
  const parts = useMemo(() => ({ memory, onShow: onShowInChat }), [memory, onShowInChat]);
  // a row reads what the chat's does: folds, thoughts, an artifact's card (opened in the chat)
  const { folds, thoughts } = state;
  // a tool call can still be running only while a turn runs, and only the newest, as in the log
  const busy = state.state !== null && state.state.phase !== "idle";
  const lastTool = items.findLast((x) => x.kind === "row" && x.row.kind === "tool")?.key;
  const rows = useMemo(
    () => ({ artifacts, busy, folds, lastTool, onArtifact: (_name: string, _v: number | null, i: number) => {
        onShowInChat(i);
      }, onThought: session.toggleThought, thoughts }),
    [artifacts, busy, folds, lastTool, session.toggleThought, thoughts, onShowInChat],
  );
  const view = state.state;
  const lines = m.rev === null ? null : m.lines.length;
  return (
    <div className="mx-auto w-full max-w-184 space-y-5 px-4 py-6 sm:px-6" data-testid="memory">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight">Memory</h1>
          <p className="mt-1 text-ui text-muted-foreground">
            {lines === null || view === null ? "What the model reads each turn" : `What the model reads each turn: ${lines.toLocaleString()} lines, ${kb(view.viewBytes)}`}
          </p>
        </div>
        {view !== null && (
          <Context maxBytes={view.budget} usedBytes={view.viewBytes}>
            <ContextTrigger size="sm" />
            <ContextContent align="end">
              <ContextContentHeader />
            </ContextContent>
          </Context>
        )}
      </div>
      {m.rev === null && (m.error === null ? <Shimmer className="text-ui">reading the view…</Shimmer> : <MemoryError error={m.error} memory={memory} />)}
      {m.want > 0 && (
        <div className="flex justify-center">
          <Button className="h-8 rounded-full text-xs text-muted-foreground hairline pointer-coarse:h-10" onClick={memory.earlier} size="sm" variant="ghost">
            {`${m.want.toLocaleString()} older lines`}
          </Button>
        </div>
      )}
      <MemoryParts value={parts}>
        <LogRowProvider value={rows}>
          <div className="flex min-w-0 flex-col gap-3">
            <MemoryItems items={items} />
          </div>
        </LogRowProvider>
      </MemoryParts>
    </div>
  );
}
