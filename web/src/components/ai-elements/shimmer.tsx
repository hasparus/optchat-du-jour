// AI Elements' Shimmer, as the October 2026 AI Elements replace it: shadcn/ui's `shimmer` utility
// (ui.shadcn.com/docs/utils/shimmer, from shadcn/tailwind.css), the same sweep Trace puts on a
// running line's title. Text with a sheen passing over it, for a turn that is running or a page
// that is loading; still, in its own colour, for those who asked for no motion. The text rests
// muted and the sweep brightens it to ink (index.css, --shimmer-color), so it stays AA throughout.
import { cn } from "@/lib/utils";

export const Shimmer = ({ children, className }: { readonly children: string; readonly className?: string }) => (
  <span className={cn("shimmer text-muted-foreground", className)} data-slot="shimmer">
    {children}
  </span>
);
