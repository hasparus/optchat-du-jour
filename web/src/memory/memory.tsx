// The Memory screen (SPEC "Web UI", Memory; E2, E46): what the model reads each turn, as the chat's
// Memory mode draws it (./memory-view.tsx), with how full the view is: its lines, its size and a
// Context meter against the high mark. Live: a line appended, merged or summarized shows as it
// happens, with nothing to reload. "Show in the log" opens the chat at a block's first message.
// This replaces the reference's `optchat browse`.
import { Context, ContextContent, ContextContentHeader, ContextTrigger, kb } from "@/components/ai-elements/context";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import type { MemoryStore } from "@/lib/memory";
import { memoryItems } from "@/lib/memory";
import type { Row } from "@/lib/rows";
import type { SessionState } from "@wire";
import { useEffect, useMemo } from "react";
import { ChatRow } from "../chat/row";
import { MemoryItems, MemoryParts, useMemory } from "./memory-view";

// a log row as this screen shows it: read-only, nothing live
const renderRow = (row: Row) => <ChatRow row={row} streaming={false} toolState={row.kind === "tool" && row.failed ? "error" : "done"} />;

export function Memory({ memory, state, onShowInChat }: { readonly memory: MemoryStore; readonly state: SessionState | null; readonly onShowInChat: (i: number) => void }) {
  useEffect(() => memory.show(), [memory]);
  const m = useMemory(memory);
  const items = useMemo(() => memoryItems(m.lines, m.want), [m.lines, m.want]);
  const parts = useMemo(() => ({ memory, onShow: onShowInChat, renderRow }), [memory, onShowInChat]);
  const size = state?.viewBytes ?? null;
  const lines = m.rev === null ? null : m.lines.length;
  return (
    <div className="mx-auto w-full max-w-184 space-y-5 px-4 py-6 sm:px-6" data-testid="memory">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-base font-semibold tracking-tight">Memory</h1>
          <p className="mt-1 text-ui text-muted-foreground">
            {lines === null || size === null ? "What the model reads each turn" : `What the model reads each turn: ${lines.toLocaleString()} lines, ${kb(size)}`}
          </p>
        </div>
        {state !== null && (
          <Context maxBytes={state.budget} usedBytes={state.viewBytes}>
            <ContextTrigger size="sm" />
            <ContextContent align="end">
              <ContextContentHeader />
            </ContextContent>
          </Context>
        )}
      </div>
      {m.error !== null && (
        <div className="flex items-center gap-2 text-ui text-destructive" role="alert">
          <span>The memory couldn't be read: {m.error}</span>
          <Button onClick={memory.retry} size="sm" variant="outline">
            Try again
          </Button>
        </div>
      )}
      {m.rev === null && m.error === null && <Shimmer className="text-ui">reading the view…</Shimmer>}
      {m.want > 0 && (
        <div className="flex justify-center">
          <Button className="h-8 rounded-full text-xs text-muted-foreground hairline pointer-coarse:h-10" onClick={memory.earlier} size="sm" variant="ghost">
            {`${m.want.toLocaleString()} older lines`}
          </Button>
        </div>
      )}
      <MemoryParts value={parts}>
        <div className="flex min-w-0 flex-col gap-3">
          <MemoryItems items={items} />
        </div>
      </MemoryParts>
    </div>
  );
}
