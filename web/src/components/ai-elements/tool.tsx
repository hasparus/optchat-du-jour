// AI Elements' Tool (elements.ai-sdk.dev registry): a collapsed row for one tool call. The AI SDK's
// tool part types are replaced by ours: a `tool` log entry is a name and its JSON input, and the
// `echo` entry after it is the output (SPEC "Web UI", Chat). There are no approvals here.
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { CheckCircleIcon, ChevronDownIcon, ClockIcon, MinusCircleIcon, WrenchIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import { CodeBlock } from "./code-block";

// running: no echo yet; done: the echo is in; ended: the turn ended without one
export type ToolState = "running" | "done" | "ended";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible className={cn("group w-full rounded-md border", className)} {...props} />
);

const statusLabels = {
  done: "Completed",
  ended: "No output",
  running: "Running",
} satisfies Record<ToolState, string>;

const statusIcons = {
  done: <CheckCircleIcon className="size-4 text-green-600" />,
  ended: <MinusCircleIcon className="size-4 text-muted-foreground" />,
  running: <ClockIcon className="size-4 animate-pulse" />,
} satisfies Record<ToolState, ReactNode>;

export const getStatusBadge = (status: ToolState) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

export type ToolHeaderProps = ComponentProps<typeof CollapsibleTrigger> & {
  title: string;
  state: ToolState;
};

export const ToolHeader = ({ className, title, state, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger className={cn("flex w-full items-center justify-between gap-2 p-2", className)} {...props}>
    <div className="flex min-w-0 items-center gap-2">
      <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-mono text-xs">{title}</span>
      {getStatusBadge(state)}
    </div>
    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "space-y-3 p-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:animate-in data-[state=open]:slide-in-from-top-2",
      className,
    )}
    {...props}
  />
);

// the input as logged; pretty-printed when it is JSON
const pretty = (input: string) => {
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return input;
  }
};

export type ToolInputProps = ComponentProps<"div"> & {
  input: string;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Parameters</h4>
    <div className="rounded-md bg-muted/50">
      <CodeBlock code={pretty(input)} language="json" />
    </div>
  </div>
);

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ReactNode;
};

export const ToolOutput = ({ className, output, ...props }: ToolOutputProps) => (
  <div className={cn("space-y-2", className)} {...props}>
    <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Result</h4>
    <div className="overflow-x-auto rounded-md text-xs">{output}</div>
  </div>
);
