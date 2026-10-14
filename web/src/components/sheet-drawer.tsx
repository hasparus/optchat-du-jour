// The app's one sheet: shadcn/ui's Drawer (vaul), dressed the way DESIGN.md's sheets are. From the
// bottom edge on a phone (vaul's grabber, a drag down closes it), from the right as a side panel on
// a wide screen. A title, a 40 px close button, and a description for screen readers; it traps
// focus, closes on Escape or a tap outside, and gives focus back to what opened it. Used by the
// composer's "Add context" and by the background-work sheet.
import { Drawer, DrawerClose, DrawerContent, DrawerDescription, DrawerHeader, DrawerTitle, DrawerTrigger } from "@/components/ui/drawer";
import { cn } from "@/lib/utils";
import { XIcon } from "lucide-react";
import { type ReactNode, useRef } from "react";

export type SheetDrawerProps = {
  readonly title: string;
  readonly description: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  // the control that opens it, rendered as the drawer's trigger (asChild)
  readonly trigger?: ReactNode;
  readonly side?: "bottom" | "right";
  readonly testId?: string;
  readonly className?: string;
  readonly children: ReactNode;
};

export function SheetDrawer({ title, description, open, onOpenChange, trigger, side = "bottom", testId, className, children }: SheetDrawerProps) {
  // what had focus when it opened (its trigger, or another control that opened it, like a status
  // line), given focus back when it closes, if it is still there and shown
  const opener = useRef<HTMLElement | null>(null);
  return (
    <Drawer direction={side} onOpenChange={onOpenChange} open={open}>
      {trigger !== undefined && <DrawerTrigger asChild>{trigger}</DrawerTrigger>}
      <DrawerContent
        className={cn(
          "border-0 bg-raised shadow-float outline-none",
          side === "bottom" ? "rounded-t-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" : "w-[min(24rem,90vw)] px-3 pt-[env(safe-area-inset-top)] sm:max-w-sm",
          className,
        )}
        data-testid={testId}
        onCloseAutoFocus={(e) => {
          const back = opener.current;
          opener.current = null;
          if (back?.isConnected && back.getClientRects().length > 0) {
            e.preventDefault();
            back.focus();
          }
        }}
        onOpenAutoFocus={() => {
          opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
        }}
      >
        <DrawerHeader className="flex-row items-center justify-between gap-2 p-2 text-left md:text-left">
          <DrawerTitle className="text-base tracking-tight">{title}</DrawerTitle>
          <DrawerDescription className="sr-only">{description}</DrawerDescription>
          <DrawerClose className="-mr-1 flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DrawerClose>
        </DrawerHeader>
        {children}
      </DrawerContent>
    </Drawer>
  );
}
