// The live memory view (E47): every change to the view's lines, a message's line appended, lines a
// batch merged, a summary written into a line, goes to every client as one CUSTOM `memory` frame,
// numbered. The memory's listener is a plain callback that runs as the change is made, so the
// frame is published before anything the session says after it (the entry's `logged`), and a
// read of /api/memory/view at any moment names the change it is as of.
import type { SessionEvent } from "../src/session-events.ts";
import type { Mem } from "../src/tree.ts";
import { changesSince, type Counted, memoryChange, shownOf } from "../src/memory-view.ts";

export type MemoryFeed = {
  // the server's run and the number of the last change sent: a page read now is as of it
  readonly at: () => Counted;
  readonly close: () => void;
};

// Changes count up from 0 within a run, named by `boot`, a random id: a client that read a page
// from a server before a restart takes the new one's changes for a gap, whatever their numbers.
export function watchMemory(mem: Mem, publish: (e: SessionEvent) => void, o: { readonly boot?: string; readonly cap?: number } = {}): MemoryFeed {
  const boot = o.boot ?? crypto.randomUUID();
  let rev = 0;
  let shown = shownOf(mem);
  const check = () => {
    const next = changesSince(mem, shown);
    shown = next.shown;
    if (next.hunks.length === 0) return;
    rev += 1;
    publish({ change: memoryChange(mem, { boot, rev }, next.hunks, o.cap), type: "memory" });
  };
  mem.listeners.add(check);
  return {
    close: () => {
      mem.listeners.delete(check);
    },
    at: () => ({ boot, rev }),
  };
}
