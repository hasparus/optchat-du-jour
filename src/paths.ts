// Where the data lives (SPEC "System shape"): one data dir per writer under streams/ (E3).
// OPTCHAT_DIR names a stream dir directly, as it does for the reference's CLI
import { Result } from "effect";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const HOME = Bun.env.OPTCHAT_HOME ?? join(homedir(), ".optchat");
export const streamDir = (device: string) => Bun.env.OPTCHAT_DIR ?? `${HOME}/streams/${device}`;

// a configured folder ("~/repos") on this machine
export const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, homedir());

// `path` is the folder `root` or inside it, both as written (resolve them first to compare real paths)
export const within = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);

// The one rule for a path on this machine (a tool's, a spawn's cwd, a repository to isolate):
// `path`'s real path (`~`, `..` and symlinks resolved) when it is absolute and one of `folders`
// (resolved too) or inside one; else why not
export const realInside = (path: string, folders: readonly string[]): Result.Result<string, string> => {
  const expanded = expandHome(path);
  if (!isAbsolute(expanded)) return Result.fail(`${path} is not an absolute path`);
  let real: string;
  try {
    real = realpathSync(expanded);
  } catch {
    return Result.fail(`${path} does not exist on this device`);
  }
  for (const f of folders) {
    try {
      if (within(real, realpathSync(expandHome(f)))) return Result.succeed(real);
    } catch {
      // a folder that doesn't exist here holds nothing
    }
  }
  return Result.fail(`${path} is outside this device's folders`);
};
