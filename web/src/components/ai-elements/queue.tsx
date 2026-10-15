// AI Elements' Queue, rebuilt on shadcn/ui's Trace as the October 2026 AI Elements do it
// (ui.shadcn.com/docs/ai-elements/radix/queue): a section is a collapsible trace line ("2 waiting
// for the model") over a list of lines. Here the lines are messages sent but not taken by the model
// yet, above the composer (SPEC "Web UI", Chat), in the tray attached to its top edge (DESIGN.md,
// Composer). Todos are left out; an item's one action takes a held message back into the
// composer. An item may run to two lines and carry thumbnails, so its line wraps rather than
// truncating, and its action sits beside it, never inside the trigger.
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import { cn } from "@/lib/utils";
import { ListIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export type QueueItemProps = ComponentProps<typeof TraceLine>;

export const QueueItem = ({ className, ...props }: QueueItemProps) => (
  <TraceLine className={cn("w-full items-start gap-2.5 py-1 text-ui text-foreground", className)} role="listitem" {...props} />
);

export type QueueItemIndicatorProps = ComponentProps<"span">;

// the line's icon: a small ring, filled or dashed by where the message stands
export const QueueItemIndicator = ({ className, ...props }: QueueItemIndicatorProps) => (
  <TraceIcon className="mt-0.5">
    <span className={cn("inline-block size-2 rounded-full border border-muted-foreground/60", className)} {...props} />
  </TraceIcon>
);

export type QueueItemContentProps = ComponentProps<typeof TraceTitle>;

export const QueueItemContent = ({ className, ...props }: QueueItemContentProps) => (
  <TraceTitle className={cn("line-clamp-2 block whitespace-normal wrap-break-word text-foreground", className)} {...props} />
);

export type QueueItemActionProps = ComponentProps<"button">;

// an icon button at the item's end, a 32 px target (40 px on touch)
export const QueueItemAction = ({ className, ...props }: QueueItemActionProps) => (
  <button
    className={cn(
      "-my-1.5 ml-auto flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:not-disabled:scale-95 disabled:opacity-50 pointer-coarse:size-10 [&_svg]:size-4",
      className,
    )}
    type="button"
    {...props}
  />
);

export type QueueListProps = ComponentProps<typeof Trace>;

// the section's lines; a long queue scrolls within 160 px
export const QueueList = ({ className, ...props }: QueueListProps) => <Trace className={cn("max-h-40 gap-0 overflow-y-auto pr-1", className)} role="list" {...props} />;

export type QueueSectionProps = Omit<ComponentProps<typeof TraceCollapsible>, "open" | "onOpenChange">;

export const QueueSection = ({ defaultOpen = true, ...props }: QueueSectionProps) => <TraceCollapsible defaultOpen={defaultOpen} {...props} />;

export type QueueSectionTriggerProps = ComponentProps<typeof TraceCollapsibleTrigger>;

export const QueueSectionTrigger = ({ className, ...props }: QueueSectionTriggerProps) => (
  <TraceCollapsibleTrigger className={cn("min-h-7 pointer-coarse:min-h-10", className)} {...props} />
);

export type QueueSectionLabelProps = ComponentProps<typeof TraceLine> & {
  count: number;
  label: string;
  icon?: ReactNode;
};

export const QueueSectionLabel = ({ count, label, icon, className, ...props }: QueueSectionLabelProps) => (
  <TraceLine className={cn("text-2xs font-medium", className)} {...props}>
    <TraceIcon>{icon ?? <ListIcon className="size-3.5" />}</TraceIcon>
    <TraceTitle>
      {count} {label}
    </TraceTitle>
  </TraceLine>
);

export type QueueSectionContentProps = ComponentProps<typeof TraceCollapsibleContent>;

export const QueueSectionContent = ({ className, ...props }: QueueSectionContentProps) => <TraceCollapsibleContent className={cn("mt-1 mb-0 text-foreground", className)} {...props} />;

export type QueueProps = ComponentProps<typeof Trace>;

export const Queue = ({ className, ...props }: QueueProps) => <Trace className={cn("px-3.5 pt-1 pb-2", className)} {...props} />;
