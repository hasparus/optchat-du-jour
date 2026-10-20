// The memory view (E46; SPEC "Web UI", Memory; DESIGN.md, Memory): what the model reads, drawn as
// the chat is. A line that is its own message (it fits in a summary) is the log's row; any other
// line is a summary block, which opens in place to its two halves, or down to its messages, or, at
// level 0, to the message itself. A line still waiting for its summary says so under the shimmer,
// and fills in when the compactor writes it (the store is kept live, ../lib/memory.ts). The chat's
// Memory mode and the Memory screen both draw these, so there is one implementation.
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { isOpen, type Memory, type MemoryItem, memoryItems, type MemoryStore, nodeKey } from "@/lib/memory";
import { entryRows, type Row } from "@/lib/rows";
import { cn } from "@/lib/utils";
import type { Kind, MemoryLine } from "@wire";
import { ChevronRightIcon, LayersIcon, MessageSquareIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useSyncExternalStore } from "react";

// What a block needs from the screen it is on: the store, how that screen draws a log row, and
// where "show in the log" goes
export type MemoryScreenParts = {
  readonly memory: MemoryStore;
  readonly renderRow: (row: Row) => ReactNode;
  readonly onShow?: ((i: number) => void) | undefined;
};
const Parts = createContext<MemoryScreenParts | null>(null);
export const MemoryParts = Parts.Provider;
const useParts = () => {
  const parts = useContext(Parts);
  if (parts === null) throw new Error("a memory block outside MemoryParts");
  return parts;
};

export const useMemory = (memory: MemoryStore): Memory => useSyncExternalStore(memory.subscribe, memory.get);

const KIND_NAMES = { echo: "Tool output", note: "Note", talk: "Reply", tool: "Tool call", user: "Your message" } satisfies Record<Kind, string>;

const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
// when a line's messages were said: "5 Oct, 10:02", or "5 Oct, 10:02 – 10:40", or "5 – 9 Oct"
export function spanOfDates(from: string | null, to: string | null): string {
  const a = from === null ? null : new Date(from);
  const b = to === null ? a : new Date(to);
  if (a === null || b === null || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return "";
  if (day.format(a) !== day.format(b)) return `${day.format(a)} – ${day.format(b)}`;
  const start = time.format(a), end = time.format(b);
  return start === end ? `${day.format(a)}, ${start}` : `${day.format(a)}, ${start} – ${end}`;
}

// what a line covers, in words: "Reply", or "8 messages"
const what = (line: MemoryLine) => (line.l === 0 ? (line.kind === undefined ? "Message" : KIND_NAMES[line.kind]) : `${line.n.toLocaleString()} messages`);

// The line's one-line head: its name as the model reads it (`id+n`), what it covers and when
function Head({ line, open }: { readonly line: MemoryLine; readonly open: boolean }) {
  const when = spanOfDates(line.from, line.to);
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform duration-200", open && "rotate-90")} />
      <span className="shrink-0 font-mono text-foreground">{`${line.id}+${line.n}`}</span>
      <span className="min-w-0 truncate">
        {what(line)}
        {when === "" ? "" : ` · ${when}`}
      </span>
      {line.l > 0 && <LayersIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 opacity-60" />}
    </span>
  );
}

// the summary, or that it is still being written
function Summary({ line }: { readonly line: MemoryLine }) {
  if (!line.built || line.text === null) return <Shimmer className="text-read">Summarizing…</Shimmer>;
  return (
    <span className="block text-read wrap-break-word whitespace-pre-wrap text-foreground" data-testid="memory-summary">
      {line.text}
      {line.clipped === true && <span className="ml-1.5 text-xs text-muted-foreground">(clipped)</span>}
    </span>
  );
}

// Items of the view, or of a node opened: the log's rows as the screen draws them, blocks, and
// what isn't read yet
export function MemoryItems({ items }: { readonly items: readonly MemoryItem[] }) {
  const { renderRow } = useParts();
  return items.map((item) => {
    switch (item.kind) {
      case "row":
        return <div key={item.key}>{renderRow(item.row)}</div>;
      case "line":
        return <MemoryBlock key={item.key} line={item.line} />;
      case "gap":
        return <MemoryGap count={item.count} key={item.key} />;
    }
  });
}

export function MemoryGap({ count }: { readonly count: number }) {
  return (
    <div className="px-3 py-2 text-xs" data-testid="memory-gap">
      <Shimmer>{`reading ${count.toLocaleString()} ${count === 1 ? "line" : "lines"}…`}</Shimmer>
    </div>
  );
}

// What an open line holds: its halves (or its messages), or the message under it
function Inside({ line }: { readonly line: MemoryLine }) {
  const { memory, renderRow, onShow } = useParts();
  const m = useMemory(memory);
  const opened = m.opened.get(nodeKey(line));
  let body: ReactNode;
  if (line.l === 0) {
    const message = m.messages.get(line.id);
    body =
      message === undefined ? (
        <Shimmer className="text-xs">loading…</Shimmer>
      ) : message === "error" ? (
        <p className="text-xs text-destructive">It couldn't be read. Close and open it to try again.</p>
      ) : (
        entryRows([message]).map((row) => <div key={row.key}>{renderRow(row)}</div>)
      );
  } else if (opened === undefined) body = <Shimmer className="text-xs">loading…</Shimmer>;
  else {
    const all = opened.depth === line.l;
    body = (
      <>
        <MemoryItems items={memoryItems(opened.lines)} />
        {opened.error !== null && <p className="text-xs text-destructive">It couldn't be read: {opened.error}</p>}
        <div className="flex flex-wrap gap-1">
          {!all && line.l >= 2 && (
            <Button className="h-7 rounded-full text-xs text-muted-foreground pointer-coarse:h-10" onClick={() => void memory.deepen(line, true)} size="sm" variant="ghost">
              {`All ${line.n.toLocaleString()} messages`}
            </Button>
          )}
          {all && opened.lines.length < opened.total && (
            <Button className="h-7 rounded-full text-xs text-muted-foreground pointer-coarse:h-10" onClick={() => void memory.more(line)} size="sm" variant="ghost">
              {`Show ${Math.min(100, opened.total - opened.lines.length)} more of ${opened.total.toLocaleString()}`}
            </Button>
          )}
          {onShow !== undefined && (
            <Button
              className="h-7 rounded-full text-xs text-muted-foreground pointer-coarse:h-10"
              onClick={() => {
                onShow(line.id);
              }}
              size="sm"
              variant="ghost"
            >
              <MessageSquareIcon /> Show in the log
            </Button>
          )}
        </div>
      </>
    );
  }
  return (
    // the halves under Trace's indented rule, as a tool call's input and output sit
    <div className="mt-1 ml-1.75 flex min-w-0 flex-col gap-2 border-l pl-3 sm:pl-4" data-testid="memory-inside">
      {line.l === 0 && (
        <div className="text-xs text-muted-foreground" data-testid="memory-level0-summary">
          {line.built ? (
            <span>
              The model reads: <span className="text-foreground">{line.text}</span>
            </span>
          ) : (
            <Shimmer>Summarizing…</Shimmer>
          )}
        </div>
      )}
      {body}
    </div>
  );
}

// A summary block. Closed: a hairline box, its head and its summary (or the shimmer while the
// compactor writes it). Open: the head alone, as the bar that closes it, and what it holds below.
export function MemoryBlock({ line }: { readonly line: MemoryLine }) {
  const { memory } = useParts();
  const m = useMemory(memory);
  const open = isOpen(m, line);
  // open by default (a message said in the conversation): what it holds is read as it first shows
  useEffect(() => {
    if (open) void memory.ensure(line);
  }, [open, memory, line]);
  const toggle = () => {
    memory.toggle(line, !open);
  };
  const data = { "data-built": line.built, "data-level": line.l, "data-node": nodeKey(line), "data-testid": "memory-block" };
  if (!open)
    return (
      <button
        {...data}
        aria-expanded={false}
        className="group flex w-full min-w-0 flex-col gap-1.5 rounded-xl px-3 py-2.5 text-left hairline transition-colors duration-150 hover:bg-accent focus-visible:outline-none pointer-coarse:py-3"
        onClick={toggle}
        type="button"
      >
        <Head line={line} open={false} />
        <Summary line={line} />
      </button>
    );
  return (
    <div {...data} className="min-w-0" data-open="">
      <button
        aria-expanded
        className="flex h-7 w-full min-w-0 items-center rounded-lg px-3 text-left transition-colors duration-150 hover:bg-accent pointer-coarse:h-10"
        onClick={toggle}
        type="button"
      >
        <Head line={line} open />
      </button>
      <Inside line={line} />
    </div>
  );
}
