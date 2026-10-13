// AI Elements' Shimmer (elements.ai-sdk.dev registry, also ElevenLabs UI's ShimmeringText): text with
// a sheen sweeping over it, for a turn that is thinking or running. The registry drives the sweep
// with `motion` over gradient-filled text; here it is solid ink under a moving alpha mask, one CSS
// utility (index.css, shimmer-text), so the chat pulls in no animation library, and under
// prefers-reduced-motion the text stays still and plainly muted.
import { cn } from "@/lib/utils";

export const Shimmer = ({ children, className }: { readonly children: string; readonly className?: string }) => (
  <span className={cn("shimmer-text", className)} data-slot="shimmer">
    {children}
  </span>
);
