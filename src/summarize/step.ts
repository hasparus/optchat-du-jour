// What every compactor engine sends (SPEC "Compactor calls", gist §4.2–§4.3), whatever carries it:
// the context as <chat> and bare view lines cut at MARKS, the step under it, and the retry text
// for a line over NODE. Engine-neutral and pure.
import type { Job } from "../compactor.ts";
import { MARKS, NODE } from "../config.ts";
import { SCALE } from "../prompts.ts";
import { bytes, msgText } from "../tree.ts";
import { cutBlocks, flat } from "../view.ts";

// No ids anywhere: shown `id+n|text`, the model starts copying the format (gist §4.2).
export const contextBlocks = (job: Job, marks: readonly number[] = MARKS) =>
  cutBlocks(`<chat>\n${job.ctx.map((line) => `${line}\n`).join("")}</chat>`, marks);

// the message goes whole, newlines kept; the two lines to merge are written out again, flattened
export const stepText = (job: Job) => {
  const task =
    "msg" in job
      ? `Compress this message into one line, in at most ${NODE} bytes:\n${msgText(job.msg)}`
      : `Merge these two lines into one, in at most ${NODE} bytes:\n${flat(job.a)}\n${flat(job.b)}`;
  return `For scale, this line is exactly ${NODE} bytes:\n${SCALE}\n\n${task}`;
};

// the first NODE bytes of a line, without half a UTF-8 character at the end
export const cutAtLimit = (line: string) => Buffer.from(line).subarray(0, NODE).toString("utf8").replace(/�$/, "");

export const retryText = (line: string) =>
  `That line is ${bytes(line)} bytes; the limit is ${NODE}. It must end where it is cut here:\n${cutAtLimit(line)}| ← LIMIT`;

// done once a try fits or the tries run out
export const enough = (tries: readonly string[], limit: number) => {
  const last = tries.at(-1);
  return last !== undefined && (bytes(last) <= NODE || tries.length >= limit);
};

// the node's text: the shortest try, the earliest of equals (gist §4.3)
export const shortest = (tries: readonly [string, ...string[]]) => {
  let best = tries[0];
  for (const t of tries) if (bytes(t) < bytes(best)) best = t;
  return best;
};
