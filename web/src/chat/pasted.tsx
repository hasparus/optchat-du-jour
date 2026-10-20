// Long pastes, folded (lib/paste.ts): on the composer's tray a chip per pasted block, which opens a
// preview of it and can be removed (its token goes from the text with it); in a sent message, each
// pasted block (or, from another browser, a message as long as one) as a summary line over its first
// lines, which opens the block in place.
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/components/ui/attachment";
import { bytesOf, foldParts, lineCount, type Paste, sizeOf, type Span } from "@/lib/paste";
import { cn } from "@/lib/utils";
import { kb } from "@wire";
import { ChevronRightIcon, TextIcon, XIcon } from "lucide-react";
import { useState } from "react";

// "120 lines · 5.2 KB", or "5.2 KB" for one long line
const detailOf = (text: string) => (lineCount(text) > 1 ? `${sizeOf(text)} · ${kb(bytesOf(text))}` : sizeOf(text));

// A pasted block on the tray: the chip opens or closes its preview (`open`), its corner button removes it
export function PastedChip({ paste, open, onOpen, onRemove }: { readonly paste: Paste; readonly open: boolean; readonly onOpen: () => void; readonly onRemove: () => void }) {
  return (
    <Attachment className={cn("h-16 max-w-56 rounded-xl border-0 bg-transparent pr-2 hairline", open && "bg-accent")} data-testid="pasted-chip" size="sm">
      <AttachmentTrigger aria-controls={`paste-${paste.id}`} aria-expanded={open} aria-label={`Pasted text #${paste.id}, ${detailOf(paste.text)}: ${open ? "hide" : "show"} it`} className="rounded-xl focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpen} />
      <AttachmentMedia className="size-10 rounded-lg bg-soft text-muted-foreground">
        <TextIcon />
      </AttachmentMedia>
      <AttachmentContent className="self-center">
        <AttachmentTitle className="text-ui">Pasted text</AttachmentTitle>
        <AttachmentDescription className="text-2xs tabular-nums">{detailOf(paste.text)}</AttachmentDescription>
      </AttachmentContent>
      <AttachmentActions className="absolute -top-1.5 -right-1.5">
        <AttachmentAction
          aria-label={`Remove pasted text #${paste.id}`}
          className="size-5 rounded-full border-0 bg-foreground text-background shadow-[0_0_0_2px_var(--raised)] transition-transform after:absolute after:-inset-2.5 hover:scale-105 hover:bg-foreground hover:text-background active:scale-95 pointer-coarse:size-6"
          onClick={onRemove}
          size="icon-xs"
          type="button"
          variant="default"
        >
          <XIcon className="size-3" strokeWidth={2.5} />
        </AttachmentAction>
      </AttachmentActions>
    </Attachment>
  );
}

// the open chip's block, as it will be sent
export function PastePreview({ paste }: { readonly paste: Paste }) {
  return (
    <pre
      className="max-h-48 w-full overflow-auto rounded-lg bg-code p-2.5 font-mono text-xs/relaxed whitespace-pre-wrap text-foreground/90 hairline"
      data-testid="paste-preview"
      id={`paste-${paste.id}`}
      tabIndex={0}
    >
      {paste.text}
    </pre>
  );
}

// One pasted block of a sent message (or a long one, whole): a summary line and its first lines,
// muted, until it is opened
function Fold({ label, text }: { readonly label: string; readonly text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="my-1 block" data-state={open ? "open" : "closed"} data-testid="pasted-fold">
      <button
        aria-expanded={open}
        className="relative -mx-1 flex items-center gap-1 rounded-md px-1 text-ui text-muted-foreground transition-colors after:absolute after:-inset-y-2 after:inset-x-0 hover:text-foreground"
        onClick={() => {
          setOpen(!open);
        }}
        type="button"
      >
        <ChevronRightIcon aria-hidden="true" className={cn("size-3.5 transition-transform duration-150", open && "rotate-90")} />
        <span>{label}</span>
        <span className="text-2xs tabular-nums">· {detailOf(text)}</span>
      </button>
      {open ? <span className="block">{text}</span> : <span aria-hidden="true" className="line-clamp-2 text-ui text-muted-foreground">{text}</span>}
    </span>
  );
}

// A user message's text with its pasted blocks folded: where this browser knows them to be
// (`spans`), else the whole text when it is as long as a paste that folds
export function FoldedText({ text, spans }: { readonly text: string; readonly spans: readonly Span[] | null }) {
  const parts = foldParts(text, spans);
  if (parts.length === 1 && parts[0]?.kind === "plain") return text;
  return parts.map((p, k) =>
    // oxlint-disable-next-line react/no-array-index-key -- a part is its position
    p.kind === "plain" ? <span key={k}>{p.text}</span> : <Fold key={k} label={p.kind === "pasted" ? "Pasted text" : "Long message"} text={p.text} />,
  );
}
