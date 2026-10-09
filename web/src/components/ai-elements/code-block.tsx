// AI Elements' Code Block (elements.ai-sdk.dev registry): highlighted code with shiki, plain text
// until the highlighter has loaded; shiki itself loads with the first block. Used for tool inputs
// (SPEC "Web UI", Chat). The language picker is left out; a block's language is known.
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";

// shiki's font style bit flags
const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;
const has = (fontStyle: number | undefined, flag: number) => ((fontStyle ?? 0) & flag) !== 0;

type Line = { key: string; tokens: { key: string; token: ThemedToken }[] };
type Tokenized = { tokens: ThemedToken[][]; fg: string; bg: string };

const keyed = (lines: ThemedToken[][]): Line[] =>
  lines.map((line, l) => ({ key: `line-${l}`, tokens: line.map((token, t) => ({ key: `line-${l}-${t}`, token })) }));

const TokenSpan = ({ token }: { token: ThemedToken }) => (
  <span
    className="dark:bg-(--shiki-dark-bg)! dark:text-(--shiki-dark)!"
    style={{
      backgroundColor: token.bgColor,
      color: token.color,
      fontStyle: has(token.fontStyle, ITALIC) ? "italic" : undefined,
      fontWeight: has(token.fontStyle, BOLD) ? "bold" : undefined,
      textDecoration: has(token.fontStyle, UNDERLINE) ? "underline" : undefined,
      ...token.htmlStyle,
    }}
  >
    {token.content}
  </span>
);

const LineSpan = ({ line }: { line: Line }) => (
  <span className="block">
    {line.tokens.length === 0 ? "\n" : line.tokens.map(({ token, key }) => <TokenSpan key={key} token={token} />)}
  </span>
);

const CodeBlockContext = createContext({ code: "" });

// one highlighter per language, and the tokens of each block already highlighted
const highlighters = new Map<string, Promise<HighlighterGeneric<BundledLanguage, BundledTheme>>>();
const cache = new Map<string, Tokenized>();
const cacheKey = (code: string, language: BundledLanguage) => `${language}:${code.length}:${code.slice(0, 100)}:${code.slice(-100)}`;

const highlighter = async (language: BundledLanguage) => {
  const cached = highlighters.get(language);
  if (cached) return cached;
  // shiki loads with the first block it highlights, not with the app
  const made = import("shiki").then(async ({ createHighlighter }) => createHighlighter({ langs: [language], themes: ["github-light-high-contrast", "github-dark-high-contrast"] }));
  highlighters.set(language, made);
  return made;
};

const plain = (code: string): Tokenized => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) => (line === "" ? [] : [{ color: "inherit", content: line, offset: 0 }])),
});

const highlight = async (code: string, language: BundledLanguage): Promise<Tokenized> => {
  const key = cacheKey(code, language);
  const cached = cache.get(key);
  if (cached) return cached;
  const h = await highlighter(language);
  const result = h.codeToTokens(code, {
    lang: h.getLoadedLanguages().includes(language) ? language : "text",
    themes: { dark: "github-dark-high-contrast", light: "github-light-high-contrast" },
  });
  const tokenized = { bg: result.bg ?? "transparent", fg: result.fg ?? "inherit", tokens: result.tokens };
  cache.set(key, tokenized);
  return tokenized;
};

const CodeBlockBody = memo(({ tokenized, className }: { tokenized: Tokenized; className?: string }) => {
  const lines = useMemo(() => keyed(tokenized.tokens), [tokenized.tokens]);
  return (
    <pre
      className={cn("m-0 p-3 text-xs wrap-break-word whitespace-pre-wrap dark:bg-(--shiki-dark-bg)! dark:text-(--shiki-dark)!", className)}
      style={{ backgroundColor: tokenized.bg, color: tokenized.fg }}
    >
      <code className="font-mono text-xs">
        {lines.map((line) => (
          <LineSpan key={line.key} line={line} />
        ))}
      </code>
    </pre>
  );
});

CodeBlockBody.displayName = "CodeBlockBody";

export const CodeBlockContainer = ({ className, language, style, ...props }: HTMLAttributes<HTMLDivElement> & { language: string }) => (
  <div
    className={cn("group relative w-full overflow-hidden rounded-md border bg-background text-foreground", className)}
    data-language={language}
    style={{ containIntrinsicSize: "auto 200px", contentVisibility: "auto", ...style }}
    {...props}
  />
);

export const CodeBlockContent = ({ code, language }: { code: string; language: BundledLanguage }) => {
  const fallback = useMemo(() => cache.get(cacheKey(code, language)) ?? plain(code), [code, language]);
  const [highlighted, setHighlighted] = useState<{ code: string; tokens: Tokenized } | null>(null);

  useEffect(() => {
    let live = true;
    highlight(code, language).then(
      (tokens) => {
        if (live) setHighlighted({ code, tokens });
      },
      () => {
        // shiki failed to load: the plain text stays
      },
    );
    return () => {
      live = false;
    };
  }, [code, language]);

  return (
    <div className="relative overflow-auto">
      <CodeBlockBody tokenized={highlighted?.code === code ? highlighted.tokens : fallback} />
    </div>
  );
};

type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
};

export const CodeBlock = ({ code, language, className, children, ...props }: CodeBlockProps) => {
  const contextValue = useMemo(() => ({ code }), [code]);
  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer className={className} language={language} {...props}>
        {children}
        <CodeBlockContent code={code} language={language} />
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  timeout?: number;
};

export const CodeBlockCopyButton = ({ timeout = 2000, children, className, ...props }: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { code } = useContext(CodeBlockContext);

  const copy = async () => {
    if (isCopied) return;
    try {
      await navigator.clipboard.writeText(code);
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
    <Button aria-label="Copy code" className={cn("shrink-0", className)} onClick={() => void copy()} size="icon" variant="ghost" {...props}>
      {children ?? <Icon size={14} />}
    </Button>
  );
};
