// The Stats screen (SPEC "Web UI", Stats; E11), from usage.jsonl: calls, tokens, cache hit rate and
// cold versus warm turns per day or week, split by role or engine, calls per model and effort, and
// the failovers. This
// replaces `optchat stats`. Charts are shadcn's (recharts); every one has a legend or a title for
// its one series, and the numbers are in the table below them too.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { api } from "@/lib/api";
import { type Bucket, buckets, byModel, ENGINES, type Period, ranOn, ROLES, type Split, total, totals } from "@/lib/stats";
import { useApi } from "@/lib/use-api";
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { useState } from "react";

const compact = new Intl.NumberFormat("en-US", { notation: "compact" });
const pct = (x: number | null) => (x === null ? "–" : `${Math.round(x * 100)}%`);

const seriesConfig = (names: readonly string[]): ChartConfig =>
  Object.fromEntries(names.map((n, k) => [n, { color: `var(--chart-${k + 1})`, label: n }]));

const coldConfig: ChartConfig = {
  cold: { color: "var(--chart-2)", label: "cold" },
  warm: { color: "var(--chart-1)", label: "warm" },
};
const hitConfig: ChartConfig = { hitRate: { color: "var(--chart-1)", label: "hit rate" } };

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xl font-semibold">{value}</div>
    </div>
  );
}

function Toggle<A extends string>({ value, options, onChange, label }: { value: A; options: readonly A[]; onChange: (a: A) => void; label: string }) {
  return (
    <div aria-label={label} className="inline-flex rounded-md border p-0.5" role="group">
      {options.map((o) => (
        <Button
          aria-pressed={o === value}
          key={o}
          onClick={() => {
            onChange(o);
          }}
          size="xs"
          variant={o === value ? "secondary" : "ghost"}
        >
          {o}
        </Button>
      ))}
    </div>
  );
}

function Stacked({ title, data, field, names }: { title: string; data: readonly Bucket[]; field: "calls" | "tokens"; names: readonly string[] }) {
  return (
    <Card className="gap-2 py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="px-2">
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
      </CardContent>
    </Card>
  );
}

export function Stats() {
  const { data, error } = useApi(api.usage);
  const [period, setPeriod] = useState<Period>("day");
  const [split, setSplit] = useState<Split>("role");

  if (error !== null) return <p className="p-4 text-sm text-destructive">{error}</p>;
  if (data === null) return <p className="p-4 text-sm text-muted-foreground">loading…</p>;

  const all = totals(data);
  const rows = buckets(data, period, split);
  const names = split === "role" ? ROLES : ENGINES;

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 p-4" data-testid="stats">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="calls" value={compact.format(all.calls)} />
        <Tile label="tokens" value={compact.format(all.tokens)} />
        <Tile label="cache hit rate" value={pct(all.hitRate)} />
        <Tile label="cold turns" value={`${all.coldTurns} / ${all.turns}`} />
      </div>
      {all.dollars > 0 && <p className="text-sm">API-key spend: ${all.dollars.toFixed(2)}</p>}
      <div className="flex flex-wrap gap-2">
        <Toggle label="Period" onChange={setPeriod} options={["day", "week"] as const} value={period} />
        <Toggle label="Split" onChange={setSplit} options={["role", "engine"] as const} value={split} />
      </div>
      {data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No model calls yet.</p>
      ) : (
        <>
          <Stacked data={rows} field="calls" names={names} title={`Calls per ${period}, by ${split}`} />
          <Stacked data={rows} field="tokens" names={names} title={`Tokens per ${period}, by ${split}`} />
          <Card className="gap-2 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">Cache hit rate per {period}</CardTitle>
            </CardHeader>
            <CardContent className="px-2">
              <ChartContainer className="aspect-auto h-40 w-full" config={hitConfig}>
                <LineChart data={rows.map((r) => ({ hitRate: r.hitRate, period: r.period }))}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="period" tickLine={false} />
                  <YAxis domain={[0, 1]} tickFormatter={(v: number) => pct(v)} tickLine={false} width={36} />
                  <ChartTooltip content={<ChartTooltipContent valueFormatter={pct} />} />
                  <Line dataKey="hitRate" dot={{ r: 4 }} stroke="var(--color-hitRate)" strokeWidth={2} type="monotone" />
                </LineChart>
              </ChartContainer>
            </CardContent>
          </Card>
          <Card className="gap-2 py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">Cold and warm turns per {period}</CardTitle>
            </CardHeader>
            <CardContent className="px-2">
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
            </CardContent>
          </Card>
          <table className="w-full text-xs tabular-nums">
            <caption className="py-1 text-left text-muted-foreground">Per {period}</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
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
          <table className="w-full text-xs tabular-nums" data-testid="by-model">
            <caption className="py-1 text-left text-muted-foreground">By model and effort</caption>
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="font-normal">model</th>
                <th className="text-right font-normal">calls</th>
                <th className="text-right font-normal">tokens</th>
                <th className="text-right font-normal">hit</th>
              </tr>
            </thead>
            <tbody>
              {byModel(data).map((m) => (
                <tr key={m.name}>
                  <td className="break-all">{m.name}</td>
                  <td className="text-right">{m.calls}</td>
                  <td className="text-right">{compact.format(m.tokens)}</td>
                  <td className="text-right">{pct(m.hitRate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <section className="space-y-1">
        <h2 className="text-sm font-medium">Engine changes</h2>
        <p className="text-xs text-muted-foreground">Compactor and caption failovers, and turns taken up by the engine picked after a stop.</p>
        {all.failovers.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <ul className="text-xs">
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
