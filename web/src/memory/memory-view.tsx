// The memory view (E46; SPEC "Web UI", Memory; DESIGN.md, Memory view): what the model reads, drawn
// as the chat is. A line that is its own message (it fits in a summary) is the log's row; any other
// line is a summary block, which opens in place to its two halves, or down to its messages, or, at
// level 0, to the message itself. A line still waiting for its summary says so under the shimmer,
// and fills in when the compactor writes it (the store is kept live, ../lib/memory.ts). The chat's
// Memory mode (./memory-transcript.tsx) and the Memory screen (./memory.tsx) both draw these.
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { isOpen, type Memory, type MemoryItem as Item, memoryItems, type MemoryStore, nodeKey } from "@/lib/memory";
import { entryRows } from "@/lib/rows";
import { cn } from "@/lib/utils";
import type { Kind, MemoryLine } from "@wire";
import { ChevronRightIcon, LayersIcon, MessageSquareIcon } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useId, useSyncExternalStore } from "react";
import { LogRow } from "../chat/log-row";

// What a block needs from the screen it is on: the store, and where "Show in the log" goes. A log
// row reads what it shows from ../chat/log-row.tsx's provider.
export type MemoryScreenParts = { readonly memory: MemoryStore; readonly onShow?: ((i: number) => void) | undefined };
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

// The line's one-line head: its name as the model reads it (`id+n`), what it covers and when. It
// names the block's button (the summary describes it), so it is said, not the whole summary.
function Head({ line, open, id }: { readonly line: MemoryLine; readonly open: boolean; readonly id: string }) {
  const when = spanOfDates(line.from, line.to);
  return (
    <span className="flex w-full min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform duration-200", open && "rotate-90")} />
      <span className="flex min-w-0 items-center gap-2" id={id}>
        <span className="shrink-0 font-mono text-foreground">{`${line.id}+${line.n}`}</span>
        <span className="min-w-0 truncate">
          {what(line)}
          {when === "" ? "" : ` · ${when}`}
        </span>
      </span>
      {line.l > 0 && <LayersIcon aria-hidden="true" className="ml-auto size-3.5 shrink-0 opacity-60" />}
    </span>
  );
}

// the summary, or that it is still being written
function Summary({ line, id }: { readonly line: MemoryLine; readonly id: string }) {
  if (!line.built || line.text === null)
    return (
      <span id={id}>
        <Shimmer className="text-read">Summarizing…</Shimmer>
      </span>
    );
  return (
    <span className="block text-read wrap-break-word whitespace-pre-wrap text-foreground" data-testid="memory-summary" id={id}>
      {line.text}
      {line.clipped === true && <span className="ml-1.5 text-xs text-muted-foreground">(clipped)</span>}
    </span>
  );
}

// A read that failed: why, and a way to read again now (the store also tries again by itself)
export function MemoryError({ memory, error }: { readonly memory: MemoryStore; readonly error: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-ui text-destructive" data-testid="memory-error" role="alert">
      <span>The memory couldn't be read: {error}</span>
      <Button className="h-8 rounded-full pointer-coarse:h-10" onClick={memory.retry} size="sm" variant="outline">
        Try again
      </Button>
    </div>
  );
}

// Lines told of and not read yet: being read, or, when the read failed, why and "Try again"
export function MemoryGap({ count }: { readonly count: number }) {
  const { memory } = useParts();
  const m = useMemory(memory);
  if (m.error !== null) return <MemoryError error={m.error} memory={memory} />;
  return (
    <div className="px-3 py-2 text-xs" data-testid="memory-gap">
      <Shimmer>{`reading ${count.toLocaleString()} ${count === 1 ? "line" : "lines"}…`}</Shimmer>
    </div>
  );
}

// One item of the view, or of a node opened: the log's row, a block, or what isn't read yet
export function MemoryItem({ item }: { readonly item: Item }) {
  switch (item.kind) {
    case "row":
      return <LogRow followed={item.followed} row={item.row} />;
    case "line":
      return <MemoryBlock line={item.line} />;
    case "gap":
      return <MemoryGap count={item.count} />;
  }
}

export function MemoryItems({ items }: { readonly items: readonly Item[] }) {
  return items.map((item) => (
    <div key={item.key}>
      <MemoryItem item={item} />
    </div>
  ));
}

const pill = "h-7 rounded-full text-xs text-muted-foreground pointer-coarse:h-10";

// What an open line holds: its halves (or its messages), or the message under it
function Inside({ line }: { readonly line: MemoryLine }) {
  const { memory, onShow } = useParts();
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
        // a summarized message, opened: history, whose output (for a tool call) is the next line
        entryRows([message]).map((row) => <LogRow followed key={row.key} row={row} />)
      );
  } else if (opened === undefined) body = <Shimmer className="text-xs">loading…</Shimmer>;
  else {
    const all = opened.depth === line.l && line.l > 1;
    body = (
      <>
        <MemoryItems items={memoryItems(opened.lines)} />
        {opened.error !== null && <p className="text-xs text-destructive">It couldn't be read: {opened.error}</p>}
        <div className="flex flex-wrap gap-1">
          {line.l >= 2 && (
            <Button className={pill} onClick={() => void memory.deepen(line, !all)} size="sm" variant="ghost">
              {all ? "Back to its two halves" : `All ${line.n.toLocaleString()} messages`}
            </Button>
          )}
          {all && opened.lines.length < opened.total && (
            <Button className={pill} onClick={() => void memory.more(line)} size="sm" variant="ghost">
              {`Show ${Math.min(100, opened.total - opened.lines.length)} more of ${opened.total.toLocaleString()}`}
            </Button>
          )}
          {onShow !== undefined && (
            <Button
              className={pill}
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
  const ids = useId();
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
        aria-describedby={`${ids}-summary`}
        aria-expanded={false}
        aria-labelledby={`${ids}-head`}
        className="group flex w-full min-w-0 flex-col gap-1.5 rounded-xl px-3 py-2.5 text-left hairline transition-colors duration-150 hover:bg-accent pointer-coarse:py-3"
        onClick={toggle}
        type="button"
      >
        <Head id={`${ids}-head`} line={line} open={false} />
        <Summary id={`${ids}-summary`} line={line} />
      </button>
    );
  return (
    <div {...data} className="min-w-0" data-open="">
      <button
        aria-expanded
        aria-labelledby={`${ids}-head`}
        className="flex h-7 w-full min-w-0 items-center rounded-lg px-3 text-left transition-colors duration-150 hover:bg-accent pointer-coarse:h-10"
        onClick={toggle}
        type="button"
      >
        <Head id={`${ids}-head`} line={line} open />
      </button>
      <Inside line={line} />
    </div>
  );
}
