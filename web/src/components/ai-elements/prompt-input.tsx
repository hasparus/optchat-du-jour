// AI Elements' Prompt Input (elements.ai-sdk.dev registry), cut to a phone composer: a textarea
// that grows with its text and sends on Enter (on a keyboard; on a touch screen Enter is a new
// line and the send button sends), a footer for tools, send and stop buttons (SPEC "Web UI",
// Chat), and attachments: a picker, a camera button, paste and drop, and a tray of removable
// thumbnails with their upload's progress and, for a photo, its tier (SPEC "Media"). Screenshots,
// referenced sources, the command menu and the AI SDK's ChatStatus are left out, and sending never
// waits for a reply. The text is the caller's state: the form does not clear it.
import { Attachment, AttachmentAction, AttachmentActions, AttachmentDescription, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { ArrowUpIcon, FilmIcon, ImageOffIcon, SquareIcon, XIcon } from "lucide-react";
import type { ChangeEvent, ClipboardEvent, ComponentProps, DragEvent, HTMLAttributes, KeyboardEvent, ReactNode, Ref, SubmitEvent } from "react";
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> & {
  // the text as typed, never trimmed; the caller clears it
  onSubmit: (text: string) => void;
  // whether this text may be sent now; by default any that isn't blank
  canSubmit?: (text: string) => boolean;
  // files pasted or dropped onto the composer
  onFiles?: (files: File[]) => void;
  // a line under the composer's surface (the shortcuts, or why send is off)
  below?: ReactNode;
  // a tray is attached to the top edge (DESIGN.md, Composer): the two read as one glass shape, the
  // tray's top corners rounded and the composer's squared where they meet
  attached?: boolean;
};

const filesOf = (list: FileList | null | undefined) => (list ? [...list] : []);
const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

export const PromptInput = ({ className, onSubmit, canSubmit = (text) => text.trim() !== "", onFiles, below, attached = false, children, ...props }: PromptInputProps) => {
  const [dragging, setDragging] = useState(false);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const field = form.elements.namedItem("message");
    const text = field instanceof HTMLTextAreaElement ? field.value : "";
    if (!canSubmit(text)) return;
    onSubmit(text);
  };
  // pasted files go to the tray; pasted text stays text
  const paste = (e: ClipboardEvent<HTMLFormElement>) => {
    const files = filesOf(e.clipboardData.files);
    if (!onFiles || files.length === 0) return;
    e.preventDefault();
    onFiles(files);
  };
  const over = (e: DragEvent<HTMLFormElement>) => {
    if (!onFiles || !hasFiles(e)) return;
    e.preventDefault();
    setDragging(true);
  };
  const drop = (e: DragEvent<HTMLFormElement>) => {
    setDragging(false);
    const files = filesOf(e.dataTransfer.files);
    if (!onFiles || files.length === 0) return;
    e.preventDefault();
    onFiles(files);
  };
  return (
    <form
      className={cn("w-full", className)}
      onDragLeave={() => {
        setDragging(false);
      }}
      onDragOver={over}
      onDrop={drop}
      onPaste={paste}
      onSubmit={submit}
      {...props}
    >
      {/* the one raised object on the page (DESIGN.md, Composer), on glass (index.css,
          glass-surface): translucent over what scrolls under it, a sheen on its top edge, a ring
          drawn as a shadow; the ring turns to the accent while the text has focus or a file is
          dragged over (composer-surface). One radius (rounded-glass), and the group inside clips to
          it. */}
      <div
        className={cn("glass-surface composer-surface relative z-10 overflow-hidden rounded-glass transition-shadow duration-150", attached && "glass-joined rounded-t-none")}
        data-dragging={dragging || undefined}
      >
        {/* the group itself is see-through: the surface above draws ground, ring and sheen */}
        <InputGroup className="rounded-[inherit] border-0 bg-transparent shadow-none has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-transparent">{children}</InputGroup>
      </div>
      {below}
    </form>
  );
};

// A hidden file picker, opened by the composer's "Add context" choices (chat/add-context.tsx): the
// library and files, or with `capture` the camera (a phone opens the rear camera; `capture` isn't
// everywhere, so the plain picker is always offered too). It stays mounted with the composer, so a
// choice can open it from the tap itself (iOS opens a picker only inside the gesture) and close the
// sheet after.
export type PromptInputFileInputProps = {
  readonly accept: string;
  readonly capture?: "environment" | "user";
  readonly label: string;
  readonly onFiles: (files: File[]) => void;
  readonly ref?: Ref<HTMLInputElement>;
};

export const PromptInputFileInput = ({ accept, capture, label, onFiles, ref }: PromptInputFileInputProps) => {
  const picked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = filesOf(e.currentTarget.files);
    e.currentTarget.value = ""; // the same file can be picked again
    if (files.length > 0) onFiles(files);
  };
  return <input accept={accept} aria-label={`${label}: files`} capture={capture} className="hidden" multiple={capture === undefined} onChange={picked} ref={ref} type="file" />;
};

// the tray over the text: one thumbnail per attachment
export const PromptInputAttachments = ({ className, ...props }: HTMLAttributes<HTMLDivElement>) => (
  <InputGroupAddon align="block-start" className={cn("flex-wrap gap-2.5 px-3.5 pt-3.5", className)} data-testid="attachments" {...props} />
);

export type PromptInputAttachmentProps = {
  readonly name: string;
  readonly kind: "image" | "video";
  readonly preview: string; // an object URL of the picked file, or our own thumbnail of an upload
  readonly progress: number; // 0..1
  readonly done: boolean;
  readonly error: string | null;
  readonly onRemove: () => void;
  // a photo's tier, and a toggle for it when the photo can be uploaded again (its file is here)
  readonly high?: boolean;
  readonly onHigh?: () => void;
  readonly children?: ReactNode;
};

// One tile of the tray, on shadcn's Attachment (its `uploading`, `done` and `error` states, the
// image media dimmed until the upload is done, an action to remove it), dressed as the tray's 64 px
// thumbnail: the remove button on its corner, the HD toggle on the photo, and what Attachment has
// no part for, the upload's progress bar. The name is for screen readers; a failure says why
// under the tile (role alert), so it isn't told by colour alone.
export const PromptInputAttachment = ({ name, kind, preview, progress, done, error, onRemove, high = false, onHigh }: PromptInputAttachmentProps) => {
  // a file the browser can't show (the server may still take it, or say why not)
  const [broken, setBroken] = useState(false);
  const state = error ? "error" : done ? "done" : "uploading";
  return (
    <Attachment
      className="w-16 flex-col flex-nowrap gap-1 rounded-xl border-0 bg-transparent has-data-[slot=attachment-media]:p-0 has-[>a,>button]:hover:bg-transparent"
      data-testid="attachment"
      orientation="vertical"
      size="xs"
      state={state}
    >
      <AttachmentMedia
        className={cn(
          "size-16 rounded-xl bg-muted text-muted-foreground transition-opacity duration-200 group-data-[orientation=vertical]/attachment:w-16 group-data-[size=xs]/attachment:w-16 group-data-[size=xs]/attachment:rounded-xl group-data-[state=error]/attachment:bg-muted group-data-[state=error]/attachment:text-muted-foreground",
          kind === "image" && "group-data-[state=error]/attachment:opacity-100",
          error ? "shadow-[inset_0_0_0_1.5px_var(--destructive)]" : "hairline",
        )}
        variant={kind === "image" && !broken ? "image" : "icon"}
      >
        {kind === "image" && !broken ? (
          <img
            alt={name}
            className="size-full object-cover"
            onError={() => {
              setBroken(true);
            }}
            src={preview}
          />
        ) : kind === "image" ? (
          <ImageOffIcon aria-label={name} className="size-5" />
        ) : (
          <FilmIcon aria-label={name} className="size-5" />
        )}
        {!done && !error && (
          <Progress aria-label={`Uploading ${name}`} className="absolute inset-x-1.5 bottom-1.5 h-1 w-auto bg-background/70" value={Math.round(progress * 100)} />
        )}
      </AttachmentMedia>
      <AttachmentTitle className="sr-only">{name}</AttachmentTitle>
      <AttachmentActions className="absolute -top-1.5 -right-1.5 group-data-[orientation=vertical]/attachment:-top-1.5 group-data-[orientation=vertical]/attachment:-right-1.5">
        <AttachmentAction
          aria-label={`Remove ${name}`}
          className="size-5 rounded-full border-0 bg-foreground text-background shadow-[0_0_0_2px_var(--raised)] transition-transform after:absolute after:-inset-2.5 hover:scale-105 hover:bg-foreground hover:text-background active:scale-95 pointer-coarse:size-6"
          onClick={onRemove}
          size="icon-xs"
          variant="default"
        >
          <XIcon className="size-3" strokeWidth={2.5} />
        </AttachmentAction>
      </AttachmentActions>
      {kind === "image" && (onHigh !== undefined || high) && (
        <button
          aria-label={`High detail for ${name}`}
          aria-pressed={high}
          className={cn(
            "absolute top-1 left-1 z-20 rounded-md px-1 text-2xs font-semibold tracking-wide shadow-xs after:absolute after:-inset-2",
            high ? "bg-signal text-signal-foreground" : "bg-raised/90 text-foreground",
          )}
          disabled={!onHigh}
          onClick={onHigh}
          title={high ? "High detail: sent at up to 2576 px" : "Standard detail (1568 px): tap for high detail"}
          type="button"
        >
          HD
        </button>
      )}
      {error !== null && (
        <AttachmentDescription className="mt-0 line-clamp-3 w-16 text-2xs/tight whitespace-normal text-destructive" role="alert" title={error}>
          {error}
        </AttachmentDescription>
      )}
    </Attachment>
  );
};

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({ className, ...props }: PromptInputBodyProps) => <div className={cn("contents", className)} {...props} />;

export type PromptInputTextareaProps = ComponentProps<typeof InputGroupTextarea>;

// a phone or tablet: no hardware keyboard to expect, so Enter stays a new line
const COARSE = "(pointer: coarse)";
const coarse = () => matchMedia(COARSE).matches;
const onPointerChange = (changed: () => void) => {
  const query = matchMedia(COARSE);
  query.addEventListener("change", changed);
  return () => {
    query.removeEventListener("change", changed);
  };
};
export const useCoarsePointer = () => useSyncExternalStore(onPointerChange, coarse);

// CSS grows the textarea with its text (field-sizing); where that isn't there yet (Firefox), its
// height follows its content here, up to the max-height the class sets
const sizedByCss = () => "CSS" in globalThis && CSS.supports("field-sizing", "content");

export const PromptInputTextarea = ({ onKeyDown, className, placeholder = "Message", value, ...props }: PromptInputTextareaProps) => {
  const [composing, setComposing] = useState(false);
  const touch = useCoarsePointer();
  const own = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = own.current;
    if (!el || sizedByCss()) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  // Enter sends, Shift-Enter is a new line; not while an input method is composing, and not on a
  // touch screen, where the send button sends
  const keyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(e);
    if (touch || e.defaultPrevented || e.key !== "Enter" || e.shiftKey || composing || e.nativeEvent.isComposing) return;
    e.preventDefault();
    e.currentTarget.form?.requestSubmit();
  };

  return (
    <InputGroupTextarea
      className={cn("field-sizing-content max-h-[min(12rem,40dvh)] min-h-13 px-4 pt-3.5 pb-1 text-read/normal placeholder:text-muted-foreground md:text-read", className)}
      enterKeyHint={touch ? "enter" : "send"}
      name="message"
      ref={own}
      value={value}
      onCompositionEnd={() => {
        setComposing(false);
      }}
      onCompositionStart={() => {
        setComposing(true);
      }}
      onKeyDown={keyDown}
      placeholder={placeholder}
      {...props}
    />
  );
};

export type PromptInputFooterProps = Omit<ComponentProps<typeof InputGroupAddon>, "align">;

export const PromptInputFooter = ({ className, ...props }: PromptInputFooterProps) => (
  <InputGroupAddon align="block-end" className={cn("cursor-default justify-between gap-1 pt-1 pr-2 pb-2 pl-4", className)} {...props} />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn("flex min-w-0 items-center gap-4.5", className)} {...props} />
);

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton>;

// send: an ink circle with an arrow; with nothing to send, a soft circle with a muted arrow
export const PromptInputSubmit = ({ className, variant = "default", size = "icon-md", children, ...props }: PromptInputSubmitProps) => (
  <InputGroupButton
    aria-label="Send"
    className={cn("transition-[background-color,color,transform] active:not-disabled:scale-95 disabled:bg-soft disabled:text-muted-foreground disabled:opacity-100", className)}
    size={size}
    type="submit"
    variant={variant}
    {...props}
  >
    {children ?? <ArrowUpIcon className="size-4" />}
  </InputGroupButton>
);

export type PromptInputStopProps = ComponentProps<typeof InputGroupButton>;

// the submit button turns into this while a turn runs and there is nothing to send: with text or
// an attachment it is send again, since a message sent during a turn joins it or waits for the next.
// A filled ink square on a soft circle (as in Claude's app), so beside send's filled ink circle and
// arrow the two never read alike: one is a solid disc, the other a square on a tint.
export const PromptInputStop = ({ className, variant = "ghost", size = "icon-md", children, ...props }: PromptInputStopProps) => (
  <InputGroupButton
    aria-label="Stop"
    className={cn("bg-soft text-foreground hover:bg-soft-strong hover:text-foreground active:not-disabled:scale-95 dark:hover:bg-soft-strong", className)}
    size={size}
    type="button"
    variant={variant}
    {...props}
  >
    {children ?? <SquareIcon className="size-3.5 fill-current" strokeWidth={0} />}
  </InputGroupButton>
);
