// Keys that stop the running turn (SPEC "Web UI", Chat; docs/uniichat.md, small client items): Esc
// anywhere on the chat, and Enter in an empty composer (where send is Stop). Neither while something
// else owns the key: an input method composing, a dialog or a sheet, a menu or a list box, the
// artifact pane, or a component that already took it (Radix closes a popover on Escape and marks
// the event handled). Pure: the chat's hook (chat/use-stop-keys.ts) and the composer ask it.

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

// whatever is open over the chat and takes Escape for itself: a dialog (a sheet, a popover's content,
// the Add context sheet), a menu (the Model Selector), a list box
const OWNERS = "[role='dialog'], [role='alertdialog'], [aria-modal='true'], [role='menu'], [role='listbox']";
// where Escape belongs to what has focus: the artifact pane, a native select
const OWN_KEYS = "[data-keys='own'], select";

// An input method's keydown: still composing, or Safari's 229 for the key that ends it
const composing = (e: KeyLike) => e.isComposing || e.keyCode === 229;

const owned = (e: KeyLike, doc: Document) => {
  if (e.defaultPrevented || composing(e) || e.repeat) return true;
  const at = e.target instanceof Element ? e.target : null;
  if (at?.closest(OWN_KEYS)) return true;
  return doc.querySelector(OWNERS) !== null;
};

// Escape with no modifier, on a page where nothing else takes it
export const escapeStops = (e: KeyLike, doc: Document): boolean =>
  e.key === "Escape" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !owned(e, doc);

// Enter alone in a composer with nothing in it (no text, no attachment, no folded paste), on a
// keyboard: the composer's send is Stop then
export const emptyEnterStops = (e: KeyLike, doc: Document, o: { readonly empty: boolean; readonly touch: boolean }): boolean =>
  e.key === "Enter" && o.empty && !o.touch && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && !owned(e, doc);
