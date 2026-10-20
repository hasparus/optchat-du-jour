// A file tool's change under its tool line (lib/diff.ts; DESIGN.md, Diffs): an Edit or a MultiEdit as
// a red and green line diff, open, its first DIFF_SHOWN lines and then the rest on a tap; a Write as
// the new file's lines, plain, closed behind their count. Drawn from the input as it streams too (E45). The tool
// line above keeps the input and the output as logged, one tap away.
import type { DiffLine, FileChange } from "@/lib/diff";
import { cn } from "@/lib/utils";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

// diff lines shown before "Show N more lines": about a phone screen of 12 px code
export const DIFF_SHOWN = 24;

const SIGN = { add: "+", del: "-", same: " " } satisfies Record<DiffLine["kind"], string>;
const WORD = { add: "added", del: "removed", same: "" } satisfies Record<DiffLine["kind"], string>;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// "+3 −1" for the tool line, each count in its own colour and said in words to a screen reader
export function DiffStat({ added, removed }: { readonly added: number; readonly removed: number }) {
  return (
    <span className="font-mono text-xs tabular-nums" data-testid="diff-stat">
      <span className="text-diff-add-ink">+{added}</span> <span className="text-diff-del-ink">−{removed}</span>
      <span className="sr-only">
        : {plural(added, "line")} added, {plural(removed, "line")} removed
      </span>
    </span>
  );
}

function Line({ line }: { readonly line: DiffLine }) {
  return (
    <div className={cn("flex min-w-max pr-3", line.kind === "add" && "bg-diff-add", line.kind === "del" && "bg-diff-del")} data-diff={line.kind}>
      <span aria-hidden="true" className={cn("w-6 shrink-0 text-center select-none", line.kind === "add" ? "text-diff-add-ink" : line.kind === "del" ? "text-diff-del-ink" : "text-muted-foreground")}>
        {SIGN[line.kind]}
      </span>
      {line.kind !== "same" && <span className="sr-only">{WORD[line.kind]}: </span>}
      <span className="whitespace-pre" data-slot="diff-text">
        {line.text === "" ? " " : line.text}
      </span>
    </div>
  );
}

// the lines, `shown` of them until the rest are asked for
function Lines({ lines, testId }: { readonly lines: readonly (DiffLine | "gap")[]; readonly testId: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, DIFF_SHOWN);
  const more = lines.length - shown.length;
  return (
    <div className="overflow-hidden rounded-[10px] bg-code font-mono text-xs/relaxed hairline" data-testid={testId}>
      <div className="overflow-x-auto py-1.5">
        {shown.map((line, k) =>
          line === "gap" ? (
            // oxlint-disable-next-line react/no-array-index-key -- a line is its position
            <div aria-hidden="true" className="my-1 border-t border-dashed" key={k} />
          ) : (
            // oxlint-disable-next-line react/no-array-index-key -- a line is its position
            <Line key={k} line={line} />
          ),
        )}
      </div>
      {more > 0 && (
        <button
          className="flex min-h-8 w-full items-center justify-center border-t font-sans text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground pointer-coarse:min-h-10"
          onClick={() => {
            setAll(true);
          }}
          type="button"
        >
          Show {plural(more, "more line")}
        </button>
      )}
    </div>
  );
}

// a Write's new file: closed behind its line count until opened
function NewFile({ change }: { readonly change: Extract<FileChange, { kind: "write" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        aria-expanded={open}
        className="relative flex w-fit items-center gap-1 rounded-md px-1 text-xs text-muted-foreground transition-colors after:absolute after:-inset-y-2 after:inset-x-0 hover:text-foreground"
        data-testid="new-file-toggle"
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        <ChevronRightIcon aria-hidden="true" className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")} />
        {change.whole ? "New file" : "Writing"} · <span className="tabular-nums">{plural(change.lines.length, "line")}</span>
      </button>
      {open && <Lines lines={change.lines.map((text): DiffLine => ({ kind: "same", text }))} testId="new-file" />}
    </div>
  );
}

export function ToolDiff({ change }: { readonly change: FileChange }) {
  if (change.kind === "write") return <NewFile change={change} />;
  // a MultiEdit's hunks, a dashed rule between each two
  const lines = change.hunks.flatMap((h, k): (DiffLine | "gap")[] => (k === 0 ? [...h] : ["gap", ...h]));
  return <Lines lines={lines} testId="tool-diff" />;
}
