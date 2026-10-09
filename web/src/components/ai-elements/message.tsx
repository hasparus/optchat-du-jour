// AI Elements' Message (elements.ai-sdk.dev registry), cut to the parts we use: MessageResponse,
// streaming markdown through Streamdown, and the action buttons under a message. The layout
// pieces (Message, MessageContent) come from shadcn's chat components instead, and the branch
// switcher is gone: the log has no branches (SPEC "Web UI").
import { Button } from "@/components/ui/button";
import { nativeShell } from "@/lib/shell";
import { cn } from "@/lib/utils";
import type { CodeHighlighterPlugin } from "@streamdown/code";
import type { ComponentProps } from "react";
import { memo } from "react";
import { harden } from "rehype-harden";
import { defaultRehypePlugins, Streamdown, type StreamdownProps } from "streamdown";

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  label: string;
};

export const MessageAction = ({ children, label, variant = "ghost", size = "icon-sm", ...props }: MessageActionProps) => (
  <Button size={size} title={label} type="button" variant={variant} {...props}>
    {children}
    <span className="sr-only">{label}</span>
  </Button>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

// Streamdown's code highlighting, loaded with the first fenced block rather than with the app:
// shiki is most of its weight. Until it is in, a block shows as plain text.
let loaded: CodeHighlighterPlugin | null = null;
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
  getThemes: () => loaded?.getThemes() ?? ["github-light", "github-dark"],
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

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn("size-full *:first:mt-0 *:last:mb-0", className)}
      controls={nativeShell() === undefined ? undefined : NO_DOWNLOADS}
      plugins={plugins}
      rehypePlugins={rehypePlugins}
      {...props}
    />
  ),
  (prev, next) => prev.children === next.children && prev.isAnimating === next.isAnimating,
);

MessageResponse.displayName = "MessageResponse";
