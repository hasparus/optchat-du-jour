// The Stats screen (SPEC "Web UI", Stats; E11), from usage.jsonl: calls, tokens, cache hit rate and
// cold versus warm turns per day or week, split by role or engine, calls per model and effort, and
// the failovers. This
// replaces `optchat stats`. Charts are shadcn's (recharts); every one has a legend or a title for
// its one series, and the numbers are in the table below them too.
import { Segmented, SegmentedButton } from "@/components/ui/segmented";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { api } from "@/lib/api";
import { type Bucket, buckets, byModel, ENGINES, type Period, ranOn, ROLES, type Split, total, totals } from "@/lib/stats";
import { useApi } from "@/lib/use-api";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { type ReactNode, useState } from "react";

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

const seriesConfig = (names: readonly string[]): ChartConfig =>
  Object.fromEntries(names.map((n, k) => [n, { color: `var(--chart-${k + 1})`, label: n }]));

const coldConfig: ChartConfig = {
  cold: { color: "var(--chart-2)", label: "cold" },
  warm: { color: "var(--chart-1)", label: "warm" },
};
const hitConfig: ChartConfig = { hitRate: { color: "var(--chart-1)", label: "hit rate" } };

// one figure of the summary strip: the number, then what it counts
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-4 py-3">
      <div className="text-xl font-semibold tracking-tight tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function Toggle<A extends string>({ value, options, onChange, label }: { value: A; options: readonly A[]; onChange: (a: A) => void; label: string }) {
  return (
    <Segmented aria-label={label}>
      {options.map((o) => (
        <SegmentedButton
          key={o}
          onClick={() => {
            onChange(o);
          }}
          pressed={o === value}
        >
          {o}
        </SegmentedButton>
      ))}
    </Segmented>
  );
}

function Stacked({ title, data, field, names }: { title: string; data: readonly Bucket[]; field: "calls" | "tokens"; names: readonly string[] }) {
  return (
    <ChartSection title={title}>
      <ChartContainer className="aspect-auto h-48 w-full" config={seriesConfig(names)}>
        <BarChart data={[...data]}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="period" tickLine={false} />
          <YAxis allowDecimals={field === "tokens"} tickFormatter={(v: number) => compact.format(v)} tickLine={false} width={36} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ChartLegend content={<ChartLegendContent />} />
          {names.map((n) => (
            <Bar dataKey={`${field}.${n}`} fill={`var(--color-${n})`} key={n} name={n} radius={2} stackId="a" stroke="var(--background)" strokeWidth={2} />
          ))}
        </BarChart>
      </ChartContainer>
    </ChartSection>
  );
}

// a chart under its title, on the sheet: a hairline above, no card around it
function ChartSection({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="border-t pt-4">
      <h2 className="mb-3 text-ui font-medium">{title}</h2>
      <div className="-mx-2">{children}</div>
    </section>
  );
}

export function Stats() {
  const { data, error } = useApi(api.usage);
  const [period, setPeriod] = useState<Period>("day");
  const [split, setSplit] = useState<Split>("role");

  if (error !== null) return <p className="p-6 text-ui text-destructive">{error}</p>;
  if (data === null) return <p className="p-6 text-ui text-muted-foreground">Loading…</p>;

  const all = totals(data);
  const rows = buckets(data, period, split);
  const names = split === "role" ? ROLES : ENGINES;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-5 px-4 py-6 sm:px-6" data-testid="stats">
      <div>
        <h1 className="text-base font-semibold tracking-tight">Stats</h1>
        <p className="mt-1 text-ui text-muted-foreground">Every model call, from usage.jsonl.</p>
      </div>
      <div className="grid grid-cols-2 overflow-hidden rounded-xl border bg-raised sm:grid-cols-4 *:border-border max-sm:[&>*:nth-child(-n+2)]:border-b sm:[&>*+*]:border-l max-sm:[&>*:nth-child(even)]:border-l">
        <Figure label="calls" value={compact.format(all.calls)} />
        <Figure label="tokens" value={compact.format(all.tokens)} />
        <Figure label="cache hit rate" value={pct(all.hitRate)} />
        <Figure label="cold turns" value={`${all.coldTurns} / ${all.turns}`} />
      </div>
      {all.dollars > 0 && <p className="text-ui">API-key spend: ${all.dollars.toFixed(2)}</p>}
      <div className="flex flex-wrap gap-2">
        <Toggle label="Period" onChange={setPeriod} options={["day", "week"] as const} value={period} />
        <Toggle label="Split" onChange={setSplit} options={["role", "engine"] as const} value={split} />
      </div>
      {data.length === 0 ? (
        <p className="text-ui text-muted-foreground">No model calls yet.</p>
      ) : (
        <>
          <Stacked data={rows} field="calls" names={names} title={`Calls per ${period}, by ${split}`} />
          <Stacked data={rows} field="tokens" names={names} title={`Tokens per ${period}, by ${split}`} />
          <ChartSection title={`Cache hit rate per ${period}`}>
            <ChartContainer className="aspect-auto h-40 w-full" config={hitConfig}>
              <LineChart data={rows.map((r) => ({ hitRate: r.hitRate, period: r.period }))}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="period" tickLine={false} />
                <YAxis domain={[0, 1]} tickFormatter={(v: number) => pct(v)} tickLine={false} width={36} />
                <ChartTooltip content={<ChartTooltipContent valueFormatter={pct} />} />
                <Line dataKey="hitRate" dot={{ r: 3, strokeWidth: 0, fill: "var(--color-hitRate)" }} stroke="var(--color-hitRate)" strokeWidth={2} type="monotone" />
              </LineChart>
            </ChartContainer>
          </ChartSection>
          <ChartSection title={`Cold and warm turns per ${period}`}>
            <ChartContainer className="aspect-auto h-40 w-full" config={coldConfig}>
              <BarChart data={rows.map((r) => ({ cold: r.cold, period: r.period, warm: r.warm }))}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="period" tickLine={false} />
                <YAxis allowDecimals={false} tickLine={false} width={36} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="warm" fill="var(--color-warm)" radius={2} stackId="t" stroke="var(--background)" strokeWidth={2} />
                <Bar dataKey="cold" fill="var(--color-cold)" radius={2} stackId="t" stroke="var(--background)" strokeWidth={2} />
              </BarChart>
            </ChartContainer>
          </ChartSection>
          <table className="w-full text-ui tabular-nums [&_td]:border-t [&_td]:py-1.5 [&_th]:pb-1.5">
            <caption className="border-t pt-4 pb-3 text-left font-medium">Per {period}</caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="font-normal">{period}</th>
                <th className="text-right font-normal">calls</th>
                <th className="text-right font-normal">tokens</th>
                <th className="text-right font-normal">hit</th>
                <th className="text-right font-normal">cold/warm</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.period}>
                  <td>{r.period}</td>
                  <td className="text-right">{total(r.calls)}</td>
                  <td className="text-right">{compact.format(total(r.tokens))}</td>
                  <td className="text-right">{pct(r.hitRate)}</td>
                  <td className="text-right">
                    {r.cold}/{r.warm}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <table className="w-full text-ui tabular-nums [&_td]:border-t [&_td]:py-1.5 [&_th]:pb-1.5" data-testid="by-model">
            <caption className="border-t pt-4 pb-3 text-left font-medium">By model and effort</caption>
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="font-normal">model</th>
                <th className="text-right font-normal">calls</th>
                <th className="text-right font-normal">tokens</th>
                <th className="text-right font-normal">hit</th>
              </tr>
            </thead>
            <tbody>
              {byModel(data).map((m) => (
                <tr key={m.name}>
                  <td className="font-mono text-xs break-all">{m.name}</td>
                  <td className="text-right">{m.calls}</td>
                  <td className="text-right">{compact.format(m.tokens)}</td>
                  <td className="text-right">{pct(m.hitRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <section className="space-y-1 border-t pt-4">
        <h2 className="text-ui font-medium">Engine changes</h2>
        <p className="text-xs text-muted-foreground">Compactor and caption failovers, and turns taken up by the engine picked after a stop.</p>
        {all.failovers.length === 0 ? (
          <p className="pt-1 text-ui text-muted-foreground">None.</p>
        ) : (
          <ul className="space-y-0.5 pt-1 font-mono text-xs">
            {all.failovers.map((r) => (
              <li key={`${r.date}:${r.role}:${r.engine}`}>
                {r.date.slice(0, 16).replace("T", " ")} · {r.role}: {r.failoverFrom} → {ranOn(r)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
