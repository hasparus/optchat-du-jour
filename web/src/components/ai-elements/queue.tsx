// AI Elements' Queue (elements.ai-sdk.dev registry): messages sent but not taken by the model yet,
// above the composer (SPEC "Web UI", Chat). Attachments, todos and item actions are left out: a
// queued message is text, and it can't be taken back once sent.
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export type QueueItemProps = ComponentProps<"li">;

export const QueueItem = ({ className, ...props }: QueueItemProps) => (
  <li className={cn("group flex items-start gap-2 rounded-md px-3 py-1 text-sm", className)} {...props} />
);

export type QueueItemIndicatorProps = ComponentProps<"span">;

export const QueueItemIndicator = ({ className, ...props }: QueueItemIndicatorProps) => (
  <span className={cn("mt-1.5 inline-block size-2.5 shrink-0 rounded-full border border-muted-foreground/50", className)} {...props} />
);

export type QueueItemContentProps = ComponentProps<"span">;

export const QueueItemContent = ({ className, ...props }: QueueItemContentProps) => (
  <span className={cn("line-clamp-2 grow wrap-break-word text-muted-foreground", className)} {...props} />
);

export type QueueListProps = ComponentProps<typeof ScrollArea>;

export const QueueList = ({ children, className, ...props }: QueueListProps) => (
  <ScrollArea className={cn("mt-2 -mb-1", className)} {...props}>
    <div className="max-h-40 pr-4">
      <ul>{children}</ul>
    </div>
  </ScrollArea>
);

export type QueueSectionProps = ComponentProps<typeof Collapsible>;

export const QueueSection = ({ className, defaultOpen = true, ...props }: QueueSectionProps) => (
  <Collapsible className={cn(className)} defaultOpen={defaultOpen} {...props} />
);

export type QueueSectionTriggerProps = ComponentProps<"button">;

export const QueueSectionTrigger = ({ children, className, ...props }: QueueSectionTriggerProps) => (
  <CollapsibleTrigger asChild>
    <button
      className={cn(
        "group flex w-full items-center justify-between rounded-md bg-muted/40 px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-muted",
        className,
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  </CollapsibleTrigger>
);

export type QueueSectionLabelProps = ComponentProps<"span"> & {
  count: number;
  label: string;
  icon?: ReactNode;
};

export const QueueSectionLabel = ({ count, label, icon, className, ...props }: QueueSectionLabelProps) => (
  <span className={cn("flex items-center gap-2", className)} {...props}>
    <ChevronDownIcon className="size-4 transition-transform group-data-[state=closed]:-rotate-90" />
    {icon}
    <span>
      {count} {label}
    </span>
  </span>
);

export type QueueSectionContentProps = ComponentProps<typeof CollapsibleContent>;

export const QueueSectionContent = ({ className, ...props }: QueueSectionContentProps) => (
  <CollapsibleContent className={cn(className)} {...props} />
);

export type QueueProps = ComponentProps<"div">;

export const Queue = ({ className, ...props }: QueueProps) => (
  <div className={cn("flex flex-col gap-2 rounded-xl border border-border bg-background px-3 py-2 shadow-xs", className)} {...props} />
);
