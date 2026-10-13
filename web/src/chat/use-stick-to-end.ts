// The dock (the composer and what sits on it) floats over the end of the transcript. This keeps the
// transcript's content clear of it: the dock's height goes to `--dock-h` on the chat's root, which
// pads the content below its last row and lifts the scroll-to-end button. The dock grows with an
// attachment tray, a longer draft or the tray above it, and the end of the content moves down by as
// much: a reader who was at the newest row should stay there. So when the dock grows, this scrolls
// to the end while `follow` holds: at the end, no turn running (the scroller then holds the sent
// message at the top, and following the end would undo that), no "show in chat" target pending.
import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

export function useStickToEnd(dock: RefObject<HTMLElement | null>, root: RefObject<HTMLElement | null>, follow: boolean, scrollToEnd: () => void) {
  // read by the observer, written after each render (never during one)
  const following = useRef(follow);
  useLayoutEffect(() => {
    following.current = follow;
  }, [follow]);
  useEffect(() => {
    const el = dock.current;
    const into = root.current;
    if (!el || !into) return;
    let height = el.offsetHeight;
    into.style.setProperty("--dock-h", `${height}px`);
    if (!("ResizeObserver" in globalThis)) return;
    const ro = new ResizeObserver(() => {
      const now = el.offsetHeight;
      into.style.setProperty("--dock-h", `${now}px`); // first, so the end below has moved
      if (now > height && following.current) scrollToEnd();
      height = now;
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [dock, root, scrollToEnd]);
}
