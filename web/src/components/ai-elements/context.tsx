// AI Elements' Context (elements.ai-sdk.dev registry): how full the model's context is. Here it is
// the view's size in bytes against VIEW, 128 KB (SPEC "Web UI", Memory). The token and cost rows
// (tokenlens, the AI SDK's usage type) are left out, and a popover replaces the hover card, which
// a phone can't open.
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import type { ComponentProps } from "react";
import { createContext, useContext, useMemo } from "react";

const PERCENT_MAX = 100;
const ICON_RADIUS = 10;
const ICON_VIEWBOX = 24;
const ICON_CENTER = 12;
const ICON_STROKE_WIDTH = 2;

type ContextValue = {
  usedBytes: number;
  maxBytes: number;
};

const ContextContext = createContext<ContextValue | null>(null);

const useContextValue = () => {
  const context = useContext(ContextContext);
  if (!context) throw new Error("Context components must be used within Context");
  return context;
};

const percent = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1, style: "percent" });
export const kb = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`;

export type ContextProps = ComponentProps<typeof Popover> & ContextValue;

export const Context = ({ usedBytes, maxBytes, ...props }: ContextProps) => {
  const value = useMemo(() => ({ maxBytes, usedBytes }), [maxBytes, usedBytes]);
  return (
    <ContextContext.Provider value={value}>
      <Popover {...props} />
    </ContextContext.Provider>
  );
};

export const ContextIcon = () => {
  const { usedBytes, maxBytes } = useContextValue();
  const circumference = 2 * Math.PI * ICON_RADIUS;
  const dashOffset = circumference * (1 - Math.min(1, usedBytes / maxBytes));
  return (
    <svg aria-label="View size" height="20" role="img" viewBox={`0 0 ${ICON_VIEWBOX} ${ICON_VIEWBOX}`} width="20">
      <circle cx={ICON_CENTER} cy={ICON_CENTER} fill="none" opacity="0.25" r={ICON_RADIUS} stroke="currentColor" strokeWidth={ICON_STROKE_WIDTH} />
      <circle
        cx={ICON_CENTER}
        cy={ICON_CENTER}
        fill="none"
        opacity="0.7"
        r={ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={ICON_STROKE_WIDTH}
        style={{ transform: "rotate(-90deg)", transformOrigin: "center" }}
      />
    </svg>
  );
};

export type ContextTriggerProps = ComponentProps<typeof Button>;

export const ContextTrigger = ({ children, ...props }: ContextTriggerProps) => {
  const { usedBytes, maxBytes } = useContextValue();
  return (
    <PopoverTrigger asChild>
      {children ?? (
        <Button type="button" variant="ghost" {...props}>
          <span className="font-medium text-muted-foreground">{percent.format(usedBytes / maxBytes)}</span>
          <ContextIcon />
        </Button>
      )}
    </PopoverTrigger>
  );
};

export type ContextContentProps = ComponentProps<typeof PopoverContent>;

export const ContextContent = ({ className, ...props }: ContextContentProps) => (
  <PopoverContent className={cn("min-w-60 divide-y overflow-hidden p-0", className)} {...props} />
);

export type ContextContentHeaderProps = ComponentProps<"div">;

export const ContextContentHeader = ({ children, className, ...props }: ContextContentHeaderProps) => {
  const { usedBytes, maxBytes } = useContextValue();
  return (
    <div className={cn("w-full space-y-2 p-3", className)} {...props}>
      {children ?? (
        <>
          <div className="flex items-center justify-between gap-3 text-xs">
            <p>{percent.format(usedBytes / maxBytes)}</p>
            <p className="font-mono text-muted-foreground">
              {kb(usedBytes)} / {kb(maxBytes)}
            </p>
          </div>
          <Progress className="bg-muted" value={Math.min(PERCENT_MAX, (usedBytes / maxBytes) * PERCENT_MAX)} />
        </>
      )}
    </div>
  );
};

export type ContextContentBodyProps = ComponentProps<"div">;

export const ContextContentBody = ({ children, className, ...props }: ContextContentBodyProps) => (
  <div className={cn("w-full p-3", className)} {...props}>
    {children}
  </div>
);
