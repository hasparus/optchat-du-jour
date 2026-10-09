// The Devices screen (SPEC "Web UI", Devices; "Multi-machine"): the machines a turn can run on, from
// the server's config, with their folders. Online state and `claude` versions come with the device
// runner (M4).
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { applyVariant, currentVariant, VARIANTS } from "@/lib/look";
import { useApi } from "@/lib/use-api";
import { useState } from "react";

// Which proposed design direction this page wears (UI audit): the same as ?variant=, for the
// installed app, which has no address bar. Kept in this browser only.
function Look() {
  const [variant, setVariant] = useState(currentVariant);
  return (
    <label className="flex items-center justify-between gap-3 text-sm" data-testid="look">
      <span>
        Look <span className="text-muted-foreground">(design proposal, this browser only)</span>
      </span>
      <select
        className="h-9 rounded-md border bg-background px-2 text-sm pointer-coarse:h-11"
        onChange={(e) => {
          const v = VARIANTS.find((x) => x.id === e.currentTarget.value)?.id ?? "";
          applyVariant(v);
          setVariant(v);
        }}
        value={variant}
      >
        {VARIANTS.map((v) => (
          <option key={v.id} value={v.id}>
            {v.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Devices() {
  const { data, error } = useApi(api.devices);
  if (error !== null) return <p className="p-4 text-sm text-destructive">{error}</p>;
  return (
    <div className="mx-auto w-full max-w-2xl space-y-3 p-4" data-testid="devices">
      <Look />
      {data?.map((d) => (
        <Card className="gap-2 py-4" key={d.name}>
          <CardHeader className="px-4">
            <CardTitle className="flex items-center gap-2 text-sm">
              {d.name}
              {d.local && <Badge variant="secondary">this server</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 px-4 text-xs text-muted-foreground">
            <div className="font-mono break-all">{d.url}</div>
            <ul>
              {d.folders.map((f) => (
                <li className="font-mono" key={f}>
                  {f}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
