// AI Elements' Terminal (elements.ai-sdk.dev registry): a tool's output as a terminal. Used for
// `echo` entries (SPEC "Web UI", Chat), inside a tool call's panel, so it takes the panel's ground
// and tokens rather than the registry's always-black zinc (DESIGN.md, Tool calls). The clear button
// is left out: the log is append-only. The
// registry's ansi-to-react is too: its CommonJS default export doesn't survive Vite's build, so
// escape sequences are dropped instead of drawn as colours.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
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
  <div className={cn("flex h-8 items-center justify-between pr-1 pl-3", className)} {...props}>
    {children}
  </div>
);

export type TerminalTitleProps = HTMLAttributes<HTMLDivElement>;

export const TerminalTitle = ({ className, children, ...props }: TerminalTitleProps) => (
  <div className={cn("flex items-center gap-2 text-2xs font-medium text-muted-foreground", className)} {...props}>
    {children ?? "Output"}
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
      className={cn("size-7 shrink-0 text-muted-foreground hover:text-foreground pointer-coarse:size-10", className)}
      onClick={() => void copy()}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? <Icon className="size-3.5" />}
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
    <div className={cn("max-h-80 overflow-auto px-3 pb-3 font-mono text-xs/relaxed text-foreground/90", className)} ref={containerRef} {...props}>
      {children ?? (
        <pre className="wrap-break-word whitespace-pre-wrap">
          {plainText(output)}
          {isStreaming && <span className="ml-0.5 inline-block h-4 w-2 animate-pulse bg-foreground" />}
        </pre>
      )}
    </div>
  );
};

export type TerminalProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  output: string;
  title?: ReactNode; // the header's label, "Output" by default
  isStreaming?: boolean;
  autoScroll?: boolean;
};

export const Terminal = ({ output, isStreaming = false, autoScroll = true, title, className, children, ...props }: TerminalProps) => {
  const contextValue = useMemo(() => ({ autoScroll, isStreaming, output }), [autoScroll, isStreaming, output]);

  return (
    <TerminalContext.Provider value={contextValue}>
      <div className={cn("flex flex-col overflow-hidden", className)} data-slot="terminal" {...props}>
        {children ?? (
          <>
            <TerminalHeader>
              <TerminalTitle>{title}</TerminalTitle>
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
