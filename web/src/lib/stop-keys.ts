// Keys that stop the running turn (SPEC "Web UI", Chat; docs/uniichat.md, small client items): Esc
// anywhere on the chat, and Enter in an empty composer (where send is Stop). Neither while something
// else owns the key: an input method composing, the artifact pane or a native select, or whatever
// already took it (Radix closes a sheet, a popover or a menu on Escape and marks the event handled).
// Pure: the chat's hook (chat/use-stop-keys.ts) and the composer ask it.

// what of a keyboard event is read here
export type KeyLike = {
  readonly key: string;
  readonly isComposing: boolean;
  readonly keyCode: number;
  readonly defaultPrevented: boolean;
  readonly repeat: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly target: EventTarget | null;
};

// where Escape belongs to what has focus: the artifact pane, a native select. What is open over the
// chat and closes on Escape (a sheet, a popover, a menu: Radix's) says so itself, by taking the
// event (defaultPrevented), as the composer's paste preview does.
const OWN_KEYS = "[data-keys='own'], select";

// An input method's keydown: still composing, or Safari's 229 for the key that ends it
const composing = (e: KeyLike) => e.isComposing || e.keyCode === 229;

const owned = (e: KeyLike) => {
  if (e.defaultPrevented || composing(e) || e.repeat) return true;
  const at = e.target instanceof Element ? e.target : null;
  return (at?.closest(OWN_KEYS) ?? null) !== null;
};

// Escape with no modifier, on a page where nothing else takes it
export const escapeStops = (e: KeyLike): boolean => e.key === "Escape" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !owned(e);

// Enter alone in a composer with nothing in it (no text, no attachment, no folded paste), on a
// keyboard: the composer's send is Stop then
export const emptyEnterStops = (e: KeyLike, o: { readonly empty: boolean; readonly touch: boolean }): boolean =>
  e.key === "Enter" && o.empty && !o.touch && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !owned(e);
