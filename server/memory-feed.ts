// The live memory view (E47): every change to the view's lines, a message's line appended, lines a
// batch merged, a summary written into a line, goes to every client as one CUSTOM `memory` frame,
// numbered. The memory's listener is a plain callback that runs as the change is made, so the
// frame is published before anything the session says after it (the entry's `logged`), and a
// read of /api/memory/view at any moment names the change it is as of.
import type { SessionEvent } from "../src/session-events.ts";
import type { Mem } from "../src/tree.ts";
import { changesSince, memoryChange, shownOf } from "../src/memory-view.ts";

export type MemoryFeed = {
  // the number of the last change sent: a page read now is as of it
  readonly rev: () => number;
  readonly close: () => void;
};

// `start`: the first change's number less one. From this boot's clock, so a client that read a page
// from a server before a restart never takes the new one's changes for the next of its own.
export function watchMemory(mem: Mem, publish: (e: SessionEvent) => void, o: { readonly start?: number; readonly cap?: number } = {}): MemoryFeed {
  let rev = o.start ?? Date.now();
  let shown = shownOf(mem);
  const check = () => {
    const next = changesSince(mem, shown);
    shown = next.shown;
    if (next.hunks.length === 0) return;
    rev += 1;
    publish({ change: memoryChange(mem, rev, next.hunks, o.cap), type: "memory" });
  };
  mem.listeners.add(check);
  return {
    close: () => {
      mem.listeners.delete(check);
    },
    rev: () => rev,
  };
}
