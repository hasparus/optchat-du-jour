// AI Elements' Reasoning, built on shadcn/ui's Trace as the October 2026 patterns build Tool and
// Sources (ui.shadcn.com/docs/ai-elements/radix/reasoning): one line above the reply or tool call
// the model thought before, "Thought for 12 s", that opens into what it thought. Ours differ from
// the pattern where the app needs it (SPEC "Reasoning", DESIGN.md Tool calls):
// - collapsed by default, also while it streams (the pattern opens itself then and closes after):
//   the reply is what a reader came for, and a phone has no room for a long think pushing it down.
//   The line shimmers ("Thinking") while it streams.
// - open or closed is the reader's per row, kept in memory only (chat/row.tsx).
// - its text is plain, as written (no markdown, so nothing hides what the model wrote and no raw
//   toggle is needed), and after a reload it is read only when the line is opened.
// - what the caps left out is said under it.
// How long it took and whether it streams come from lib/reasoning.ts; this file only draws it.
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { cn } from "@/lib/utils";
import { BrainIcon } from "lucide-react";
import type { ComponentProps } from "react";

export type ReasoningProps = Omit<ComponentProps<typeof TraceCollapsible>, "open" | "onOpenChange"> & {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly isStreaming: boolean;
};

// a Trace of one line; `data-slot="reasoning"` names it (its data-state says whether it is open)
export const Reasoning = ({ className, children, isStreaming, ...props }: ReasoningProps) => (
  <Trace>
    <TraceCollapsible className={className} data-slot="reasoning" data-streaming={isStreaming ? "" : undefined} {...props}>
      {children}
    </TraceCollapsible>
  </Trace>
);

export type ReasoningTriggerProps = Omit<ComponentProps<typeof TraceCollapsibleTrigger>, "children"> & {
  // "Thinking", "Thought for 12 s" or "Reasoning" (lib/reasoning.ts thoughtLabel)
  readonly label: string;
  readonly isStreaming: boolean;
};

// The trigger is the line itself, as a tool call's is: Trace's 28 px row (40 px on a touch screen),
// a brain, the label, Trace's chevron. While it streams the label sweeps (Trace's running status).
export const ReasoningTrigger = ({ className, label, isStreaming, ...props }: ReasoningTriggerProps) => (
  <TraceCollapsibleTrigger className={cn("min-h-7 text-ui pointer-coarse:min-h-10", className)} {...props}>
    <TraceLine className="text-ui" status={isStreaming ? "running" : undefined}>
      <TraceIcon>
        <BrainIcon className="size-3.5" strokeWidth={1.75} />
      </TraceIcon>
      <TraceTitle data-slot="reasoning-title">{isStreaming ? `${label}…` : label}</TraceTitle>
    </TraceLine>
  </TraceCollapsibleTrigger>
);

export type ReasoningContentProps = Omit<ComponentProps<typeof TraceCollapsibleContent>, "children"> & {
  // null while it is read from the server
  readonly text: string | null;
  // characters the caps left out
  readonly cut: number;
  // its text couldn't be read
  readonly failed: boolean;
};

// Under Trace's indented rule: what the model thought, as written, in UI type; what was left out
export const ReasoningContent = ({ className, text, cut, failed, ...props }: ReasoningContentProps) => (
  <TraceCollapsibleContent className={cn("text-ui", className)} {...props}>
    {text === null ? (
      failed ? (
        <span className="text-muted-foreground">It couldn't be read: try again later.</span>
      ) : (
        <Shimmer>loading…</Shimmer>
      )
    ) : (
      <p className="wrap-break-word whitespace-pre-wrap" data-slot="reasoning-text">
        {text}
      </p>
    )}
    {cut > 0 && (
      <p className="mt-1.5 text-xs text-muted-foreground" data-slot="reasoning-cut">
        {cut.toLocaleString("en")} more characters were not kept.
      </p>
    )}
  </TraceCollapsibleContent>
);
