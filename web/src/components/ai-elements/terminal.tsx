// AI Elements' Terminal (elements.ai-sdk.dev registry): a tool's output as a terminal. Used for
// `echo` entries (SPEC "Web UI", Chat). The clear button is left out: the log is append-only. The
// registry's ansi-to-react is too: its CommonJS default export doesn't survive Vite's build, so
// escape sequences are dropped instead of drawn as colours.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon, TerminalIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

type TerminalContextType = {
  output: string;
  isStreaming: boolean;
  autoScroll: boolean;
};

// CSI and OSC sequences, and the other C0/C1 controls but newline and tab
// oxlint-disable-next-line no-control-regex -- matching control characters is the point
const ESCAPES = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
export const plainText = (s: string) => s.replaceAll(ESCAPES, "");

const TerminalContext = createContext<TerminalContextType>({ autoScroll: true, isStreaming: false, output: "" });

export type TerminalHeaderProps = HTMLAttributes<HTMLDivElement>;

export const TerminalHeader = ({ className, children, ...props }: TerminalHeaderProps) => (
  <div className={cn("flex items-center justify-between border-b border-zinc-800 px-3 py-1.5", className)} {...props}>
    {children}
  </div>
);

export type TerminalTitleProps = HTMLAttributes<HTMLDivElement>;

export const TerminalTitle = ({ className, children, ...props }: TerminalTitleProps) => (
  <div className={cn("flex items-center gap-2 text-xs text-zinc-400", className)} {...props}>
    <TerminalIcon className="size-4" />
    {children ?? "Terminal"}
  </div>
);

export type TerminalActionsProps = HTMLAttributes<HTMLDivElement>;

export const TerminalActions = ({ className, children, ...props }: TerminalActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type TerminalCopyButtonProps = ComponentProps<typeof Button> & {
  timeout?: number;
};

export const TerminalCopyButton = ({ timeout = 2000, children, className, ...props }: TerminalCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { output } = useContext(TerminalContext);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setIsCopied(true);
      timeoutRef.current = setTimeout(() => {
        setIsCopied(false);
      }, timeout);
    } catch {
      // no clipboard (an insecure origin): the text stays selectable
    }
  };

  useEffect(
    () => () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    },
    [],
  );

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      aria-label="Copy output"
      className={cn("size-7 shrink-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100", className)}
      onClick={() => void copy()}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon size={14} />}
    </Button>
  );
};

export type TerminalContentProps = HTMLAttributes<HTMLDivElement>;

export const TerminalContent = ({ className, children, ...props }: TerminalContentProps) => {
  const { output, isStreaming, autoScroll } = useContext(TerminalContext);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && containerRef.current) containerRef.current.scrollTop = containerRef.current.scrollHeight;
  }, [output, autoScroll]);

  return (
    <div className={cn("max-h-96 overflow-auto p-3 font-mono text-xs/relaxed", className)} ref={containerRef} {...props}>
      {children ?? (
        <pre className="wrap-break-word whitespace-pre-wrap">
          {plainText(output)}
          {isStreaming && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-zinc-100" />}
        </pre>
      )}
    </div>
  );
};

export type TerminalProps = HTMLAttributes<HTMLDivElement> & {
  output: string;
  isStreaming?: boolean;
  autoScroll?: boolean;
};

export const Terminal = ({ output, isStreaming = false, autoScroll = true, className, children, ...props }: TerminalProps) => {
  const contextValue = useMemo(() => ({ autoScroll, isStreaming, output }), [autoScroll, isStreaming, output]);

  return (
    <TerminalContext.Provider value={contextValue}>
      <div className={cn("flex flex-col overflow-hidden rounded-lg border bg-zinc-950 text-zinc-100", className)} {...props}>
        {children ?? (
          <>
            <TerminalHeader>
              <TerminalTitle />
              <TerminalActions>
                <TerminalCopyButton />
              </TerminalActions>
            </TerminalHeader>
            <TerminalContent />
          </>
        )}
      </div>
    </TerminalContext.Provider>
  );
};
