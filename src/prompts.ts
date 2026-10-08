// The prompts (the gist's earlier revision with ref D5 and D10: SPEC E24) and SCALE, our own
// line of exactly NODE bytes.
import { existsSync, readFileSync } from "node:fs";

const shipped = (file: string) => `${import.meta.dir}/../prompts/${file}`;
const contents = (path: string) => readFileSync(path, "utf8");
// a file the user may or may not have written: missing reads as empty
const contentsIfAny = (path: string) => (existsSync(path) ? contents(path) : "");

export const COMPACT = contents(shipped("compact.txt")); // the compactors' system prompt
export const CAPTION = contents(shipped("caption.txt")); // the caption call's system prompt (SPEC "Media")
export const SCALE = contents(shipped("scale.txt"));

// The master's system prompt (docs/optchat.md §5, our earlier text: E24): our two shipped prompts, then the user's own
// instructions.md, blank lines between. Nothing in it changes from turn to turn or between devices
// (no date, no working directory), so it is written once and every call shares its cache entry.
export const systemPrompt = (home: string) =>
  [contents(shipped("master.txt")), contents(shipped("view_doc.txt")), contentsIfAny(`${home}/instructions.md`)].join("\n\n");
