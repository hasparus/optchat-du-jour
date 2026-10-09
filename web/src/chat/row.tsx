// One row of the chat (SPEC "Web UI", Chat): a user or note message as a bubble, a reply as
// markdown with a raw-text toggle (rendering never hides what the model wrote), a tool call with
// its output collapsed.
import { MessageAction, MessageActions, MessageResponse } from "@/components/ai-elements/message";
import { Terminal } from "@/components/ai-elements/terminal";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolState } from "@/components/ai-elements/tool";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import type { Row } from "@/lib/rows";
import { splitMarkers } from "@wire";
import { CodeIcon, TextIcon } from "lucide-react";
import { Component, memo, type ReactNode, useState } from "react";

const oneLine = (s: string, max = 80) => {
  const flat = s.replaceAll(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function Reply({ text, streaming }: { text: string; streaming: boolean }) {
  const [raw, setRaw] = useState(false);
  return (
    <Message align="start">
      <MessageContent>
        <Bubble className="max-w-full" variant="ghost">
          <BubbleContent className="w-full text-sm">
            {raw ? (
              <pre className="font-mono text-xs wrap-break-word whitespace-pre-wrap">{text}</pre>
            ) : (
              <MessageResponse isAnimating={streaming}>{text}</MessageResponse>
            )}
          </BubbleContent>
        </Bubble>
        <MessageActions>
          <MessageAction
            aria-pressed={raw}
            className="text-muted-foreground pointer-coarse:size-10"
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
      <MessageContent>
        {markers.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5" data-testid="user-attachments">
            {markers.map((m) => (
              <a className="block overflow-hidden rounded-lg border" href={`/api/assets/${m.sha}`} key={m.line} rel="noreferrer" target="_blank">
                <img alt={`${m.kind} ${m.sha}`} className="max-h-40 max-w-56 object-contain" loading="lazy" src={`/api/assets/${m.sha}/thumb`} />
              </a>
            ))}
          </div>
        )}
        <Bubble align="end">
          <BubbleContent className="whitespace-pre-wrap">
            {body}
            {markers.length > 0 && (
              <span className="text-xs opacity-70">
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
          <MessageContent>
            <MessageHeader>note</MessageHeader>
            <Bubble align="end" variant="muted">
              <BubbleContent className="whitespace-pre-wrap">{row.text}</BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      );
    case "talk":
      return <Reply streaming={streaming} text={row.text} />;
    case "tool":
      return (
        <Tool>
          <ToolHeader state={toolState} title={oneLine(`${row.name} ${row.args}`)} />
          <ToolContent>
            {row.args !== "" && <ToolInput input={row.args} />}
            {row.output !== null && <ToolOutput output={<Terminal output={row.output} />} />}
          </ToolContent>
        </Tool>
      );
  }
}
