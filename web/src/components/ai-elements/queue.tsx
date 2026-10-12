// AI Elements' Queue (elements.ai-sdk.dev registry): messages sent but not taken by the model yet,
// above the composer (SPEC "Web UI", Chat), in the tray attached to its top edge (DESIGN.md,
// Composer). Todos are left out; an item's one action takes a held message back into the composer.
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

export type QueueItemProps = ComponentProps<"li">;

export const QueueItem = ({ className, ...props }: QueueItemProps) => (
  <li className={cn("group flex items-start gap-2.5 py-1.5 text-ui", className)} {...props} />
);

export type QueueItemIndicatorProps = ComponentProps<"span">;

export const QueueItemIndicator = ({ className, ...props }: QueueItemIndicatorProps) => (
  <span className={cn("mt-1.5 inline-block size-2 shrink-0 rounded-full border border-muted-foreground/60", className)} {...props} />
);

export type QueueItemContentProps = ComponentProps<"span">;

export const QueueItemContent = ({ className, ...props }: QueueItemContentProps) => (
  <span className={cn("line-clamp-2 grow wrap-break-word text-foreground", className)} {...props} />
);

export type QueueItemActionProps = ComponentProps<"button">;

// an icon button at the item's end, a 32 px target
export const QueueItemAction = ({ className, ...props }: QueueItemActionProps) => (
  <button
    className={cn(
      "-my-1 flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:not-disabled:scale-95 disabled:opacity-50 pointer-coarse:size-10 [&_svg]:size-4",
      className,
    )}
    type="button"
    {...props}
  />
);

export type QueueListProps = ComponentProps<typeof ScrollArea>;

export const QueueList = ({ children, className, ...props }: QueueListProps) => (
  <ScrollArea className={cn("-mb-1", className)} {...props}>
    <div className="max-h-40 pr-1">
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
        "group flex min-h-7 w-full items-center justify-between rounded-md text-left text-2xs font-medium text-muted-foreground transition-colors hover:text-foreground pointer-coarse:min-h-9",
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
  <span className={cn("flex items-center gap-1.5", className)} {...props}>
    <ChevronDownIcon className="size-3.5 transition-transform duration-150 group-data-[state=closed]:-rotate-90" />
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
  <div className={cn("flex flex-col px-3.5 pt-1 pb-2", className)} {...props} />
);
