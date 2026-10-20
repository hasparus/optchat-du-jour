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
};
const Parts = createContext<LogRowParts | null>(null);
export const LogRowProvider = Parts.Provider;

export function LogRow({ row }: { readonly row: Row }) {
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
      // a tool call whose output is a line of its own (a summary) is done, not cut short
      toolState={row.kind === "tool" && row.output !== null ? toolStateOf(row, false, false) : "done"}
    />
  );
}
