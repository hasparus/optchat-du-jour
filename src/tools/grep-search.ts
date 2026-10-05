// What Grep does with the files it was handed, as a plain function of its job: read each file,
// test every line against the pattern, collect the lines to show. The pattern is the model's, and
// a JavaScript regex can backtrack without end (`(a+)+$` on a line of a's ending in b), so this
// never runs in the server's own thread: grep-worker.ts runs it in a Worker that files.ts
// terminates at the timeout.
import { readFileSync, statSync } from "node:fs";
import { headOf } from "../text.ts";

export type GrepJob = {
  readonly files: readonly string[]; // already confined to the device's folders
  readonly pattern: string;
  readonly ignoreCase: boolean;
  readonly mode: "files_with_matches" | "content" | "count";
  readonly maxBytes: number; // a bigger file is skipped
  readonly lineChars: number; // a longer line is cut
  readonly outputChars: number; // stop once this much output is collected
};

export const binary = (text: string) => text.slice(0, 8000).includes("\u0000");

export const searchFiles = (job: GrepJob): string[] => {
  const regex = new RegExp(job.pattern, job.ignoreCase ? "i" : "");
  const out: string[] = [];
  let size = 0;
  for (const file of job.files) {
    if (size > job.outputChars) break;
    let text = "";
    try {
      if (statSync(file).size <= job.maxBytes) text = readFileSync(file, "utf8");
    } catch {
      continue; // gone, unreadable: no match
    }
    if (text === "" || binary(text)) continue;
    // a file that ends with a newline has no line after it, even for a pattern that matches ""
    const hits = text.replace(/\n$/, "").split("\n").flatMap((line, k) => (regex.test(line) ? [`${file}:${k + 1}:${line.length > job.lineChars ? `${headOf(line, job.lineChars)}[…]` : line}`] : []));
    if (hits.length === 0) continue;
    const lines = job.mode === "content" ? hits : [job.mode === "count" ? `${file}:${hits.length}` : file];
    out.push(...lines);
    size += lines.reduce((n, l) => n + l.length + 1, 0);
  }
  return out;
};
