// An artifact in the chat (SPEC "Artifacts"; DESIGN.md, Artifacts): on the row of the publish or
// edit call that made a version, a compact card with its name, version and size, which opens the
// preview pane. The same card stands for a draft the model is still writing, after the rows of the
// running turn, until the call is in the log. No thumbnail: a preview of a page is the page, run in
// its own sandboxed frame, which is not cheap enough for every card in a long chat.
import { Shimmer } from "@/components/ai-elements/shimmer";
import { type Draft, kb, type Made } from "@/lib/artifacts";
import { cn } from "@/lib/utils";
import { AppWindowIcon, ChevronRightIcon } from "lucide-react";

export type ArtifactCardProps = {
  readonly name: string;
  // what the line under the name says, and whether it is live (shimmering)
  readonly detail: string;
  readonly live?: boolean;
  readonly onOpen: () => void;
  readonly testId?: string;
};

export function ArtifactCard({ name, detail, live = false, onOpen, testId = "artifact-card" }: ArtifactCardProps) {
  return (
    <button
      aria-label={`Open ${name}, ${detail}`}
      className={cn(
        "group/card flex w-full max-w-sm cursor-pointer items-center gap-3 rounded-xl px-2.5 py-2 text-left hairline transition-colors outline-none",
        "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.99] pointer-coarse:py-2.5",
      )}
      data-testid={testId}
      onClick={onOpen}
      type="button"
    >
      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground group-hover/card:text-foreground">
        <AppWindowIcon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-semibold text-foreground">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{live ? <Shimmer>{detail}</Shimmer> : detail}</span>
      </span>
      <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/card:translate-x-0.5" />
    </button>
  );
}

// what a card says of a version a row made: "v3 · 12.4 KB · edited", or while the call runs
export const madeDetail = (made: Made, running: boolean) => {
  if (made.v === null) return running ? (made.tool === "edit" ? "Editing…" : "Publishing…") : "Not saved";
  const parts = [`v${made.v}`];
  if (made.version) parts.push(kb(made.version.bytes));
  parts.push(made.tool === "edit" ? "edited" : "published");
  return parts.join(" · ");
};

// what a draft's card says while the model writes it
export const draftDetail = (d: Draft) => `${d.tool === "edit" ? "Editing" : "Writing"}… ${kb(new TextEncoder().encode(d.html).length)}`;
