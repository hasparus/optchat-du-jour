// AI Elements' Message, as the October 2026 AI Elements build it
// (ui.shadcn.com/docs/ai-elements/radix/message), cut to the parts we use: MessageResponse,
// streaming markdown through Streamdown, and the actions under a reply, on shadcn/ui's
// MessageFooter, each a ghost icon button with its label as its name and in a Tooltip. The layout
// pieces (Message, MessageContent) come from shadcn's chat components, and the branch switcher is
// gone: the log has no branches (SPEC "Web UI"). The footer keeps the slot name message-actions:
// the tap-to-reveal on a touch screen (chat/row.tsx, index.css) finds the row by it.
import { Button } from "@/components/ui/button";
import { MessageFooter } from "@/components/ui/message";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { nativeShell } from "@/lib/shell";
import { cn } from "@/lib/utils";
import type { CodeHighlighterPlugin } from "@streamdown/code";
import type { ComponentProps } from "react";
import { memo } from "react";
import { harden } from "rehype-harden";
import { defaultRehypePlugins, Streamdown, type StreamdownProps } from "streamdown";

export type MessageActionsProps = ComponentProps<typeof MessageFooter>;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <MessageFooter className={cn("gap-1 px-0", className)} data-slot="message-actions" {...props}>
    {children}
  </MessageFooter>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  label: string;
};

export const MessageAction = ({ children, label, variant = "ghost", size = "icon-sm", ...props }: MessageActionProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button aria-label={label} size={size} type="button" variant={variant} {...props}>
        {children}
      </Button>
    </TooltipTrigger>
    <TooltipContent sideOffset={4}>{label}</TooltipContent>
  </Tooltip>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

// Streamdown's code highlighting, loaded with the first fenced block rather than with the app:
// shiki is most of its weight. Until it is in, a block shows as plain text.
let loaded: CodeHighlighterPlugin | null = null;
// GitHub's high-contrast pair: the default github-light sets strings and numbers in #e36209, 3.5:1
// on white, under WCAG AA's 4.5:1 for text
const THEMES: ReturnType<CodeHighlighterPlugin["getThemes"]> = ["github-light-high-contrast", "github-dark-high-contrast"];
let loading: Promise<CodeHighlighterPlugin> | null = null;
const loadCode = async () => {
  loading ??= import("@streamdown/code").then((m) => {
    loaded = m.code;
    return m.code;
  });
  try {
    return await loading;
  } catch (error) {
    loading = null; // offline, or the chunk is gone: the next block tries again
    throw error;
  }
};
const lazyCode: CodeHighlighterPlugin = {
  getSupportedLanguages: () => loaded?.getSupportedLanguages() ?? [],
  getThemes: () => THEMES,
  highlight: (options, callback) => {
    if (loaded) return loaded.highlight(options, callback);
    loadCode().then(
      (plugin) => {
        const result = plugin.highlight(options, callback);
        if (result) callback?.(result);
      },
      () => {
        // plain text it stays
      },
    );
    return null;
  },
  name: "shiki",
  supportsLanguage: (language) => loaded?.supportsLanguage(language) ?? true,
  type: "code-highlighter",
};
const plugins = { code: lazyCode };

// Model output never makes the phone fetch anything: images are blocked (rehype-harden shows their
// alt text instead), data: images too. Links stay, behind Streamdown's link check. This replaces
// Streamdown's own harden step, which allows every image.
const rehypePlugins: StreamdownProps["rehypePlugins"] = [
  ...Object.entries(defaultRehypePlugins).flatMap(([name, plugin]) => (name === "harden" ? [] : [plugin])),
  [harden, { allowDataImages: false, allowedImagePrefixes: [], allowedLinkPrefixes: ["*"], allowedProtocols: ["*"], defaultOrigin: undefined }],
];

// Streamdown's download buttons save a blob: URL through a link click. The iOS app's WebView has
// no downloads and loads nothing but the server's `/` in its top frame (mobile/src/server-url.ts),
// so there they would do nothing: inside the app they are hidden, and copy stays.
const NO_DOWNLOADS: StreamdownProps["controls"] = { code: { download: false }, image: { download: false }, mermaid: { download: false }, table: { download: false } };

// While a reply streams a caret marks its end (DESIGN.md, Motion); words are not faded in one by one,
// which would split the text into a span per word. Code blocks go without line numbers.
export const MessageResponse = memo(
  ({ className, isAnimating, ...props }: MessageResponseProps) => (
    <Streamdown
      caret={isAnimating === true ? "circle" : undefined}
      className={cn("size-full *:first:mt-0 *:last:mb-0", className)}
      controls={nativeShell() === undefined ? undefined : NO_DOWNLOADS}
      isAnimating={isAnimating}
      lineNumbers={false}
      plugins={plugins}
      rehypePlugins={rehypePlugins}
      {...props}
    />
  ),
  (prev, next) => prev.children === next.children && prev.isAnimating === next.isAnimating && prev.className === next.className,
);

MessageResponse.displayName = "MessageResponse";
