// The segmented control (DESIGN.md, Navigation): a row of text choices, the chosen one lifted onto a
// raised fill with a hairline and a 1 px shadow. The app's tabs (Radix Tabs, chosen by
// data-state=active) and the Stats toggles (pressed buttons, chosen by aria-pressed) share these
// classes, so the two read as one control. 28 px tall, 40 px on a touch screen.
import { cn } from "@/lib/utils";
import { cva } from "class-variance-authority";
import type { ComponentProps } from "react";

export const segmentedList = cva("inline-flex items-center gap-0.5 rounded-lg", {
  defaultVariants: { ground: "well" },
  // well: on a muted tray (a toggle on a page); bare: straight on the header band (the tabs)
  variants: { ground: { bare: "bg-transparent p-0", well: "bg-muted p-0.5" } },
});

export const segmentedItem = cn(
  "inline-flex h-7 items-center justify-center rounded-md px-2.5 text-ui font-medium whitespace-nowrap text-muted-foreground capitalize transition-colors hover:text-foreground pointer-coarse:h-10",
  "aria-pressed:bg-raised aria-pressed:text-foreground aria-pressed:shadow-lift",
  "data-[state=active]:bg-raised data-[state=active]:text-foreground data-[state=active]:shadow-lift",
);

export function Segmented({ className, ...props }: ComponentProps<"div"> & { readonly "aria-label": string }) {
  return <div className={cn(segmentedList(), className)} role="group" {...props} />;
}

export function SegmentedButton({ pressed, className, ...props }: Omit<ComponentProps<"button">, "aria-pressed"> & { readonly pressed: boolean }) {
  return <button aria-pressed={pressed} className={cn(segmentedItem, className)} type="button" {...props} />;
}
