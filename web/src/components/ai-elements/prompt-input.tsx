// AI Elements' Prompt Input (elements.ai-sdk.dev registry), cut to a phone composer: a textarea
// that sends on Enter (on a keyboard; on a touch screen Enter is a new line and the send button
// sends), a footer for tools, send and stop buttons (SPEC "Web UI", Chat), and attachments: a
// picker, a camera button, paste and drop, and a tray of removable thumbnails with their upload's
// progress (SPEC "Media"). Screenshots, referenced sources, the command menu and the AI SDK's
// ChatStatus are left out, and sending never waits for a reply.
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { CameraIcon, CornerDownLeftIcon, FilmIcon, ImageOffIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";
import type { ChangeEvent, ClipboardEvent, ComponentProps, DragEvent, HTMLAttributes, KeyboardEvent, ReactNode, SubmitEvent } from "react";
import { useRef, useState, useSyncExternalStore } from "react";

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> & {
  // the text as typed, never trimmed. The form is cleared after
  onSubmit: (text: string) => void;
  // whether this text may be sent now; by default any that isn't blank
  canSubmit?: (text: string) => boolean;
  // files pasted or dropped onto the composer
  onFiles?: (files: File[]) => void;
};

const filesOf = (list: FileList | null | undefined) => (list ? [...list] : []);
const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes("Files");

export const PromptInput = ({ className, onSubmit, canSubmit = (text) => text.trim() !== "", onFiles, children, ...props }: PromptInputProps) => {
  const [dragging, setDragging] = useState(false);
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const field = form.elements.namedItem("message");
    const text = field instanceof HTMLTextAreaElement ? field.value : "";
    if (!canSubmit(text)) return;
    form.reset();
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
      <InputGroup className={cn("overflow-hidden", dragging && "border-primary ring-[3px] ring-primary/30")} data-dragging={dragging || undefined}>
        {children}
      </InputGroup>
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

export const PromptInputAttach = ({ accept, capture, label, onFiles, children, ...props }: PromptInputAttachProps) => {
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
        size="icon-sm"
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
  <InputGroupAddon align="block-start" className={cn("flex-wrap gap-2", className)} data-testid="attachments" {...props} />
);

export type PromptInputAttachmentProps = {
  readonly name: string;
  readonly kind: "image" | "video";
  readonly preview: string; // an object URL of the picked file
  readonly progress: number; // 0..1
  readonly done: boolean;
  readonly error: string | null;
  readonly onRemove: () => void;
  readonly children?: ReactNode;
};

export const PromptInputAttachment = ({ name, kind, preview, progress, done, error, onRemove }: PromptInputAttachmentProps) => {
  // a file the browser can't show (the server may still take it, or say why not)
  const [broken, setBroken] = useState(false);
  return (
    <div className="relative w-20 shrink-0" data-state={error ? "error" : done ? "done" : "uploading"} data-testid="attachment">
      <div className={cn("flex size-20 items-center justify-center overflow-hidden rounded-md border bg-muted", error && "border-destructive")}>
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
          <ImageOffIcon aria-label={name} className="size-6" />
        ) : (
          <FilmIcon aria-label={name} className="size-6" />
        )}
      </div>
      <button
        aria-label={`Remove ${name}`}
        className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-foreground shadow-xs"
        onClick={onRemove}
        type="button"
      >
        <XIcon className="size-3" />
      </button>
      {!done && !error && <Progress aria-label={`Uploading ${name}`} className="mt-1 h-1" value={Math.round(progress * 100)} />}
      {error !== null && (
        <p className="mt-1 line-clamp-3 text-[10px] leading-tight text-destructive" role="alert" title={error}>
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

export const PromptInputTextarea = ({ onKeyDown, className, placeholder = "Message", ...props }: PromptInputTextareaProps) => {
  const [composing, setComposing] = useState(false);
  const touch = useSyncExternalStore(onPointerChange, coarse);

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
      className={cn("field-sizing-content max-h-48 min-h-12", className)}
      enterKeyHint={touch ? "enter" : "send"}
      name="message"
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
  <InputGroupAddon align="block-end" className={cn("justify-between gap-1", className)} {...props} />
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({ className, ...props }: PromptInputToolsProps) => (
  <div className={cn("flex min-w-0 items-center gap-1", className)} {...props} />
);

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton>;

export const PromptInputSubmit = ({ className, variant = "default", size = "icon-sm", children, ...props }: PromptInputSubmitProps) => (
  <InputGroupButton aria-label="Send" className={cn(className)} size={size} type="submit" variant={variant} {...props}>
    {children ?? <CornerDownLeftIcon className="size-4" />}
  </InputGroupButton>
);

export type PromptInputStopProps = ComponentProps<typeof InputGroupButton>;

// the registry's submit button turns into this while a reply streams; here both are shown, since
// a message sent during a turn joins it
export const PromptInputStop = ({ className, variant = "secondary", size = "icon-sm", children, ...props }: PromptInputStopProps) => (
  <InputGroupButton aria-label="Stop" className={cn(className)} size={size} type="button" variant={variant} {...props}>
    {children ?? <SquareIcon className="size-4" />}
  </InputGroupButton>
);
