// Where the data lives (SPEC "System shape"): one data dir per writer under streams/ (E3).
// OPTCHAT_DIR names a stream dir directly, as it does for the reference's CLI
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = Bun.env.OPTCHAT_HOME ?? join(homedir(), ".optchat");
export const streamDir = (device: string) => Bun.env.OPTCHAT_DIR ?? `${HOME}/streams/${device}`;

// a configured folder ("~/repos") on this machine
export const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, homedir());

// `path` is the folder `root` or inside it, both as written (resolve them first to compare real paths)
export const within = (path: string, root: string) => path === root || path.startsWith(`${root.replace(/\/$/, "")}/`);

// `path`'s real path (`~`, `..` and symlinks resolved) when it is one of `folders` (resolved too) or
// inside one; null when it is outside them all, or doesn't exist on this machine
export const realInside = (path: string, folders: readonly string[]): string | null => {
  let real: string;
  try {
    real = realpathSync(expandHome(path));
  } catch {
    return null;
  }
  for (const f of folders) {
    try {
      if (within(real, realpathSync(expandHome(f)))) return real;
    } catch {
      // a folder that doesn't exist here holds nothing
    }
  }
  return null;
};
