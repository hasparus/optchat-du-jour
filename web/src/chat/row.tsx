// One row of the chat (SPEC "Web UI", Chat): a user or note message as a bubble, a reply as
// markdown with a raw-text toggle (rendering never hides what the model wrote), a tool call with
// its output collapsed.
import { MessageAction, MessageActions, MessageResponse } from "@/components/ai-elements/message";
import { Terminal } from "@/components/ai-elements/terminal";
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput, type ToolState } from "@/components/ai-elements/tool";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import type { Row } from "@/lib/rows";
import { CodeIcon, TextIcon } from "lucide-react";
import { Component, type ReactNode, useState } from "react";

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

// a row that fails to render shows its text as logged, and the rest of the chat stays up
export class RowBoundary extends Component<{ readonly text: string; readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? <pre className="font-mono text-xs wrap-break-word whitespace-pre-wrap">{this.props.text}</pre> : this.props.children;
  }
}

export function ChatRow({ row, streaming, toolState }: { row: Row; streaming: boolean; toolState: ToolState }) {
  switch (row.kind) {
    case "user":
    case "note":
      return (
        <Message align="end" data-testid="user-message">
          <MessageContent>
            {row.kind === "note" && <MessageHeader>note</MessageHeader>}
            <Bubble align="end" variant={row.kind === "note" ? "muted" : "default"}>
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
