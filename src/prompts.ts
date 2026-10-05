// The prompts (gist §4.4, §7.2 with ref D5 and D10) and SCALE, our own line of exactly NODE bytes.
import { Effect } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const shipped = (file: string) => `${import.meta.dir}/../prompts/${file}`;
const contents = (path: string) => readFileSync(path, "utf8");
// a file the user may or may not have written: missing reads as empty
const contentsIfAny = (path: string) => (existsSync(path) ? contents(path) : "");

export const COMPACT_FILE = shipped("compact.txt");
export const CAPTION_FILE = shipped("caption.txt"); // the caption call's system prompt (SPEC "Media")
export const CAPTION = contents(CAPTION_FILE);
export const SCALE = contents(shipped("scale.txt"));

// The master's system prompt (gist §7.2): our two shipped prompts, then the user's own
// instructions.md, blank lines between. Nothing in it changes from turn to turn or between devices
// (no date, no working directory), so it is written once and every call shares its cache entry.
export const systemPrompt = (home: string) =>
  [contents(shipped("master.txt")), contents(shipped("view_doc.txt")), contentsIfAny(`${home}/instructions.md`)].join("\n\n");

// the text as a file for --system-prompt-file, removed with the scope
export const promptFile = (text: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = mkdtempSync(join(tmpdir(), "optchat-system-"));
      writeFileSync(`${dir}/system.txt`, text);
      return { dir, path: `${dir}/system.txt` };
    }),
    ({ dir }) =>
      Effect.sync(() => {
        rmSync(dir, { force: true, recursive: true });
      }),
  ).pipe(Effect.map(({ path }) => path));
