// AI Elements' Prompt Input (elements.ai-sdk.dev registry), cut to a text composer: a textarea
// that sends on Enter (on a keyboard; on a touch screen Enter is a new line and the send button
// sends), a footer for tools, and send and stop buttons (SPEC "Web UI", Chat).
// Attachments, screenshots, referenced sources, the command menu and the AI SDK's ChatStatus are
// left out: the log holds text only, and sending never waits for a reply.
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import { CornerDownLeftIcon, SquareIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, KeyboardEvent, SubmitEvent } from "react";
import { useState, useSyncExternalStore } from "react";

export type PromptInputProps = Omit<HTMLAttributes<HTMLFormElement>, "onSubmit"> & {
  // the text as typed, never trimmed; a blank one isn't sent. The form is cleared after
  onSubmit: (text: string) => void;
};

export const PromptInput = ({ className, onSubmit, children, ...props }: PromptInputProps) => {
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const field = form.elements.namedItem("message");
    const text = field instanceof HTMLTextAreaElement ? field.value : "";
    if (text.trim() === "") return;
    form.reset();
    onSubmit(text);
  };
  return (
    <form className={cn("w-full", className)} onSubmit={submit} {...props}>
      <InputGroup className="overflow-hidden">{children}</InputGroup>
    </form>
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
