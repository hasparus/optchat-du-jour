// One row of the chat (SPEC "Web UI", Chat; DESIGN.md, The transcript): a user message as a soft
// bubble on the right, a note likewise and marked as one, a reply as plain prose (markdown) with
// copy and a raw-text toggle under it (rendering never hides what the model wrote), a tool call as
// one work-log line with its input and output collapsed under it; a TodoWrite call as a plan, and
// the links a turn's web tools used as its reply's sources. What the model thought before a reply
// or a tool call is a Reasoning line above it (SPEC "Reasoning").
import { MessageAction, MessageActions, MessageResponse } from "@/components/ai-elements/message";
import { Plan, PlanContent, PlanHeader, PlanLogged, PlanSteps } from "@/components/ai-elements/plan";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import { Source, Sources, SourcesContent, SourcesTrigger } from "@/components/ai-elements/sources";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import type { Made } from "@/lib/artifacts";
import { type Thought, thoughtLabel } from "@/lib/reasoning";
import { type PlanState, type PlanStep, planOf, type Row, type ToolState, toolSummary, type WebSource } from "@/lib/rows";
import { cn } from "@/lib/utils";
import { splitMarkers } from "@wire";
import { CheckIcon, CodeIcon, CopyIcon, NotebookPenIcon, TextIcon } from "lucide-react";
import { Component, createContext, memo, type ReactNode, use, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArtifactCard, madeDetail } from "./artifact-card";

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

function Reply({ id, text, streaming, sources }: { id: string; text: string; streaming: boolean; sources: readonly WebSource[] | undefined }) {
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
// marker's 12 hex digits; only user rows show them, so nothing a model wrote is ever fetched. A
// thumbnail is a plain link to the full asset: it has no state or action for Attachment to carry,
// and keeps its own shape where Attachment's image media is a square crop.
function UserMessage({ text }: { text: string }) {
  const { body, markers } = splitMarkers(text);
  return (
    <Message align="end" data-testid="user-message">
      <MessageContent className="gap-1.5">
        {markers.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5" data-testid="user-attachments">
            {markers.map((m) => (
              <a
                aria-label={`Open ${m.kind} ${m.sha}`}
                className="block overflow-hidden rounded-xl border bg-muted transition-opacity hover:opacity-90"
                href={`/api/assets/${m.sha}`}
                key={m.line}
                rel="noreferrer"
                target="_blank"
              >
                <img alt={`${m.kind} ${m.sha}`} className="max-h-44 max-w-60 object-contain" loading="lazy" src={`/api/assets/${m.sha}/thumb`} />
              </a>
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

// A turn's TodoWrite call as a plan. The chat's newest plan is open and the others closed, live and
// after a reload alike, until the reader opens or closes one: then their choice stays (the Reasoning
// pattern's open state).
function PlanRow({ row, steps, toolState, plan }: { row: Extract<Row, { kind: "tool" }>; steps: readonly PlanStep[]; toolState: ToolState; plan: ChatRowProps["plan"] }) {
  const [chosen, setChosen] = useState<boolean | null>(null);
  const live = plan === "live";
  return (
    <Plan onOpenChange={setChosen} open={chosen ?? (plan === "newest" || plan === "live")}>
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

// The Reasoning line above a reply or a tool call: closed until the reader opens it, also while it
// streams; the label says "Thinking" while it streams, then how long it took. Controlled: whether it
// is open, and reading its text when it is opened, are the session store's (`onThought`, its
// toggleThought), so the reader's choice stays with the piece when it moves or its row is drawn again.
function ThoughtLine({ thought, onThought }: { readonly thought: Thought; readonly onThought: (i: number, open: boolean) => void }) {
  return (
    <Reasoning
      isStreaming={thought.live}
      onOpenChange={(next) => {
        onThought(thought.i, next);
      }}
      open={thought.open}
    >
      <ReasoningTrigger isStreaming={thought.live} label={thoughtLabel(thought)} />
      <ReasoningContent cut={thought.cut} failed={thought.failed} text={thought.text} />
    </Reasoning>
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

/** Memo keeps unchanged rows above a streamed token (rows.ts chatRows).
 * `plan` follows planStates: the chat's newest ("newest", initially open), only the newest plan
 * of the active RUN_STARTED run, even across a steer ("live"), or an older turn's ("turn", closed).
 * Earlier TodoWrite rows within a turn stay plain tool lines. `sources` is turnSources' list
 * under the turn's last reply. `thought` is what the model thought before this reply or tool call
 * (SPEC "Reasoning"); a `thinking` row is that alone, until its entry comes.
 */
export type ChatRowProps = {
  row: Row;
  streaming: boolean;
  toolState: ToolState;
  plan?: PlanState | undefined;
  sources?: readonly WebSource[] | undefined;
  thought?: Thought | undefined;
  onThought?: ((i: number, open: boolean) => void) | undefined;
  // the artifact version a publish or edit row made (SPEC "Artifacts"), and opening it in the pane
  made?: Made | null | undefined;
  onArtifact?: ((name: string, v: number | null) => void) | undefined;
};

const noToggle = () => {
  // a row outside a chat (the story page): nothing to open
};

const rowText = (row: Row) => {
  switch (row.kind) {
    case "tool":
      return `${row.name} ${row.args}\n${row.output ?? ""}`;
    case "thinking":
      return "";
    case "user":
    case "note":
    case "talk":
      return row.text;
  }
};

export const ChatRow = memo(function ChatRow({ row, streaming, toolState, plan, sources, thought, onThought = noToggle, made, onArtifact }: ChatRowProps) {
  const thinks = thought !== undefined && (row.kind === "talk" || row.kind === "tool" || row.kind === "thinking");
  const view = <RowView made={made} onArtifact={onArtifact} plan={plan} row={row} sources={sources} streaming={streaming} toolState={toolState} />;
  return (
    <RowBoundary text={rowText(row)}>
      {thinks ? (
        <div className={cn("flex min-w-0 flex-col", row.kind === "talk" ? "gap-1.5" : "gap-0.5")}>
          <ThoughtLine onThought={onThought} thought={thought} />
          {view}
        </div>
      ) : (
        view
      )}
    </RowBoundary>
  );
});

function RowView({ row, streaming, toolState, plan, sources, made, onArtifact }: ChatRowProps) {
  switch (row.kind) {
    case "thinking":
      return null;
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
      const steps = plan === undefined ? null : planOf(row);
      if (steps !== null) return <PlanRow plan={plan} row={row} steps={steps} toolState={toolState} />;
      const line = (
        <Tool>
          <ToolHeader detail={made ? made.name : toolSummary(row.args)} name={row.name} state={toolState} />
          <ToolContent>
            {row.args !== "" && <ToolInput input={row.args} />}
            {row.output !== null && <ToolOutput failed={toolState === "error"} output={row.output} />}
          </ToolContent>
        </Tool>
      );
      // a version an artifact call made: its card under the call's line, which keeps the input
      // and output as logged (a stub, E31) one tap away
      if (!made) return line;
      return (
        <div className="flex min-w-0 flex-col gap-1.5 pb-1">
          {line}
          <ArtifactCard
            detail={madeDetail(made, toolState === "running")}
            live={made.v === null && toolState === "running"}
            name={made.name}
            onOpen={() => {
              onArtifact?.(made.name, made.v);
            }}
          />
        </div>
      );
    }
  }
}
