// Where the data lives (SPEC "System shape"): one data dir per writer under streams/ (E3).
// OPTCHAT_DIR names a stream dir directly, as it does for the reference's CLI
import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = Bun.env.OPTCHAT_HOME ?? join(homedir(), ".optchat");
export const streamDir = (device: string) => Bun.env.OPTCHAT_DIR ?? `${HOME}/streams/${device}`;

// a configured folder ("~/repos") on this machine
export const expandHome = (path: string) => path.replace(/^~(?=\/|$)/, homedir());
