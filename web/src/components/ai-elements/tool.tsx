// AI Elements' Tool (elements.ai-sdk.dev registry): one tool call, collapsed. The AI SDK's tool part
// types are replaced by ours: a `tool` log entry is a name and its JSON input, and the `echo` entry
// after it is the output (SPEC "Web UI", Chat). There are no approvals here. Drawn as a work-log
// line (DESIGN.md, Tool calls): an icon for the kind of tool, its name and what it was called on,
// and only the states worth reading: running, failed, no output. "Completed" is the norm, said only
// to a screen reader. Open, the input as logged and the output sit in one panel under the line.
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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

// running: no echo yet; done: the echo is in; ended: the turn ended without one; error: the echo
// says the call failed (rows.ts toolFailed)
export type ToolState = "running" | "done" | "ended" | "error";

export type ToolProps = ComponentProps<typeof Collapsible> & { readonly state: ToolState };

export const Tool = ({ className, state, ...props }: ToolProps) => (
  <Collapsible className={cn("group/tool w-full", className)} data-slot="tool" data-tool-state={state} {...props} />
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
  zoom: ScanSearchIcon,
}));
// an MCP tool comes as mcp__<server>__<name>
const baseName = (name: string) => name.split("__").at(-1) ?? name;
export const toolIcon = (name: string): LucideIcon => ICONS.get(baseName(name)) ?? WrenchIcon;

const statusLabels = {
  done: "Completed",
  ended: "No output",
  error: "Failed",
  running: "Running",
} satisfies Record<ToolState, string>;

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  readonly name: string;
  // what it was called on, one line (row.tsx toolSummary)
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
          <Shimmer className="shrink-0 font-medium">{baseName(name)}</Shimmer>
        ) : (
          <span className="shrink-0 font-medium text-foreground/85">{baseName(name)}</span>
        )}
        {detail !== "" && <span className="min-w-0 truncate font-mono text-xs">{detail}</span>}
      </span>
      {state === "error" || state === "ended" ? (
        <span className={cn("relative shrink-0 text-xs", state === "error" ? "font-medium text-destructive" : "text-muted-foreground")} data-slot="tool-status">
          {statusLabels[state]}
        </span>
      ) : (
        <span className="sr-only" data-slot="tool-status">
          {statusLabels[state]}
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

const SectionLabel = ({ children, tone }: { readonly children: ReactNode; readonly tone?: "error" }) => (
  <h4 className={cn("text-2xs font-medium text-muted-foreground", tone === "error" && "text-destructive")}>{children}</h4>
);

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
  readonly failed?: boolean;
};

export const ToolOutput = ({ className, output, failed = false, ...props }: ToolOutputProps) => (
  <div className={cn("border-t first:border-t-0", className)} data-state={failed ? "error" : undefined} {...props}>
    {output}
  </div>
);

export { SectionLabel as ToolSectionLabel };
