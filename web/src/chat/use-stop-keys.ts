// Esc stops the running turn (lib/stop-keys.ts says when it may): heard on the document while a
// turn runs and the chat is the tab shown (`active`, the app's), so it works wherever focus is on
// the chat, the composer included, and the existing stop path (the link's abort) does the stopping.
import { escapeStops } from "@/lib/stop-keys";
import { useEffect } from "react";

export function useStopKeys(active: boolean, stop: () => void) {
  useEffect(() => {
    if (!active) return;
    const down = (e: KeyboardEvent) => {
      if (!escapeStops(e)) return;
      e.preventDefault();
      stop();
    };
    document.addEventListener("keydown", down);
    return () => {
      document.removeEventListener("keydown", down);
    };
  }, [active, stop]);
}
