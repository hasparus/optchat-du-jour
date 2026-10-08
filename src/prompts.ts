// The prompts: one system prompt for turns and compactions alike (docs/optchat.md §5, adapted:
// our name and log kinds, E23, and our devices), and the caption call's.
import { existsSync, readFileSync } from "node:fs";

const shipped = (file: string) => `${import.meta.dir}/../prompts/${file}`;
const contents = (path: string) => readFileSync(path, "utf8");
// a file the user may or may not have written: missing reads as empty
const contentsIfAny = (path: string) => (existsSync(path) ? contents(path) : "");

export const SYSTEM = contents(shipped("system.txt")).trimEnd(); // docs/optchat.md §5, adapted
export const CAPTION = contents(shipped("caption.txt")); // the caption call's system prompt (SPEC "Media")

// The one system prompt (docs/optchat.md §5): ours, then the user's own instructions.md, a blank
// line between. Nothing in it changes from call to call or between devices (no date, no working
// directory), so it is built once and every turn and compaction shares its cache entry.
export const systemPrompt = (home: string) => [SYSTEM, contentsIfAny(`${home}/instructions.md`)].join("\n\n");
