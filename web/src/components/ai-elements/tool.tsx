// AI Elements' Tool, rebuilt on shadcn/ui's Trace and Code Block as the October 2026 AI Elements
// do it (ui.shadcn.com/docs/ai-elements/radix/tool): one tool call is a trace line that expands
// into its input and output. The AI SDK's tool part types are replaced by ours: a `tool` log entry
// is a name and its JSON input, and the `echo` entry after it is the output (SPEC "Web UI", Chat).
// There are no approvals here. The line reads as a work log (DESIGN.md, Tool calls): an icon for
// the kind of tool, its name and what it was called on, and only the states worth reading:
// running (the name shimmers), failed (from the flag the server logs, E28) and no output.
// "Completed" is the norm, said only to a screen reader. How a row reads (its state, name, summary)
// is decided in lib/rows.ts; this file only draws it.
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { TOOL_STATE_LABELS, toolName, type ToolState } from "@/lib/rows";
import { cn } from "@/lib/utils";
import {
  AppWindowIcon,
  BotIcon,
  CalendarIcon,
  FileTextIcon,
  GlobeIcon,
  ListChecksIcon,
  type LucideIcon,
  PencilLineIcon,
  ScanSearchIcon,
  SearchIcon,
  SquareTerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

// CSI and OSC sequences, and the other C0/C1 controls but newline and tab: a tool's output is shown
// as text, its escape sequences dropped rather than drawn as colours
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const ESCAPES = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
export const plainText = (s: string) => s.replaceAll(ESCAPES, "");

export type ToolProps = Omit<ComponentProps<typeof TraceCollapsible>, "open" | "onOpenChange">;

// a Trace of one line; `data-slot="tool"` names the call (its data-state says whether it is open)
export const Tool = ({ className, children, ...props }: ToolProps) => (
  <Trace className="group/tool">
    <TraceCollapsible className={className} data-slot="tool" {...props}>
      {children}
    </TraceCollapsible>
  </Trace>
);

const ICONS = new Map<string, LucideIcon>(Object.entries({
  Agent: BotIcon,
  Bash: SquareTerminalIcon,
  Edit: PencilLineIcon,
  Glob: SearchIcon,
  Grep: SearchIcon,
  MultiEdit: PencilLineIcon,
  NotebookEdit: PencilLineIcon,
  Read: FileTextIcon,
  Task: BotIcon,
  TodoWrite: ListChecksIcon,
  WebFetch: GlobeIcon,
  WebSearch: GlobeIcon,
  Write: PencilLineIcon,
  date: CalendarIcon,
  edit_artifact: AppWindowIcon,
  publish_artifact: AppWindowIcon,
  read_artifact: AppWindowIcon,
  zoom: ScanSearchIcon,
}));
const toolIcon = (name: string): LucideIcon => ICONS.get(toolName(name)) ?? WrenchIcon;

export type ToolHeaderProps = Omit<ComponentProps<typeof TraceCollapsibleTrigger>, "children"> & {
  readonly name: string;
  // what it was called on, one line (lib/rows.ts toolSummary)
  readonly detail: string;
  readonly state: ToolState;
  // what it changed, after the detail: a file tool's "+3 −1" (chat/tool-diff.tsx)
  readonly meta?: ReactNode;
};

// The trigger is the line itself: Trace's 28 px row (40 px on a touch screen), the chevron after
// the title. A failed call's line is red and says Failed; one that ended with nothing logged says
// so, muted; the others name their state to a screen reader only.
export const ToolHeader = ({ className, name, detail, state, meta, ...props }: ToolHeaderProps) => {
  const Icon = toolIcon(name);
  const shown = state === "error" || state === "ended";
  return (
    <TraceCollapsibleTrigger className={cn("min-h-7 text-ui pointer-coarse:min-h-10", className)} {...props}>
      <TraceLine className="text-ui" status={state === "running" ? "running" : state === "error" ? "error" : undefined}>
        <TraceIcon>
          <Icon className="size-3.5" strokeWidth={1.75} />
        </TraceIcon>
        <TraceTitle>
          <span className="font-medium text-foreground/85 in-data-[status=error]:text-destructive">{toolName(name)}</span>
          {detail !== "" && <span className="ml-2 font-mono text-xs">{detail}</span>}
          {meta !== undefined && <span className="ml-2">{meta}</span>}
        </TraceTitle>
        <TraceDescription className={cn(shown ? "text-xs" : "sr-only", state === "error" ? "font-medium text-destructive" : "text-muted-foreground")} data-slot="tool-status">
          {TOOL_STATE_LABELS[state]}
        </TraceDescription>
      </TraceLine>
    </TraceCollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof TraceCollapsibleContent>;

// open: the input and the output, each a small Code Block, on Trace's indented rule
export const ToolContent = ({ className, ...props }: ToolContentProps) => <TraceCollapsibleContent className={cn("flex flex-col gap-2", className)} {...props} />;

export type ToolInputProps = Omit<ComponentProps<typeof CodeBlock>, "children"> & {
  // the input exactly as logged: highlighted, never re-serialised
  readonly input: string;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const lines = useHighlightedCode(input, "json");
  return (
    <CodeBlock className={cn("bg-code", className)} size="sm" {...props}>
      <CodeBlockHeader>
        <CodeBlockTitle className="text-2xs text-muted-foreground">Input</CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton aria-label="Copy input" className="text-muted-foreground hover:text-foreground pointer-coarse:size-10" value={input} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent className="max-h-64" wrap>
        {lines.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- a line is its position
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
};

export type ToolOutputProps = Omit<ComponentProps<typeof CodeBlock>, "children"> & {
  // the `echo` entry's text, as logged
  readonly output: string;
  // the call failed (the logged flag): the block is the destructive one, titled Error
  readonly failed?: boolean;
};

export const ToolOutput = ({ className, output, failed = false, ...props }: ToolOutputProps) => {
  const text = plainText(output);
  return (
    <CodeBlock className={cn(!failed && "bg-code", className)} size="sm" variant={failed ? "destructive" : "default"} {...props}>
      <CodeBlockHeader>
        <CodeBlockTitle className={cn("text-2xs", !failed && "text-muted-foreground")}>{failed ? "Error" : "Output"}</CodeBlockTitle>
        <CodeBlockActions>
          {/* copied as logged, escape sequences and all; only the view drops them */}
          <CodeBlockCopyButton aria-label="Copy output" className="text-muted-foreground hover:text-foreground pointer-coarse:size-10" value={output} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent className="max-h-64 text-foreground/90" wrap>
        {text}
      </CodeBlockContent>
    </CodeBlock>
  );
};
