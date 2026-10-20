// A row of the log, settled (no run's plan, nothing streaming), as the chat draws it: with the
// long pastes folded as this browser sent them, what the model thought before it, and an artifact
// call's card. The memory view (../memory/memory-view.tsx) draws its message lines with it, in the
// chat's Memory mode and on the Memory screen alike, each screen giving what the row reads.
import { type ArtifactInfo } from "@wire";
import { madeBy } from "@/lib/artifacts";
import type { Folds } from "@/lib/draft";
import type { Thoughts } from "@/lib/reasoning";
import { type Row, toolStateOf } from "@/lib/rows";
import { createContext, useContext } from "react";
import { ChatRow } from "./row";

export type LogRowParts = {
  readonly folds: Folds;
  readonly thoughts: Thoughts;
  readonly onThought: (i: number, open: boolean) => void;
  readonly artifacts: readonly ArtifactInfo[];
  // an artifact's card opened, from the row of log index `i` (the Memory screen goes to the chat)
  readonly onArtifact: (name: string, v: number | null, i: number) => void;
  // a turn runs or waits, and the newest tool row's key: only it can still be running, as in the log
  readonly busy: boolean;
  readonly lastTool: string | undefined;
};
const Parts = createContext<LogRowParts | null>(null);
export const LogRowProvider = Parts.Provider;

// `followed`: the row's tool call has its output in the summary block after it (it isn't cut short)
export function LogRow({ row, followed = false }: { readonly row: Row; readonly followed?: boolean }) {
  const parts = useContext(Parts);
  if (parts === null) throw new Error("a log row outside LogRowProvider");
  return (
    <ChatRow
      fold={row.kind === "user" ? parts.folds.get(row.id) : undefined}
      made={madeBy(row, parts.artifacts)}
      onArtifact={(name, v) => {
        parts.onArtifact(name, v, row.id);
      }}
      onThought={parts.onThought}
      row={row}
      streaming={false}
      thought={row.kind === "talk" || row.kind === "tool" ? parts.thoughts.get(row.id) : undefined}
      // as the log reads it (toolStateOf), but done when its output is the summary block after it
      toolState={row.kind === "tool" ? (row.output === null && followed ? "done" : toolStateOf(row, parts.busy, row.key === parts.lastTool)) : "done"}
    />
  );
}
