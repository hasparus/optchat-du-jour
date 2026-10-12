// The Devices screen (SPEC "Web UI", Devices; "Multi-machine"): the machines a turn can run on, from
// the server's config, with their folders. Online state and `claude` versions come with the device
// runner (M4).
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { FolderIcon, LaptopIcon } from "lucide-react";

export function Devices() {
  const { data, error } = useApi(api.devices);
  if (error !== null) return <p className="p-6 text-ui text-destructive">{error}</p>;
  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6" data-testid="devices">
      <h1 className="text-base font-semibold tracking-tight">Devices</h1>
      <p className="mt-1 text-ui text-muted-foreground">Where a turn can run, and the folders it may work in.</p>
      <ul className="mt-5 divide-y overflow-hidden rounded-xl border bg-raised">
        {data?.map((d) => (
          <li className="flex gap-3 px-4 py-3.5" key={d.name}>
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <LaptopIcon className="size-4" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-ui font-semibold">{d.name}</span>
                {d.local && <span className="rounded-full bg-signal/10 px-2 py-0.5 text-2xs font-medium text-signal">this server</span>}
              </div>
              <div className="font-mono text-xs break-all text-muted-foreground">{d.url}</div>
              <ul className="space-y-0.5 pt-1">
                {d.folders.map((f) => (
                  <li className="flex items-center gap-1.5 font-mono text-xs text-foreground/80" key={f}>
                    <FolderIcon aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
                    <span className="break-all">{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
