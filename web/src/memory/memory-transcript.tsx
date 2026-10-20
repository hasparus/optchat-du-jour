// The chat's transcript in Memory mode (E46; ../chat/memory-mode.tsx): the view's lines (./memory-view.tsx),
// then what comes after its last message (the reply streaming in) as the log's rows, which the chat
// draws as it draws its log. It owns its reads: older lines as the top comes into view, as the
// log's are. The chat itself never reads the memory store, so a compactor's frame redraws this
// alone, and nothing while the log is shown.
import { Shimmer } from "@/components/ai-elements/shimmer";
import { MessageScrollerContent, MessageScrollerItem } from "@/components/ui/message-scroller";
import { memoryItems, type MemoryStore } from "@/lib/memory";
import type { Row } from "@/lib/rows";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import { MemoryError, MemoryItem, MemoryParts, useMemory } from "./memory-view";

export function MemoryTranscript({
  memory,
  rows,
  renderRows,
  contentClassName,
  onShow,
}: {
  readonly memory: MemoryStore;
  // the log's rows, as the chat holds them; those after the view's last message are drawn after it
  readonly rows: readonly Row[];
  readonly renderRows: (rows: readonly Row[]) => ReactNode;
  readonly contentClassName: string;
  readonly onShow: (i: number) => void;
}) {
  useEffect(() => memory.show(), [memory]);
  const m = useMemory(memory);
  const items = useMemo(() => memoryItems(m.lines, m.want), [m.lines, m.want]);
  const last = m.lines.at(-1);
  const end = last === undefined ? (m.rev === null ? null : 0) : last === null ? null : last.id + last.n;
  const after = useMemo(() => (end === null ? [] : rows.filter((r) => r.id >= end)), [rows, end]);
  const parts = useMemo(() => ({ memory, onShow }), [memory, onShow]);

  // the top in view: the lines before it, and again once they are in while it still shows
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = top.current;
    if (!el || !("IntersectionObserver" in globalThis)) return;
    const io = new IntersectionObserver((seen) => {
      if (seen.some((e) => e.isIntersecting)) memory.earlier();
    });
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [memory, m.want]);

  return (
    <>
      {/* outside the content, as the log's: the scroller reads its content's first child */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-px" ref={top} />
      {m.want > 0 && (
        <div className="flex justify-center pt-4">
          <button
            className="min-h-8 rounded-full px-3 text-xs text-muted-foreground hairline transition-colors hover:bg-accent hover:text-foreground pointer-coarse:min-h-10"
            onClick={memory.earlier}
            type="button"
          >
            {`${m.want.toLocaleString()} older lines`}
          </button>
        </div>
      )}
      <MessageScrollerContent className={contentClassName} data-region="chat-content" data-transcript="memory">
        {m.rev === null && (m.error === null ? <Shimmer className="self-center text-xs">reading the memory…</Shimmer> : <MemoryError error={m.error} memory={memory} />)}
        <MemoryParts value={parts}>
          {items.map((item) => (
            <MessageScrollerItem
              data-kind={item.kind === "row" ? item.row.kind : "memory"}
              data-log-index={item.kind === "row" ? item.row.id : item.kind === "line" ? item.line.id : undefined}
              key={item.key}
              messageId={item.key}
              scrollAnchor={item.kind === "row" && item.row.kind === "user"}
            >
              <MemoryItem item={item} />
            </MessageScrollerItem>
          ))}
        </MemoryParts>
        {renderRows(after)}
      </MessageScrollerContent>
    </>
  );
}
