// AI Elements' Prompt Input (elements.ai-sdk.dev registry), cut to a phone composer: a textarea
// that grows with its text and sends on Enter (on a keyboard; on a touch screen Enter is a new
// line and the send button sends), a footer for tools, send and stop buttons (SPEC "Web UI",
// Chat), and attachments: a picker, a camera button, paste and drop, and a tray of removable
// thumbnails with their upload's progress and, for a photo, its tier (SPEC "Media"). Screenshots,
// referenced sources, the command menu and the AI SDK's ChatStatus are left out, and sending never
// waits for a reply. The text is the caller's state: the form does not clear it.
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { ArrowUpIcon, CameraIcon, FilmIcon, ImageOffIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";
import type { ChangeEvent, ClipboardEvent, ComponentProps, DragEvent, HTMLAttributes, KeyboardEvent, ReactNode, SubmitEvent } from "react";
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
};

const filesOf = (list: FileList | null | undefined) => (list ? [...list] : []);
const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

export const PromptInput = ({ className, onSubmit, canSubmit = (text) => text.trim() !== "", onFiles, below, children, ...props }: PromptInputProps) => {
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
      <InputGroup
        className={cn(
          // the one raised object on the page (DESIGN.md, Composer): a hairline ring and a soft drop,
          // the ring turning to the accent while the text has focus or a file is dragged over
          "relative z-10 overflow-hidden rounded-3xl border-0 bg-raised shadow-[0_0_0_1px_var(--input),var(--elevation-raised)] transition-shadow duration-150 dark:bg-raised",
          "has-[[data-slot=input-group-control]:focus-visible]:shadow-[0_0_0_1px_color-mix(in_oklch,var(--signal)_65%,transparent),0_0_0_4px_color-mix(in_oklch,var(--signal)_14%,transparent),var(--elevation-raised)] has-[[data-slot=input-group-control]:focus-visible]:ring-0",
          dragging && "shadow-[0_0_0_1.5px_var(--signal),0_0_0_5px_color-mix(in_oklch,var(--signal)_16%,transparent),var(--elevation-raised)]",
        )}
        data-dragging={dragging || undefined}
      >
        {children}
      </InputGroup>
      {below}
    </form>
  );
};

// A file picker behind an icon button: the attach button, or with `capture` the camera (a phone
// opens the rear camera; `capture` isn't everywhere, so the plain picker stays next to it)
export type PromptInputAttachProps = Omit<ComponentProps<typeof InputGroupButton>, "onClick"> & {
  readonly accept: string;
  readonly capture?: "environment" | "user";
  readonly label: string;
  readonly onFiles: (files: File[]) => void;
};

export const PromptInputAttach = ({ accept, capture, label, onFiles, children, className, ...props }: PromptInputAttachProps) => {
  const input = useRef<HTMLInputElement>(null);
  const picked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = filesOf(e.currentTarget.files);
    e.currentTarget.value = ""; // the same file can be picked again
    if (files.length > 0) onFiles(files);
  };
  return (
    <>
      <input accept={accept} aria-label={`${label}: files`} capture={capture} className="hidden" multiple={capture === undefined} onChange={picked} ref={input} type="file" />
      <InputGroupButton
        aria-label={label}
        onClick={() => {
          input.current?.click();
        }}
        className={cn("rounded-full text-muted-foreground hover:text-foreground", className)}
        size="icon-sm"
        title={label}
        variant="ghost"
        {...props}
      >
        {children ?? (capture ? <CameraIcon className="size-4" /> : <PaperclipIcon className="size-4" />)}
      </InputGroupButton>
    </>
  );
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

export const PromptInputAttachment = ({ name, kind, preview, progress, done, error, onRemove, high = false, onHigh }: PromptInputAttachmentProps) => {
  // a file the browser can't show (the server may still take it, or say why not)
  const [broken, setBroken] = useState(false);
  return (
    <div className="relative w-16 shrink-0" data-state={error ? "error" : done ? "done" : "uploading"} data-testid="attachment">
      <div
        className={cn(
          "relative flex size-16 items-center justify-center overflow-hidden rounded-xl bg-muted text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]",
          error && "shadow-[inset_0_0_0_1.5px_var(--destructive)]",
        )}
      >
        {kind === "image" && !broken ? (
          <img
            alt={name}
            className={cn("size-full object-cover transition-opacity duration-200", !done && !error && "opacity-60")}
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
      </div>
      <button
        aria-label={`Remove ${name}`}
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow-[0_0_0_2px_var(--raised)] transition-transform after:absolute after:-inset-2.5 hover:scale-105 active:scale-95 pointer-coarse:size-6"
        onClick={onRemove}
        type="button"
      >
        <XIcon className="size-3" strokeWidth={2.5} />
      </button>
      {kind === "image" && (onHigh !== undefined || high) && (
        <button
          aria-label={`High detail for ${name}`}
          aria-pressed={high}
          className={cn(
            "absolute top-1 left-1 rounded-md px-1 text-2xs font-semibold tracking-wide shadow-xs after:absolute after:-inset-2",
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
        <p className="mt-1 line-clamp-3 text-2xs/tight text-destructive" role="alert" title={error}>
          {error}
        </p>
      )}
    </div>
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
  <InputGroupAddon align="block-end" className={cn("cursor-default justify-between gap-1 px-2 pt-1 pb-2", className)} {...props} />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn("flex min-w-0 items-center gap-0.5", className)} {...props} />
);

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton>;

export const PromptInputSubmit = ({ className, variant = "default", size = "icon-sm", children, ...props }: PromptInputSubmitProps) => (
  <InputGroupButton
    aria-label="Send"
    className={cn("rounded-full transition-[background-color,color,transform] active:not-disabled:scale-95 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100", className)}
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
// Outlined in the destructive color, so beside send's filled arrow it never reads as send.
export const PromptInputStop = ({ className, variant = "outline", size = "icon-sm", children, ...props }: PromptInputStopProps) => (
  <InputGroupButton
    aria-label="Stop"
    className={cn(
      "rounded-full border-destructive/60 bg-transparent text-destructive shadow-none hover:bg-destructive/10 hover:text-destructive active:not-disabled:scale-95 dark:border-destructive/60 dark:bg-transparent dark:text-destructive dark:hover:bg-destructive/20",
      className,
    )}
    size={size}
    type="button"
    variant={variant}
    {...props}
  >
    {children ?? <SquareIcon className="size-3.5 fill-current" />}
  </InputGroupButton>
);
