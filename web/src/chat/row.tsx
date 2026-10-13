// One row of the chat (SPEC "Web UI", Chat; DESIGN.md, The transcript): a user message as a soft
// bubble on the right, a note likewise and marked as one, a reply as plain prose (markdown) with
// copy and a raw-text toggle under it (rendering never hides what the model wrote), a tool call as
// one work-log line with its input and output collapsed under it.
import { MessageAction, MessageActions, MessageResponse } from "@/components/ai-elements/message";
import { Terminal } from "@/components/ai-elements/terminal";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import { type Row, type ToolState, toolSummary } from "@/lib/rows";
import { splitMarkers } from "@wire";
import { CheckIcon, CodeIcon, CopyIcon, NotebookPenIcon, TextIcon } from "lucide-react";
import { Component, createContext, memo, type ReactNode, use, useEffect, useMemo, useRef, useState } from "react";

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

function Reply({ id, text, streaming }: { id: string; text: string; streaming: boolean }) {
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
// marker's 12 hex digits; only user rows show them, so nothing a model wrote is ever fetched.
function UserMessage({ text }: { text: string }) {
  const { body, markers } = splitMarkers(text);
  return (
    <Message align="end" data-testid="user-message">
      <MessageContent className="gap-1.5">
        {markers.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5" data-testid="user-attachments">
            {markers.map((m) => (
              <a
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
export const ChatRow = memo(function ChatRow({ row, streaming, toolState }: { row: Row; streaming: boolean; toolState: ToolState }) {
  return (
    <RowBoundary text={row.kind === "tool" ? `${row.name} ${row.args}\n${row.output ?? ""}` : row.text}>
      <RowView row={row} streaming={streaming} toolState={toolState} />
    </RowBoundary>
  );
});

function RowView({ row, streaming, toolState }: { row: Row; streaming: boolean; toolState: ToolState }) {
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
      return <Reply id={row.key} streaming={streaming} text={row.text} />;
    case "tool":
      return (
        <Tool>
          <ToolHeader detail={toolSummary(row.args)} name={row.name} state={toolState} />
          <ToolContent>
            {row.args !== "" && <ToolInput input={row.args} />}
            {row.output !== null && (
              <ToolOutput output={<Terminal output={row.output} title={toolState === "error" ? <span className="text-destructive">Error</span> : undefined} />} />
            )}
          </ToolContent>
        </Tool>
      );
  }
}
