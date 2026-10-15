// One row of the chat (SPEC "Web UI", Chat; DESIGN.md, The transcript): a user message as a soft
// bubble on the right, a note likewise and marked as one, a reply as plain prose (markdown) with
// copy and a raw-text toggle under it (rendering never hides what the model wrote), a tool call as
// one work-log line with its input and output collapsed under it; a TodoWrite call as a plan, and
// the links a turn's web tools used as its reply's sources.
import { MessageAction, MessageActions, MessageResponse } from "@/components/ai-elements/message";
import { Attachment, AttachmentMedia, AttachmentTrigger } from "@/components/ui/attachment";
import { Plan, PlanContent, PlanHeader, PlanLogged, PlanSteps } from "@/components/ai-elements/plan";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { type PlanStep, planOf, type Row, type Source as SourceItem, type ToolState, toolSummary } from "@/lib/rows";
import { splitMarkers } from "@wire";
import { CheckIcon, CodeIcon, CopyIcon, NotebookPenIcon, TextIcon } from "lucide-react";
import { Component, createContext, memo, type ReactNode, use, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

// copy the reply as written; the check stays a moment
function CopyAction({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <MessageAction
      className="size-7 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
      label={copied ? "Copied" : "Copy"}
      onClick={() => {
        navigator.clipboard.writeText(text).then(
          () => {
            setCopied(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => {
              setCopied(false);
            }, 1500);
          },
          () => {
            // no clipboard (an insecure origin): the text stays selectable
          },
        );
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </MessageAction>
  );
}

// On a touch screen a reply's actions wait behind a tap, as in a messaging app (DESIGN.md, Messages):
// tapping a reply shows its row of actions and hides any other reply's; a tap outside it, or
// scrolling it out of view, hides it again. A tap on a link or a button in it, or one that ends a
// text selection, is not that tap. One listener for the whole transcript hears taps (touch and pen
// pointers only: a mouse keeps hover and focus, index.css), so a reply has no click handler a
// screen reader would announce as something to activate. The actions stay in the page either way,
// so a keyboard or a screen reader reaches them, and focus shows them.
type ReplyActionsState = { readonly open: string | null };
const ReplyActionsContext = createContext<ReplyActionsState>({ open: null });

// what a tap must not toggle: a link, a control, the actions themselves
const INTERACTIVE = "a, button, input, select, textarea, summary, [role='button'], [data-slot='message-actions']";

export function ReplyActions({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  // a tap on a reply (pointerup of a touch or a pen; a drag that scrolls ends in pointercancel)
  useEffect(() => {
    const tapped = (e: PointerEvent) => {
      if (e.pointerType !== "touch" && e.pointerType !== "pen") return;
      if (!(e.target instanceof Element)) return;
      const reply = e.target.closest<HTMLElement>("[data-reply]");
      if (!reply || e.target.closest(INTERACTIVE)) return;
      const selection = getSelection();
      if (selection && !selection.isCollapsed && reply.contains(selection.anchorNode)) return; // a selection, not a tap
      const id = reply.dataset.reply ?? null;
      setOpen((now) => (now === id ? null : id));
    };
    document.addEventListener("pointerup", tapped);
    return () => {
      document.removeEventListener("pointerup", tapped);
    };
  }, []);
  // shown: the row opens below the reply, which on the newest reply is where the floating dock sits.
  // Before it paints, the newest reply's row is brought to the end of the chat (a reader at the end
  // stays there, and the scroll-to-end button doesn't come up); another reply's row is scrolled only
  // as far as the viewport's scroll padding (the dock's height) needs, which is not at all when it
  // is already clear
  useLayoutEffect(() => {
    if (open === null) return;
    const reply = document.querySelector(`[data-reply="${CSS.escape(open)}"]`);
    const viewport = reply?.closest('[data-slot="message-scroller-viewport"]');
    const newest = viewport ? [...viewport.querySelectorAll('[data-slot="message-scroller-item"]')].at(-1) : undefined;
    if (viewport && newest?.contains(reply)) viewport.scrollTop = viewport.scrollHeight;
    else reply?.querySelector('[data-slot="message-actions"]')?.scrollIntoView({ block: "nearest" });
  }, [open]);
  // shown: a tap anywhere else, or the reply leaving the view, hides them
  useEffect(() => {
    if (open === null) return;
    const shown = document.querySelector(`[data-reply="${CSS.escape(open)}"]`);
    const outside = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !shown?.contains(e.target)) setOpen(null);
    };
    document.addEventListener("pointerdown", outside);
    const gone = shown && "IntersectionObserver" in globalThis ? new IntersectionObserver((seen) => {
      if (seen.every((s) => !s.isIntersecting)) setOpen(null);
    }) : null;
    if (shown) gone?.observe(shown);
    return () => {
      document.removeEventListener("pointerdown", outside);
      gone?.disconnect();
    };
  }, [open]);
  const value = useMemo(() => ({ open }), [open]);
  return <ReplyActionsContext value={value}>{children}</ReplyActionsContext>;
}

function Reply({ id, text, streaming, sources }: { id: string; text: string; streaming: boolean; sources: readonly SourceItem[] | undefined }) {
  const [raw, setRaw] = useState(false);
  const shown = use(ReplyActionsContext).open === id;
  return (
    <Message align="start" data-actions={shown ? "shown" : undefined} data-reply={id}>
      <MessageContent className="gap-1.5">
        <Bubble className="max-w-full" variant="ghost">
          <BubbleContent className="w-full text-read" data-prose="">
            {raw ? (
              <pre className="font-mono text-ui/relaxed wrap-break-word whitespace-pre-wrap">{text}</pre>
            ) : (
              <MessageResponse isAnimating={streaming}>
                {text}
              </MessageResponse>
            )}
          </BubbleContent>
        </Bubble>
        {sources !== undefined && sources.length > 0 && (
          <Sources>
            <SourcesTrigger count={sources.length} />
            <SourcesContent>
              {sources.map((s) => (
                <Source key={s.url} source={s} />
              ))}
            </SourcesContent>
          </Sources>
        )}
        {/* the raw toggle is there from the first token (SPEC "Web UI"); copy waits for the whole reply */}
        <MessageActions className="-ml-1.5 gap-0.5">
          {!streaming && <CopyAction text={text} />}
          <MessageAction
            aria-pressed={raw}
            className="size-7 text-muted-foreground hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground [&_svg]:size-3.5"
            label={raw ? "Show rendered" : "Show raw text"}
            onClick={() => {
              setRaw(!raw);
            }}
          >
            {raw ? <TextIcon /> : <CodeIcon />}
          </MessageAction>
        </MessageActions>
      </MessageContent>
    </Message>
  );
}

// A user message as logged: its attachments' thumbnails above the bubble (SPEC "Media"), and in
// the bubble the text with its marker lines, dimmed. A thumbnail is our own asset, named by the
// marker's 12 hex digits; only user rows show them, so nothing a model wrote is ever fetched. Each
// is shadcn's Attachment (image media, its trigger a link to the full asset over the whole tile),
// keeping the thumbnail's own shape rather than the registry's square crop.
function UserMessage({ text }: { text: string }) {
  const { body, markers } = splitMarkers(text);
  return (
    <Message align="end" data-testid="user-message">
      <MessageContent className="gap-1.5">
        {markers.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5" data-testid="user-attachments">
            {markers.map((m) => (
              <Attachment
                className="w-auto rounded-xl border-0 bg-transparent transition-opacity hover:opacity-90 has-data-[slot=attachment-media]:p-0 has-[>a,>button]:hover:bg-transparent"
                key={m.line}
                orientation="vertical"
              >
                <AttachmentMedia
                  className="aspect-auto w-auto rounded-xl border bg-muted group-data-[orientation=vertical]/attachment:w-auto *:[img]:aspect-auto *:[img]:max-h-44 *:[img]:w-auto *:[img]:max-w-60 *:[img]:object-contain"
                  variant="image"
                >
                  <img alt={`${m.kind} ${m.sha}`} loading="lazy" src={`/api/assets/${m.sha}/thumb`} />
                </AttachmentMedia>
                <AttachmentTrigger asChild>
                  <a aria-label={`Open ${m.kind} ${m.sha}`} className="rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50" href={`/api/assets/${m.sha}`} rel="noreferrer" target="_blank" />
                </AttachmentTrigger>
              </Attachment>
            ))}
          </div>
        )}
        <Bubble align="end" className="max-w-[85%] sm:max-w-[min(80%,36rem)]" variant="soft">
          <BubbleContent className="rounded-2xl px-3.5 py-2 text-read whitespace-pre-wrap">
            {body}
            {markers.length > 0 && (
              <span className="font-mono text-xs text-muted-foreground">
                {body === "" ? "" : "\n"}
                {markers.map((m) => m.line).join("\n")}
              </span>
            )}
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

// A TodoWrite call as a plan. The chat's newest plan is open and the others closed, live and after a
// reload alike, until the reader opens or closes one: then their choice stays (the Reasoning
// pattern's open state).
function PlanRow({ row, steps, toolState, plan }: { row: Extract<Row, { kind: "tool" }>; steps: readonly PlanStep[]; toolState: ToolState; plan: ChatRowProps["plan"] }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const live = plan === "live";
  return (
    <Plan onOpenChange={setChosen} open={chosen ?? plan !== undefined}>
      <PlanHeader failed={toolState === "error"} running={toolState === "running" || (live && steps.some((s) => s.status !== "completed"))} steps={steps} />
      <PlanContent>
        <PlanSteps live={live} steps={steps} />
        <PlanLogged>
          <ToolInput input={row.args} />
          {row.output !== null && <ToolOutput failed={toolState === "error"} output={row.output} />}
        </PlanLogged>
      </PlanContent>
    </Plan>
  );
}

// a row that fails to render shows its text as logged, and the rest of the chat stays up
class RowBoundary extends Component<{ readonly text: string; readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <pre className="font-mono text-xs wrap-break-word whitespace-pre-wrap">{this.props.text}</pre> : this.props.children;
  }
}

// memo: a streamed token changes one row, and the rows above it (their objects are kept, rows.ts
// chatRows) are not drawn again
// chatRows) are not drawn again. `plan`: this row is the chat's newest plan ("newest", open when
// it first shows, live or after a reload), and its turn goes on ("live"); `sources`: what the
// turn's web tools used, under its last reply (rows.ts turnSources)
export type ChatRowProps = {
  row: Row;
  streaming: boolean;
  toolState: ToolState;
  plan?: "newest" | "live" | undefined;
  sources?: readonly SourceItem[] | undefined;
};

export const ChatRow = memo(function ChatRow({ row, streaming, toolState, plan, sources }: ChatRowProps) {
  return (
    <RowBoundary text={row.kind === "tool" ? `${row.name} ${row.args}\n${row.output ?? ""}` : row.text}>
      <RowView plan={plan} row={row} sources={sources} streaming={streaming} toolState={toolState} />
    </RowBoundary>
  );
});

function RowView({ row, streaming, toolState, plan, sources }: ChatRowProps) {
  switch (row.kind) {
    case "user":
      return <UserMessage text={row.text} />;
    case "note":
      return (
        <Message align="end" data-testid="user-message">
          <MessageContent className="gap-1">
            <MessageHeader className="gap-1 px-1 text-2xs">
              <NotebookPenIcon aria-hidden="true" className="size-3" />
              Note
            </MessageHeader>
            <Bubble align="end" className="max-w-[85%] sm:max-w-[min(80%,36rem)]" variant="outline">
              <BubbleContent className="rounded-2xl border-dashed border-input px-3.5 py-2 text-read text-muted-foreground whitespace-pre-wrap">{row.text}</BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      );
    case "talk":
      return <Reply id={row.key} sources={sources} streaming={streaming} text={row.text} />;
    case "tool": {
      const steps = planOf(row);
      if (steps !== null) return <PlanRow plan={plan} row={row} steps={steps} toolState={toolState} />;
      return (
        <Tool>
          <ToolHeader detail={toolSummary(row.args)} name={row.name} state={toolState} />
          <ToolContent>
            {row.args !== "" && <ToolInput input={row.args} />}
            {row.output !== null && <ToolOutput failed={toolState === "error"} output={row.output} />}
          </ToolContent>
        </Tool>
      );
    }
  }
}
