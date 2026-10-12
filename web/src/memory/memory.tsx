// The Memory screen (SPEC "Web UI", Memory; E2): what the model sees. The view as `id+n|text` lines
// with their range, dates and size, a Context meter against VIEW, and a zoom: tapping a line opens
// its two children, down to the full message, which "show in chat" finds in the log. This replaces
// the reference's `optchat browse`.
import { Context, ContextContent, ContextContentHeader, ContextTrigger, kb } from "@/components/ai-elements/context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { type NodeView, span, type ViewLine } from "@wire";
import { useApi } from "@/lib/use-api";
import { cn } from "@/lib/utils";
import { ArrowLeftIcon, ChevronRightIcon, MessageSquareIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useState } from "react";

type At = { readonly l: number; readonly i: number };

const name = (n: { id: number; n: number }) => `${n.id}+${n.n}`;
const range = (line: ViewLine) => (line.from === line.to || line.to === null ? (line.from ?? "") : `${line.from} – ${line.to}`);

function Line({ line, onOpen }: { line: ViewLine; onOpen: () => void }) {
  return (
    <li>
      <button className="group w-full rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent active:bg-accent" data-testid="view-line" onClick={onOpen} type="button">
        <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
          <span className="font-mono text-foreground">{name(line)}</span>
          <span className="truncate">{range(line)}</span>
          <span className="ml-auto shrink-0 tabular-nums">{line.size === null ? "" : `${line.size} B`}</span>
          <ChevronRightIcon aria-hidden="true" className="size-3.5 shrink-0 self-center opacity-0 transition-opacity group-hover:opacity-100" />
        </div>
        <p className={cn("mt-1 line-clamp-3 text-read wrap-break-word", !line.built && "text-muted-foreground italic")}>{line.text}</p>
      </button>
    </li>
  );
}

function Zoom({ at, onOpen, onBack, onShow }: { at: At; onOpen: (next: At) => void; onBack: () => void; onShow: (i: number) => void }) {
  const read = useCallback(async () => api.node(at.l, at.i), [at.l, at.i]);
  const { data, error } = useApi<NodeView>(read);
  return (
    <div className="space-y-4" data-testid="zoom">
      <Button className="-ml-2 text-muted-foreground hover:text-foreground" onClick={onBack} size="sm" variant="ghost">
        <ArrowLeftIcon /> back
      </Button>
      {error !== null && <p className="text-sm text-destructive">{error}</p>}
      {data !== null && "kind" in data ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono text-foreground">{name(data)}</span>
            <Badge className="rounded-full font-medium" variant="secondary">
              {data.kind}
            </Badge>
            <span className="tabular-nums">{data.date}</span>
          </div>
          <pre className="rounded-xl border bg-code p-3.5 font-mono text-xs/relaxed wrap-break-word whitespace-pre-wrap" data-testid="zoom-message">
            {data.text}
          </pre>
          <Button
            className="rounded-full"
            onClick={() => {
              onShow(data.id);
            }}
            size="sm"
            variant="outline"
          >
            <MessageSquareIcon /> show in chat
          </Button>
        </div>
      ) : null}
      {data !== null && "children" in data ? (
        <div className="space-y-2">
          <div className="space-y-1">
            <span className="font-mono text-xs text-muted-foreground">{name(data)}</span>
            <p className="text-read">{data.text ?? "(not summarized yet)"}</p>
          </div>
          <ul className="space-y-2 border-l pl-3">
            {data.children.map((c) => (
              <li key={`${c.l}:${c.i}`}>
                <button
                  className="w-full rounded-lg px-3 py-2.5 text-left shadow-[inset_0_0_0_1px_var(--border)] transition-colors hover:bg-accent"
                  data-testid="zoom-child"
                  onClick={() => {
                    onOpen({ i: c.i, l: c.l });
                  }}
                  type="button"
                >
                  <span className="font-mono text-xs text-muted-foreground">{name(span(c))}</span>
                  <p className={cn("mt-1 text-read wrap-break-word", !c.built && "text-muted-foreground italic")}>{c.text ?? "(not summarized yet)"}</p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function Memory({ onShowInChat }: { onShowInChat: (i: number) => void }) {
  const { data, error, reload } = useApi(api.view);
  const [path, setPath] = useState<At[]>([]);
  const at = path.at(-1);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 px-4 py-6 sm:px-6">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h1 className="text-base font-semibold tracking-tight">Memory</h1>
          <p className="mt-1 text-ui text-muted-foreground">
            {data === null ? "Loading…" : `What the model reads each turn: ${data.lines.length} lines, ${kb(data.size)}`}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {data !== null && (
            <Context maxBytes={data.budget} usedBytes={data.size}>
              <ContextTrigger size="sm" />
              <ContextContent align="end">
                <ContextContentHeader />
              </ContextContent>
            </Context>
          )}
          <Button aria-label="Reload" className="text-muted-foreground hover:text-foreground pointer-coarse:size-10" onClick={reload} size="icon-sm" variant="ghost">
            <RefreshCwIcon />
          </Button>
        </div>
      </div>
      {error !== null && <p className="text-sm text-destructive">{error}</p>}
      {at ? (
        <Zoom
          at={at}
          key={`${at.l}:${at.i}`}
          onBack={() => {
            setPath(path.slice(0, -1));
          }}
          onOpen={(next) => {
            setPath([...path, next]);
          }}
          onShow={onShowInChat}
        />
      ) : (
        <ul className="-mx-3 space-y-0.5">
          {data?.lines.map((line) => (
            <Line
              key={`${line.l}:${line.i}`}
              line={line}
              onOpen={() => {
                setPath([{ i: line.i, l: line.l }]);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
