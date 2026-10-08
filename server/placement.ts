// Where each device's turns run (E7) and what tools an engine with its own loop gets there (M5).
// This machine's claude runs on its own Runner; another device's through that device's runner over
// the tailnet. A claude elsewhere reaches /mcp through `tailscale serve` at server.publicUrl (E8);
// without it, turns there are refused rather than handed the loopback URL and its key, which no
// other machine can use. Each device dials /mcp over a WebSocket until its claude is seen not to
// connect that way (E8).
import { Effect } from "effect";
import type { Runner } from "../src/claude/process.ts";
import { remoteRunner, remoteTool } from "../src/claude/remote.ts";
import type { Settings } from "../src/config.ts";
import { DeviceOffline } from "../src/engines/errors.ts";
import { mcpConfig, mcpTransports } from "../src/mcp.ts";
import { expandHome } from "../src/paths.ts";
import { toolBox, toolDefs } from "../src/tools/box.ts";
import { type FileTools, makeFileTools } from "../src/tools/files.ts";
import type { Mem } from "../src/tree.ts";
import type { Placement } from "../src/turn/claude-code.ts";

export const makePlacements = (o: {
  readonly settings: Settings;
  readonly device: string; // this machine
  readonly port: number; // the server's, for this machine's claude to reach /mcp
  readonly secret: string; // /mcp's key
  readonly local: Runner["Service"];
  readonly report: (message: string) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const { devices } = o.settings;
    const transports = mcpTransports(o.settings.server?.mcpTransport ?? "ws", o.report);
    const place = (name: string, cwd: string | undefined, base: string, runner: Runner["Service"]) =>
      Effect.sync(
        (): Placement => ({
          cwd,
          mcpConfig: mcpConfig(`${base.replace(/\/$/, "")}/mcp?key=${o.secret}`, transports.of(name)),
          mcpSeen: (seen) => transports.seen(name, seen),
          runner,
        }),
      );
    const { publicUrl } = o.settings.server ?? {};
    const placements = new Map<string, Effect.Effect<Placement, DeviceOffline>>();
    const unreachable: string[] = []; // devices whose claude could not reach /mcp
    for (const [name, d] of Object.entries(devices)) {
      const folder = d.folders[0];
      if (name === o.device) placements.set(name, place(name, folder === undefined ? undefined : expandHome(folder), `http://127.0.0.1:${o.port}`, o.local));
      else if (publicUrl === undefined) {
        unreachable.push(name);
        placements.set(name, Effect.fail(new DeviceOffline({ message: `${name}: server.publicUrl is not set, so claude there could not reach zoom and date` })));
      } else placements.set(name, place(name, folder, publicUrl, remoteRunner(name, d.url))); // `~` is the device's home: it expands it
    }
    const runnerFor = (device: string) => placements.get(device) ?? Effect.fail(new DeviceOffline({ message: `${device} is not a configured device` }));

    // the read-only tools: this machine's in-process, another device's over its runner's POST
    // /tool, zoom and date from memory
    const localFiles = yield* makeFileTools(devices[o.device]?.folders ?? []);
    const files = new Map<string, FileTools>(Object.entries(devices).map(([name, d]) => [name, name === o.device ? localFiles : remoteTool(name, d.url)] as const));
    const toolsFor = (device: string, mem: Mem) =>
      toolBox({
        device,
        files: files.get(device) ?? ((name) => Effect.succeed(`Error: ${device} is not a configured device, so ${name} can't run`)),
        folders: devices[device]?.folders ?? [],
        mem,
      });
    // what a turn on `device` is offered, which a compaction is offered too (docs/optchat.md §4)
    const defsFor = (device: string) => toolDefs({ device, folders: devices[device]?.folders ?? [] });
    return { defsFor, runnerFor, toolsFor, unreachable };
  });
