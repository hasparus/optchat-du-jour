// The prompts (gist §4.4, §7.2 with ref D5 and D10) and SCALE, our own line of exactly NODE bytes.
import { Effect } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

export const PROMPTS = new URL("../prompts/", import.meta.url).pathname;
const read = (name: string) => readFileSync(`${PROMPTS}${name}`, "utf8");

export const COMPACT_FILE = `${PROMPTS}compact.txt`;
export const SCALE = read("scale.txt");

// MASTER + VIEW_DOC + the user's instructions, byte-identical for the life of the server and on
// every device (gist §7.2): no dates, no cwd, nothing per turn
export const systemPrompt = (home: string) => {
  const mine = existsSync(`${home}/instructions.md`) ? readFileSync(`${home}/instructions.md`, "utf8") : "";
  return `${read("master.txt")}\n\n${read("view_doc.txt")}\n\n${mine}`;
};

// the text as a file for --system-prompt-file, removed with the scope
export const promptFile = (text: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const dir = mkdtempSync(`${tmpdir()}/optchat-`);
      writeFileSync(`${dir}/system.txt`, text);
      return { dir, path: `${dir}/system.txt` };
    }),
    ({ dir }) => Effect.sync(() => rmSync(dir, { force: true, recursive: true })),
  ).pipe(Effect.map(({ path }) => path));
