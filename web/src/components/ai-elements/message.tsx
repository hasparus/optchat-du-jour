// AI Elements' Message (elements.ai-sdk.dev registry), cut to the parts we use: MessageResponse,
// streaming markdown through Streamdown, and the action buttons under a message. The layout
// pieces (Message, MessageContent) come from shadcn's chat components instead, and the branch
// switcher is gone: the log has no branches (SPEC "Web UI").
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { code } from "@streamdown/code";
import type { ComponentProps } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";

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

const plugins = { code };

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown className={cn("size-full *:first:mt-0 *:last:mb-0", className)} plugins={plugins} {...props} />
  ),
  (prev, next) => prev.children === next.children && prev.isAnimating === next.isAnimating,
);

MessageResponse.displayName = "MessageResponse";
