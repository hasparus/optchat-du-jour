// AI Elements' Tool (elements.ai-sdk.dev registry): one tool call, collapsed. The AI SDK's tool part
// types are replaced by ours: a `tool` log entry is a name and its JSON input, and the `echo` entry
// after it is the output (SPEC "Web UI", Chat). There are no approvals here. Drawn as a work-log
// line (DESIGN.md, Tool calls): an icon for the kind of tool, its name and what it was called on,
// and only the states worth reading: running, failed, no output. "Completed" is the norm, said only
// to a screen reader. Open, the input as logged and the output sit in one panel under the line. How
// a row reads (its state, name, summary) is decided in lib/rows.ts; this file only draws it.
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { TOOL_STATE_LABELS, toolName, type ToolState } from "@/lib/rows";
import { cn } from "@/lib/utils";
import {
  BotIcon,
  CalendarIcon,
  ChevronRightIcon,
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

import { CodeBlock } from "./code-block";
import { Shimmer } from "./shimmer";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => <Collapsible className={cn("group/tool w-full", className)} data-slot="tool" {...props} />;

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
  zoom: ScanSearchIcon,
}));
const toolIcon = (name: string): LucideIcon => ICONS.get(toolName(name)) ?? WrenchIcon;

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  readonly name: string;
  // what it was called on, one line (lib/rows.ts toolSummary)
  readonly detail: string;
  readonly state: ToolState;
};

export const ToolHeader = ({ className, name, detail, state, ...props }: ToolHeaderProps) => {
  const Icon = toolIcon(name);
  return (
    <CollapsibleTrigger
      className={cn(
        "group/tool-header relative flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md text-left text-ui text-muted-foreground transition-colors pointer-coarse:min-h-10",
        "before:absolute before:-inset-x-2 before:inset-y-0 before:rounded-md before:transition-colors hover:text-foreground hover:before:bg-accent",
        className,
      )}
      {...props}
    >
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <Icon
          aria-hidden="true"
          className={cn("size-3.5", state === "running" && "animate-breathe text-foreground", state === "error" && "text-destructive")}
          strokeWidth={1.75}
        />
      </span>
      <span className="relative flex min-w-0 flex-1 items-baseline gap-2">
        {state === "running" ? (
          <Shimmer className="shrink-0 font-medium">{toolName(name)}</Shimmer>
        ) : (
          <span className="shrink-0 font-medium text-foreground/85">{toolName(name)}</span>
        )}
        {detail !== "" && <span className="min-w-0 truncate font-mono text-xs">{detail}</span>}
      </span>
      {state === "error" || state === "ended" ? (
        <span className={cn("relative shrink-0 text-xs", state === "error" ? "font-medium text-destructive" : "text-muted-foreground")} data-slot="tool-status">
          {TOOL_STATE_LABELS[state]}
        </span>
      ) : (
        <span className="sr-only" data-slot="tool-status">
          {TOOL_STATE_LABELS[state]}
        </span>
      )}
      <ChevronRightIcon
        aria-hidden="true"
        className="relative size-3.5 shrink-0 opacity-0 transition-[transform,opacity] duration-150 group-hover/tool-header:opacity-100 group-focus-visible/tool-header:opacity-100 group-data-[state=open]/tool:rotate-90 group-data-[state=open]/tool:opacity-100 pointer-coarse:opacity-60"
      />
    </CollapsibleTrigger>
  );
};

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "mt-1 mb-2 ml-6 overflow-hidden rounded-lg border bg-code text-foreground outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:slide-in-from-top-1",
      className,
    )}
    {...props}
  />
);

const SectionLabel = ({ children }: { readonly children: ReactNode }) => <h4 className="text-2xs font-medium text-muted-foreground">{children}</h4>;

export type ToolInputProps = ComponentProps<"div"> & {
  // the input exactly as logged: highlighted, never re-serialised
  readonly input: string;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("overflow-hidden", className)} {...props}>
    <div className="flex h-8 items-center px-3">
      <SectionLabel>Input</SectionLabel>
    </div>
    <CodeBlock className="rounded-none border-0 bg-transparent" code={input} language="json" />
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  readonly output: ReactNode;
};

export const ToolOutput = ({ className, output, ...props }: ToolOutputProps) => (
  <div className={cn("border-t first:border-t-0", className)} {...props}>
    {output}
  </div>
);
