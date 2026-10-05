// Which devices answer and which claude they run (SPEC "Web UI", Devices; GET /api/devices).
// Devices on different claude versions don't share the prompt cache: a turn that moves between
// them misses it once (ref §16.8), so the server says so, once per set of versions.
import { Effect } from "effect";
import type { Settings } from "../src/config.ts";
import { deviceHealth } from "../src/claude/remote.ts";

export type DeviceStatus = {
  readonly name: string;
  readonly url: string;
  readonly folders: readonly string[];
  readonly local: boolean; // the server's own machine, whose turns use the local runner
  // `refused`: the runner is up but answered 403, so its list of callers or this node's name is wrong
  readonly status: "online" | "offline" | "refused";
  readonly claudeVersion: string | null;
};

const HEALTH_TIMEOUT = "2 seconds";

// every configured device, asked at once; this machine's version comes from `localVersion`
export const deviceStatuses = <R>(o: {
  readonly devices: Settings["devices"];
  readonly self: string;
  readonly localVersion: Effect.Effect<string | null, never, R>;
}): Effect.Effect<DeviceStatus[], never, R> =>
  Effect.forEach(
    Object.entries(o.devices),
    ([name, d]) =>
      Effect.gen(function* () {
        const base = { folders: d.folders, local: name === o.self, name, url: d.url };
        if (name === o.self) return { ...base, claudeVersion: yield* o.localVersion, status: "online" } as const;
        const h = yield* deviceHealth(d.url, HEALTH_TIMEOUT);
        return h._tag === "online"
          ? ({ ...base, claudeVersion: h.health.claudeVersion, status: "online" } as const)
          : { ...base, claudeVersion: null, status: h._tag };
      }),
    { concurrency: "unbounded" },
  );

// The warning to give when the online devices run different claude versions, with the key that
// says whether it was given already: the set of versions, so a device going offline and coming
// back doesn't repeat it, and only a new version does.
export const versionWarning = (list: readonly DeviceStatus[]): { readonly key: string; readonly message: string } | null => {
  const online = list.filter((d) => d.status === "online" && d.claudeVersion !== null);
  const versions = [...new Set(online.map((d) => d.claudeVersion ?? ""))].toSorted((a, b) => a.localeCompare(b));
  if (versions.length < 2) return null;
  const who = online.map((d) => `${d.name} ${d.claudeVersion}`).join(", ");
  return { key: versions.join("\n"), message: `devices run different claude versions (${who}): a turn that moves between them misses the cache once` };
};
