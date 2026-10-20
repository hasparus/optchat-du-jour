// Where each device's turns run (E7) and what tools an engine with its own loop gets there (M5).
// This machine's claude runs on its own Runner; another device's through that device's runner over
// the tailnet. A claude elsewhere reaches /mcp through `tailscale serve` at server.publicUrl (E8);
// without it, turns there are refused rather than handed the loopback URL and its key, which no
// other machine can use. Each device dials /mcp over a WebSocket until its claude is seen not to
// connect that way (E8).
import { Effect, Result } from "effect";
import { posix } from "node:path";
import { type ArtifactTools, noArtifacts } from "../src/artifacts/tools.ts";
import type { Runner } from "../src/claude/process.ts";
import { remoteRunner, remoteTool, remoteWorktrees } from "../src/claude/remote.ts";
import { type Settings, subagentSettings } from "../src/config.ts";
import { DeviceOffline } from "../src/engines/errors.ts";
import { type AgentTools, mcpConfig, mcpTransports, noAgents } from "../src/mcp.ts";
import { expandHome, realInside, within } from "../src/paths.ts";
import { toolBox, toolDefs } from "../src/tools/box.ts";
import { type FileTools, makeFileTools, toolError } from "../src/tools/files.ts";
import type { Mem } from "../src/tree.ts";
import type { Placement } from "../src/turn/claude-code.ts";
import type { AgentPlace } from "../src/subagents.ts";
import { localWorktrees, type Worktrees } from "../src/worktree.ts";

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
    const place = (name: string, cwd: string | undefined, base: string, runner: Runner["Service"], key = o.secret) =>
      Effect.sync(
        (): Placement => ({
          cwd,
          mcpConfig: mcpConfig(`${base.replace(/\/$/, "")}/mcp?key=${key}`, transports.of(name)),
          mcpSeen: (seen) => transports.seen(name, seen),
          runner,
        }),
      );
    const { publicUrl } = o.settings.server ?? {};
    const placements = new Map<string, Effect.Effect<Placement, DeviceOffline>>();
    // one Runner per other device, shared by its turns and its subagents (it remembers an unreachable device)
    const remotes = new Map(Object.entries(devices).flatMap(([name, d]) => (name === o.device ? [] : [[name, remoteRunner(name, d.url)] as const])));
    const unreachable: string[] = []; // devices whose claude could not reach /mcp
    for (const [name, d] of Object.entries(devices)) {
      const folder = d.folders[0];
      if (name === o.device) placements.set(name, place(name, folder === undefined ? undefined : expandHome(folder), `http://127.0.0.1:${o.port}`, o.local));
      else if (publicUrl === undefined) {
        unreachable.push(name);
        placements.set(name, Effect.fail(new DeviceOffline({ message: `${name}: server.publicUrl is not set, so claude there could not reach zoom and date` })));
      } else placements.set(name, place(name, folder, publicUrl, remotes.get(name) ?? remoteRunner(name, d.url))); // `~` is the device's home: it expands it
    }
    const runnerFor = (device: string) => placements.get(device) ?? Effect.fail(new DeviceOffline({ message: `${device} is not a configured device` }));
    // A subagent's claude (E36): where a master turn on its device runs, through the same Runner
    // (this machine's, or that device's runner over the tailnet, with its WhoIs and folder checks),
    // in the subagent's own folder, with its own /mcp key. Never warm: its spawn isn't pooled.
    const agentRunnerFor = (at: AgentPlace) => {
      if (at.device === o.device) return place(at.device, at.cwd, `http://127.0.0.1:${o.port}`, o.local, at.key);
      const runner = remotes.get(at.device);
      if (runner === undefined) return Effect.fail(new DeviceOffline({ message: `${at.device} is not a configured device` }));
      if (publicUrl === undefined) return Effect.fail(new DeviceOffline({ message: `${at.device}: server.publicUrl is not set, so claude there could not reach zoom and date` }));
      return place(at.device, at.cwd, publicUrl, runner, at.key);
    };
    // isolated subagents' worktrees (E37): this machine's in-process, another's through its runner
    const { disposable, worktrees: root } = subagentSettings(o.settings);
    const worktrees = new Map<string, Worktrees>(Object.entries(devices).map(([name, d]) => [name, name === o.device ? localWorktrees(expandHome(root), d.folders, disposable) : remoteWorktrees(name, d.url)] as const));
    // A folder a spawn asks for on a device (E36): one of its folders or inside one, or inside the
    // worktree root, as a turn's cwd must be. This machine's is resolved first (`~`, `..`,
    // symlinks); another's is checked as written, `~` against `~`, and its runner resolves it when
    // claude starts there and refuses it then if it is outside after all.
    const folderFor = (device: string, path: string): Result.Result<string, string> => {
      const d = devices[device];
      if (d === undefined) return Result.fail(`${device} is not a configured device`);
      const allowed = [...d.folders, root];
      const outside = Result.fail(`${path} is outside ${device}'s folders (${d.folders.join(", ")})`);
      if (device === o.device) {
        if (!posix.isAbsolute(expandHome(path))) return Result.fail(`${path} is not an absolute path`);
        const real = realInside(path, allowed);
        return real === null ? Result.fail(`${path} is outside ${device}'s folders (${d.folders.join(", ")}), or doesn't exist there`) : Result.succeed(real);
      }
      const written = posix.normalize(path);
      if (!posix.isAbsolute(written) && written !== "~" && !written.startsWith("~/")) return Result.fail(`${path} is not an absolute path`);
      const home = written.startsWith("~");
      const comparable = allowed.map((f) => posix.normalize(f)).filter((f) => f.startsWith("~") === home);
      return comparable.length === 0 || comparable.some((f) => within(written, f)) ? Result.succeed(written) : outside;
    };

    // the read-only tools: this machine's in-process, another device's over its runner's POST
    // /tool, zoom and date from memory; the worktree root reads as one more folder (an isolated
    // subagent on our own tool loop reads its worktree), though the tools' text names the folders only
    const localFiles = yield* makeFileTools([...(devices[o.device]?.folders ?? []), expandHome(root)]);
    const files = new Map<string, FileTools>(Object.entries(devices).map(([name, d]) => [name, name === o.device ? localFiles : remoteTool(name, d.url)] as const));
    // `agents`: spawn, tell and zoom("Name") as the caller may use them (SPEC M7a); `artifacts`, the
    // artifact tools likewise (SPEC "Artifacts")
    const toolsFor = (device: string, mem: Mem, agents: AgentTools = noAgents, artifacts: ArtifactTools = noArtifacts) =>
      toolBox({
        agents,
        artifacts,
        device,
        files: files.get(device) ?? ((name) => Effect.succeed(toolError(`Error: ${device} is not a configured device, so ${name} can't run`))),
        folders: devices[device]?.folders ?? [],
        mem,
      });
    // what a turn on `device` is offered, which a compaction is offered too (docs/optchat.md §4)
    const defsFor = (device: string) => toolDefs({ device, folders: devices[device]?.folders ?? [] });
    return { agentRunnerFor, defsFor, folderFor, runnerFor, toolsFor, unreachable, worktrees };
  });
