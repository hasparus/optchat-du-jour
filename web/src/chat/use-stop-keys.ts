// Esc stops the running turn (lib/stop-keys.ts says when it may): heard on the document while a
// turn runs and the chat is the tab shown, so it works wherever focus is on the chat, the composer
// included, and the existing stop path (the link's abort) does the stopping.
import { escapeStops } from "@/lib/stop-keys";
import { type RefObject, useEffect } from "react";

// the chat's tab is shown: its panel is not the inactive one (it stays mounted while another tab is open)
const shown = (el: HTMLElement) => el.closest("[role='tabpanel'][data-state='inactive']") === null;

export function useStopKeys(running: boolean, stop: () => void, root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!running) return;
    const down = (e: KeyboardEvent) => {
      const el = root.current;
      if (!el || !shown(el) || !escapeStops(e, document)) return;
      e.preventDefault();
      stop();
    };
    document.addEventListener("keydown", down);
    return () => {
      document.removeEventListener("keydown", down);
    };
  }, [running, stop, root]);
}
