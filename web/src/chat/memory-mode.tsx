// The chat's two transcripts (E46): the log, as logged (the default), or the memory, the view the
// model reads, its older stretches as summaries that open in place (../memory/memory-view.tsx).
// The choice is this page's own, kept in localStorage like the model picker (in try/catch: a
// private window keeps it for the page).
import { segmentedItem, segmentedList } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import { useCallback, useState } from "react";

export type Transcript = "log" | "memory";
const KEY = "transcript";

const loadMode = (): Transcript => {
  try {
    return localStorage.getItem(KEY) === "memory" ? "memory" : "log";
  } catch {
    return "log";
  }
};

export function useTranscript() {
  const [mode, setMode] = useState(loadMode);
  const choose = useCallback((next: Transcript) => {
    setMode(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // no storage: the choice lasts this page
    }
  }, []);
  return [mode, choose] as const;
}

const LABELS = { log: "Log", memory: "Memory" } satisfies Record<Transcript, string>;
const HINTS = { log: "Every message as logged", memory: "What the model reads: older stretches as their summaries" } satisfies Record<Transcript, string>;

// Over the transcript's top edge, at the column's end: the segmented control on a raised pill with
// the Float shadow, as the scroll-to-end button floats over its bottom edge
export function TranscriptToggle({ mode, onMode }: { readonly mode: Transcript; readonly onMode: (mode: Transcript) => void }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-10 mx-auto flex w-full max-w-184 justify-end px-3 sm:px-5">
      <div aria-label="Transcript" className={cn(segmentedList({ ground: "well" }), "pointer-events-auto bg-raised shadow-float")} data-testid="transcript-toggle" role="group">
        {(["log", "memory"] as const).map((m) => (
          <button
            aria-pressed={mode === m}
            className={cn(segmentedItem, "h-6 px-2 text-xs aria-pressed:bg-muted aria-pressed:shadow-none dark:aria-pressed:bg-accent")}
            key={m}
            onClick={() => {
              onMode(m);
            }}
            title={HINTS[m]}
            type="button"
          >
            {LABELS[m]}
          </button>
        ))}
      </div>
    </div>
  );
}
