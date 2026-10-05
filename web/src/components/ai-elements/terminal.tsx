// AI Elements' Terminal (elements.ai-sdk.dev registry): a tool's output as a terminal, ANSI colours
// kept. Used for `echo` entries (SPEC "Web UI", Chat). The clear button is left out: the log is
// append-only.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import Ansi from "ansi-to-react";
import { CheckIcon, CopyIcon, TerminalIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";

type TerminalContextType = {
  output: string;
  isStreaming: boolean;
  autoScroll: boolean;
};

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
  const timeoutRef = useRef(0);
  const { output } = useContext(TerminalContext);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setIsCopied(true);
      timeoutRef.current = globalThis.setTimeout(() => {
        setIsCopied(false);
      }, timeout);
    } catch {
      // no clipboard (an insecure origin): the text stays selectable
    }
  };

  useEffect(
    () => () => {
      globalThis.clearTimeout(timeoutRef.current);
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
    <div className={cn("max-h-96 overflow-auto p-3 font-mono text-xs leading-relaxed", className)} ref={containerRef} {...props}>
      {children ?? (
        <pre className="wrap-break-word whitespace-pre-wrap">
          <Ansi>{output}</Ansi>
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
