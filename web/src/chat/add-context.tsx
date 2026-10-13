// The composer's "+" (DESIGN.md, Composer): one round button that opens "Add context", the ways to
// attach something to the next message. On a touch screen it is a sheet from the bottom edge; with a
// mouse, a popover over the button. Both trap focus, close on Escape or a tap outside, and return
// focus to the "+". With one choice only (a mouse has no camera choice) the "+" opens that choice's
// picker itself: a menu of one is a click wasted. A choice opens its file picker from the tap itself (iOS opens a picker only
// inside the gesture), then closes. The pickers are the composer's own hidden inputs
// (PromptInputFileInput): photos and videos from the library or files, and the camera where the
// device has one, exactly as the two buttons this replaces did.
import { useCoarsePointer } from "@/components/ai-elements/prompt-input";
import { InputGroupButton } from "@/components/ui/input-group";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { CameraIcon, ImagesIcon, type LucideIcon, PlusIcon } from "lucide-react";
import { type ComponentProps, type RefObject, useId, useState } from "react";

export type AddContextChoice = {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: LucideIcon;
  readonly input: RefObject<HTMLInputElement | null>;
};

// the choices the composer offers: the library (always) and the camera (on a touch screen, where a
// device has one; elsewhere `capture` is ignored and it would be the same file picker again)
export const addContextChoices = (library: RefObject<HTMLInputElement | null>, camera: RefObject<HTMLInputElement | null>, touch: boolean): readonly AddContextChoice[] => [
  { hint: "From your library or files", icon: ImagesIcon, id: "library", input: library, label: "Photos & videos" },
  ...(touch ? [{ hint: "Take a photo now", icon: CameraIcon, id: "camera", input: camera, label: "Camera" }] : []),
];

function Choices({ choices, onChosen }: { readonly choices: readonly AddContextChoice[]; readonly onChosen: () => void }) {
  return (
    <ul className="grid gap-0.5">
      {choices.map((c) => (
        <li key={c.id}>
          <button
            className="flex w-full items-center gap-3 rounded-xl p-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent active:bg-soft-strong pointer-coarse:py-2.5"
            data-testid={`add-${c.id}`}
            onClick={() => {
              c.input.current?.click(); // inside the tap: the picker opens
              onChosen();
            }}
            type="button"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-soft text-foreground">
              <c.icon aria-hidden="true" className="size-4" strokeWidth={1.75} />
            </span>
            <span className="min-w-0">
              <span className="block text-ui font-medium">{c.label}</span>
              <span className="block text-xs text-muted-foreground">{c.hint}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

// the "+": a soft circle, 36 px (40 on touch); props pass through, so a sheet or popover trigger
// can wrap it
function Plus(props: ComponentProps<typeof InputGroupButton>) {
  return (
    <InputGroupButton aria-label="Add context" className="bg-soft text-foreground hover:bg-soft-strong data-[state=open]:bg-soft-strong" size="icon-md" variant="ghost" {...props}>
      <PlusIcon className="size-4.5" strokeWidth={1.75} />
    </InputGroupButton>
  );
}

export function AddContext({ choices }: { readonly choices: readonly AddContextChoice[] }) {
  const [open, setOpen] = useState(false);
  const touch = useCoarsePointer();
  const title = useId();
  const close = () => {
    setOpen(false);
  };
  const plus = <Plus title="Add context" />;
  const [only] = choices;
  if (!touch && only !== undefined && choices.length === 1) {
    return (
      <Plus
        onClick={() => {
          only.input.current?.click();
        }}
        title={`Add context: ${only.label.toLowerCase()}`}
      />
    );
  }
  if (touch) {
    return (
      <Sheet onOpenChange={setOpen} open={open}>
        <SheetTrigger asChild>{plus}</SheetTrigger>
        <SheetContent
          className="gap-0 rounded-t-3xl border-0 bg-raised px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-float"
          data-testid="add-context"
          side="bottom"
        >
          <span aria-hidden="true" className="mx-auto mb-1 h-1 w-9 rounded-full bg-soft-strong" />
          <SheetHeader className="p-2">
            <SheetTitle className="text-base tracking-tight">Add context</SheetTitle>
            <SheetDescription className="sr-only">Attach a photo or a video to your next message</SheetDescription>
          </SheetHeader>
          <Choices choices={choices} onChosen={close} />
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Popover modal onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>{plus}</PopoverTrigger>
      <PopoverContent align="start" aria-labelledby={title} className="w-64 rounded-2xl border-0 p-1.5 shadow-float" data-testid="add-context" role="dialog" side="top" sideOffset={8}>
        <p className="px-2 pt-1.5 pb-1 text-2xs font-medium text-muted-foreground" id={title}>
          Add context
        </p>
        <Choices choices={choices} onChosen={close} />
      </PopoverContent>
    </Popover>
  );
}
