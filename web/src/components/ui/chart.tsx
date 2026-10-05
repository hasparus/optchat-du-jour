// shadcn's Chart (ui.shadcn.com registry), for recharts: a container that turns a config into
// --color-<series> variables per theme, and tooltip and legend contents that read labels from it.
// Trimmed to what the Stats screen uses: a series' config is found by its name, and the payload
// guessing of the registry version (label keys inside data rows) is left out.
import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark";
const THEMES: readonly { readonly name: Theme; readonly selector: string }[] = [
  { name: "light", selector: "" },
  { name: "dark", selector: ".dark" },
];

const INITIAL_DIMENSION = { height: 200, width: 320 } as const;

export type ChartConfig = Record<
  string,
  {
    label?: React.ReactNode;
    icon?: React.ComponentType;
  } & ({ color?: string; theme?: never } | { color?: never; theme: Record<Theme, string> })
>;

const ChartContext = React.createContext<{ config: ChartConfig } | null>(null);

function useChart() {
  const context = React.useContext(ChartContext);
  if (!context) throw new Error("useChart must be used within a <ChartContainer />");
  return context;
}

function ChartContainer({
  id,
  className,
  children,
  config,
  initialDimension = INITIAL_DIMENSION,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
  initialDimension?: { width: number; height: number };
}) {
  const uniqueId = React.useId();
  const chartId = `chart-${id ?? uniqueId.replaceAll(":", "")}`;
  const value = React.useMemo(() => ({ config }), [config]);

  return (
    <ChartContext.Provider value={value}>
      <div
        className={cn(
          "flex aspect-video justify-center text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-surface]:outline-hidden",
          className,
        )}
        data-chart={chartId}
        data-slot="chart"
        {...props}
      >
        <ChartStyle config={config} id={chartId} />
        <RechartsPrimitive.ResponsiveContainer initialDimension={initialDimension}>{children}</RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
  const colored = Object.entries(config).filter(([, c]) => c.theme ?? c.color);
  if (colored.length === 0) return null;
  const css = THEMES.map(
    (t) =>
      `${t.selector} [data-chart=${id}] {\n${colored
        .map(([key, c]) => {
          const color = c.theme?.[t.name] ?? c.color;
          return color ? `  --color-${key}: ${color};` : "";
        })
        .join("\n")}\n}`,
  ).join("\n");
  // oxlint-disable-next-line react/no-danger -- CSS built from our own chart config, not from data
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
};

const ChartTooltip = RechartsPrimitive.Tooltip;

type Value = number | string | readonly (number | string)[];
type TooltipItem = { readonly name?: string | number; readonly value?: Value; readonly color?: string; readonly type?: string };

const shown = (value: Value) => (Number.isFinite(value) ? Number(value).toLocaleString() : String(value));

function ChartTooltipContent({
  active,
  payload,
  label,
  className,
  hideLabel = false,
  valueFormatter,
}: {
  active?: boolean;
  payload?: readonly TooltipItem[];
  label?: React.ReactNode;
  className?: string;
  hideLabel?: boolean;
  valueFormatter?: (value: number) => string;
}) {
  const { config } = useChart();
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className={cn("grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl", className)}>
      {!hideLabel && label !== undefined && <div className="font-medium">{label}</div>}
      <div className="grid gap-1.5">
        {payload
          .filter((item) => item.type !== "none")
          .map((item) => {
            const name = String(item.name ?? "value");
            return (
              <div className="flex w-full items-center gap-2" key={name}>
                <div className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
                <div className="flex flex-1 items-center justify-between gap-2 leading-none">
                  <span className="text-muted-foreground">{config[name]?.label ?? name}</span>
                  {item.value !== undefined && (
                    <span className="font-mono font-medium text-foreground tabular-nums">
                      {valueFormatter && Number.isFinite(item.value) ? valueFormatter(Number(item.value)) : shown(item.value)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}

const ChartLegend = RechartsPrimitive.Legend;

type LegendItem = { readonly value?: string | number; readonly color?: string; readonly type?: string };

function ChartLegendContent({ className, payload }: { className?: string; payload?: readonly LegendItem[] }) {
  const { config } = useChart();
  if (!payload || payload.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-center justify-center gap-x-4 gap-y-1 pt-3", className)}>
      {payload
        .filter((item) => item.type !== "none")
        .map((item) => {
          const name = String(item.value);
          return (
            <div className="flex items-center gap-1.5" key={name}>
              <div className="size-2 shrink-0 rounded-[2px]" style={{ backgroundColor: item.color }} />
              {config[name]?.label ?? name}
            </div>
          );
        })}
    </div>
  );
}

export { ChartContainer, ChartTooltip, ChartTooltipContent, ChartLegend, ChartLegendContent, ChartStyle };
