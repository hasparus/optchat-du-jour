// AI Elements' Sources, built on shadcn/ui's Trace as the October 2026 pattern does it
// (ui.shadcn.com/docs/ai-elements/radix/sources): one line under a reply, "Used 3 sources", that
// opens into a link per source. Ours come from the turn's WebFetch and WebSearch calls as logged
// (lib/rows.ts turnSources), so they read the same live and after a reload. Plain links: nothing
// is fetched to show them (no favicons, SPEC "Web UI": model output never makes the phone fetch
// anything), and only http(s) addresses get this far. A link opens a new tab; in the iOS app that
// is the in-app Safari sheet (E27). Collapsed by default, like the tool lines.
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import type { Source as SourceItem } from "@/lib/rows";
import { cn } from "@/lib/utils";
import { ArrowUpRightIcon, GlobeIcon } from "lucide-react";
import type { ComponentProps } from "react";

export type SourcesProps = Omit<ComponentProps<typeof TraceCollapsible>, "open" | "onOpenChange">;

export const Sources = ({ className, children, ...props }: SourcesProps) => (
  <Trace>
    <TraceCollapsible className={className} data-slot="sources" {...props}>
      {children}
    </TraceCollapsible>
  </Trace>
);

export type SourcesTriggerProps = Omit<ComponentProps<typeof TraceCollapsibleTrigger>, "children"> & { readonly count: number };

export const SourcesTrigger = ({ className, count, ...props }: SourcesTriggerProps) => (
  <TraceCollapsibleTrigger className={cn("min-h-7 text-ui pointer-coarse:min-h-10", className)} {...props}>
    <TraceLine className="text-ui">
      <TraceIcon>
        <GlobeIcon className="size-3.5" strokeWidth={1.75} />
      </TraceIcon>
      <TraceTitle>
        Used {count} {count === 1 ? "source" : "sources"}
      </TraceTitle>
    </TraceLine>
  </TraceCollapsibleTrigger>
);

export type SourcesContentProps = ComponentProps<typeof TraceCollapsibleContent>;

export const SourcesContent = ({ className, children, ...props }: SourcesContentProps) => (
  <TraceCollapsibleContent className={className} {...props}>
    <Trace className="gap-0">{children}</Trace>
  </TraceCollapsibleContent>
);

export type SourceProps = Omit<ComponentProps<"a">, "children" | "href" | "title"> & { readonly source: SourceItem };

// a link around a trace line: its title, the host under it when the title isn't the host
export const Source = ({ className, source, ...props }: SourceProps) => {
  const host = new URL(source.url).hostname;
  return (
    <a className={cn("min-h-7 py-0.5 pointer-coarse:min-h-10", className)} data-slot="source" href={source.url} rel="noreferrer" target="_blank" {...props}>
      <TraceLine className="text-ui">
        <TraceTitle className="text-foreground/85">
          {source.title}
          {source.title !== host && <span className="ml-2 text-xs text-muted-foreground">{host}</span>}
          <span className="sr-only"> (opens in a new tab)</span>
        </TraceTitle>
        <TraceIcon>
          <ArrowUpRightIcon className="size-3.5" strokeWidth={1.75} />
        </TraceIcon>
      </TraceLine>
    </a>
  );
};
