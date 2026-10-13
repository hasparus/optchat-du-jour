// The composer grows with an attachment tray, a longer draft or the tray above it, and the chat's
// view shrinks by as much: a reader who was at the newest row should stay there. This watches the
// element under the chat (the dock) and scrolls to the end when it grows, while `follow` holds: at
// the end, no turn running (the scroller then holds the sent message at the top, and following the
// end would undo that), no "show in chat" target pending.
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

export function useStickToEnd(dock: RefObject<HTMLElement | null>, follow: boolean, scrollToEnd: () => void) {
  // read by the observer, written after each render (never during one)
  const following = useRef(follow);
  useLayoutEffect(() => {
    following.current = follow;
  }, [follow]);
  useEffect(() => {
    const el = dock.current;
    if (!el || !("ResizeObserver" in globalThis)) return;
    let height = el.offsetHeight;
    const ro = new ResizeObserver(() => {
      const now = el.offsetHeight;
      if (now > height && following.current) scrollToEnd();
      height = now;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [dock, scrollToEnd]);
}
