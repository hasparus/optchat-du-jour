// AI Elements' Shimmer (elements.ai-sdk.dev registry, also ElevenLabs UI's ShimmeringText): text with
// a sheen sweeping over it, for a turn that is thinking or running. The registry drives the sweep
// with `motion`; here it is one CSS keyframe (index.css, oc-shimmer), so the chat pulls in no
// animation library, and under prefers-reduced-motion the text simply stays still and readable.
import { cn } from "@/lib/utils";
import type { CSSProperties, ElementType } from "react";

export type ShimmerProps = {
  readonly children: string;
  readonly as?: ElementType;
  readonly className?: string;
  // the sheen's width per character, in px (the registry's `spread`)
  readonly spread?: number;
};

export const Shimmer = ({ children, as: Component = "span", className, spread = 2 }: ShimmerProps) => (
  <Component
    className={cn(
      "inline-block animate-shimmer bg-size-[250%_100%,auto] bg-clip-text bg-no-repeat text-transparent motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-muted-foreground",
      className,
    )}
    data-slot="shimmer"
    // SAFETY: React's CSSProperties has no index for custom properties; `--spread` is a length
    // string, which is what a custom property holds
    style={
      {
        "--spread": `${Math.max(children.length * spread, 24)}px`,
        backgroundImage:
          "linear-gradient(90deg, transparent calc(50% - var(--spread)), var(--foreground), transparent calc(50% + var(--spread))), linear-gradient(var(--muted-foreground), var(--muted-foreground))",
      } as CSSProperties
    }
  >
    {children}
  </Component>
);
