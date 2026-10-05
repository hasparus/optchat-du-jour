// What every compactor engine sends (SPEC "Compactor calls", gist §4.2–§4.3), whatever carries it:
// the context as <chat> and bare view lines cut at MARKS, the step under it, and the retry text
// for a line over NODE. Engine-neutral and pure; the engines add only their transport and marks.
import type { Job } from "../compactor.ts";
import { MARKS, NODE } from "../config.ts";
import { SCALE } from "../prompts.ts";
import { bytes } from "../tree.ts";
import { cutBlocks, flat } from "../view.ts";

// The context pieces: <chat>, the bare lines, </chat>, cut at the marks. No ids anywhere: shown
// `id+n|text`, the model starts copying the format (gist §4.2). Byte-stable from call to call.
export const contextBlocks = (job: Job, marks: readonly number[] = MARKS) => cutBlocks(["<chat>", ...job.ctx, "</chat>"].join("\n"), marks);

// what the gist's step block says above the message or the two lines (gist §4.2): the message
// whole with its newlines, the two lines written out again, flattened
export function step(job: Job): string {
  const scale = `For scale, this line is exactly ${NODE} bytes:\n${SCALE}\n\n`;
  if ("msg" in job) return `${scale}Compress this message into one line, in at most ${NODE} bytes:\n${job.msg.kind}: ${job.msg.text}`;
  return `${scale}Merge these two lines into one, in at most ${NODE} bytes:\n${flat(job.a)}\n${flat(job.b)}`;
}

// the first `limit` bytes of a line, never ending inside a UTF-8 character (gist §4.3)
export function cut(line: string, limit = NODE): string {
  const raw = Buffer.from(line, "utf8");
  if (raw.length <= limit) return line;
  let end = limit;
  while (end > 0 && ((raw[end] ?? 0) & 0b1100_0000) === 0b1000_0000) end--; // a continuation byte: back up to its start
  return raw.subarray(0, end).toString("utf8");
}

// the gist's retry message, word for word (gist §4.3)
export const retryText = (line: string) =>
  `That line is ${bytes(line)} bytes; the limit is ${NODE}. It must end where it is cut here:\n${cut(line)}| ← LIMIT`;

// done once the last try fits or the tries run out
export const enough = (tries: readonly string[], limit: number) => {
  const last = tries.at(-1);
  return last !== undefined && (bytes(last) <= NODE || tries.length >= limit);
};

// the node's text: the shortest try in bytes, the first of equals (gist §4.3)
export function shortest(tries: readonly string[]): string {
  let best = tries[0] ?? "";
  for (const t of tries) if (bytes(t) < bytes(best)) best = t;
  return best;
}
