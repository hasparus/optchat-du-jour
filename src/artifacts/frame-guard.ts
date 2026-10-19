// No frame of the artifact's own, ever (SPEC "Artifacts"; ours, not fx0's). The bootstrap takes
// WebRTC's constructors from the page's window (bootstrap.ts), but a frame the page makes (a srcdoc
// frame: frame-src can't stop it, nothing is fetched) would have a window of its own with them, and
// STUN reaches any host; Chromium ignores CSP's `webrtc 'block'`. So every iframe, frame,
// fencedframe, object, embed or portal is taken out of the document by a MutationObserver before
// its document commits (the observer runs at the microtask checkpoint; a frame's navigation commits
// in a task of its own, later), and the same is done in every shadow root. createElement refuses
// those tags outright, and document.open and document.write are refused (the observer would still
// see what they write, but a page has no need of them). A frame's window is no way around it in
// the meantime: the frame is sandboxed as the page is, so its window is another origin's.
//
// It runs in the artifact's page, not here: html.ts inlines it with Function.prototype.toString, so
// each function may use only globals, its parameters and its own locals (a type of this module is
// erased, so it is fine; a value, an import or a helper is not), and test/artifacts.test.ts runs it
// from its source alone, minified too. Every native it calls later is taken before the page's own
// script can replace it, and called with the Reflect.apply it took: nothing a page script can reach
// (a prototype's method or getter, an iterator, an array's setter, Set or String) is looked up
// after the bootstrap.

// The page's DOM, as much of it as these functions take, declared for this module alone: this
// repo's TypeScript is Bun's, and lib.dom's own fetch and WebSocket would clash with it. Methods
// are written as properties with their `this`, as the guard calls them: taken off the prototype.
interface Node {
  readonly nodeType: number;
  readonly parentNode: Node | null;
  readonly removeChild: (this: Node, child: Node) => Node;
}
interface Element extends Node {
  readonly localName: string;
  readonly namespaceURI: string | null;
  readonly attachShadow: (this: Element, init: ShadowRootInit) => Node;
  readonly setAttribute: (this: Element, name: string, value: string) => void;
}
type ShadowRootInit = { readonly mode: "closed" | "open" };
interface NodeList {
  readonly length: number;
  readonly item: (this: NodeList, index: number) => Node | null;
}
interface MutationRecord {
  readonly addedNodes: NodeList;
}
interface TreeWalker {
  readonly nextNode: (this: TreeWalker) => Node | null;
}
type ElementCreationOptions = { readonly is?: string };
interface Document extends Node {
  readonly createTreeWalker: (this: Document, root: Node, whatToShow: number) => TreeWalker;
  readonly createElement: (this: Document, name: string, init?: ElementCreationOptions) => Element;
  readonly createElementNS: (this: Document, namespace: string | null, name: string, init?: ElementCreationOptions) => Element;
  readonly head: { readonly append: (node: Node) => void };
}
type MutationObserverInit = { childList?: boolean; subtree?: boolean };
interface MutationObserver {
  readonly observe: (this: MutationObserver, target: Node, options: MutationObserverInit) => void;
}
// what fix() replaces: a prototype's (or Document's own) property, with a function of ours
type Replacement = (this: never, ...args: never[]) => Node;
interface ShadowRoot {
  readonly setHTMLUnsafe?: Replacement;
}
type Owner = Element | Document | ShadowRoot | typeof Document;
declare const Node: { readonly prototype: Node };
declare const Element: { readonly prototype: Element };
declare const ShadowRoot: { readonly prototype: ShadowRoot };
declare const NodeList: { readonly prototype: NodeList };
declare const MutationRecord: { readonly prototype: MutationRecord };
declare const TreeWalker: { readonly prototype: TreeWalker };
declare const Document: { readonly prototype: Document; readonly parseHTMLUnsafe?: Replacement };
declare const MutationObserver: { readonly prototype: MutationObserver; new (callback: (records: readonly MutationRecord[]) => void): MutationObserver };
declare const document: Document;

export function frameGuard(): void {
  const { apply } = Reflect;
  // oxlint-disable-next-line typescript/unbound-method -- taken now, called later with no `this`
  const { defineProperty: define, getOwnPropertyDescriptor: describe, setPrototypeOf } = Object;
  const Refusal = DOMException;
  const doc = document;
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- inlined by its source: it may use nothing outside the guard
  const getter = <T, K extends keyof T & string>(owner: T, name: K): ((this: T) => T[K]) => {
    // oxlint-disable-next-line typescript/unbound-method -- the getter itself, called later with Reflect.apply
    const got = describe(owner, name)?.get;
    if (got === undefined) throw new TypeError(`no ${name} getter`);
    return got;
  };
  const XHTML = "http://www.w3.org/1999/xhtml";
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- inlined by its source: it may use nothing outside the guard
  const isFrameName = (name: string) => name === "iframe" || name === "frame" || name === "fencedframe" || name === "object" || name === "embed" || name === "portal";
  // oxlint-disable-next-line typescript/unbound-method -- taken now, called later with Reflect.apply
  const { lastIndexOf, slice, toLowerCase } = String.prototype;
  const toText = String;

  const Observer = MutationObserver;
  const { observe } = Observer.prototype;
  const { removeChild } = Node.prototype;
  const parentOf = getter(Node.prototype, "parentNode");
  const typeOf = getter(Node.prototype, "nodeType");
  const localNameOf = getter(Element.prototype, "localName");
  const namespaceOf = getter(Element.prototype, "namespaceURI");
  const addedOf = getter(MutationRecord.prototype, "addedNodes");
  const lengthOf = getter(NodeList.prototype, "length");
  const { item } = NodeList.prototype;
  const { createTreeWalker } = Document.prototype;
  const { nextNode } = TreeWalker.prototype;
  const { attachShadow } = Element.prototype;
  const { createElement, createElementNS } = Document.prototype;

  // nodeType 1 is ELEMENT_NODE, and only an Element has it
  const isElement = (node: Node): node is Element => apply(typeOf, node, []) === 1;
  const framing = (node: Node) => isElement(node) && apply(namespaceOf, node, []) === XHTML && isFrameName(apply(localNameOf, node, []));
  const drop = (node: Node) => {
    const parent = apply(parentOf, node, []);
    if (parent) apply(removeChild, parent, [node]);
  };
  // the node, or every frame under it (found first, then dropped: dropping moves the walker)
  const sweep = (node: Node) => {
    const type = apply(typeOf, node, []);
    if (type !== 1 && type !== 11) return;
    if (framing(node)) {
      drop(node);
      return;
    }
    // no prototype: a setter the page puts on Array.prototype or Object.prototype can't eat a find
    const found: Record<number, Node> = {};
    setPrototypeOf(found, null);
    let count = 0;
    const walker = apply(createTreeWalker, doc, [node, 1]);
    for (let next = apply(nextNode, walker, []); next; next = apply(nextNode, walker, [])) {
      if (framing(next)) {
        found[count] = next;
        count++;
      }
    }
    for (let k = 0; k < count; k++) {
      const frame = found[k];
      if (frame) drop(frame);
    }
  };
  const observer = new Observer((records) => {
    // by index: the page can replace an array's iterator, not its own elements
    // oxlint-disable-next-line typescript/prefer-for-of -- see above
    for (let r = 0; r < records.length; r++) {
      const record = records[r];
      if (record === undefined) continue;
      const added = apply(addedOf, record, []);
      const count = apply(lengthOf, added, []);
      for (let k = 0; k < count; k++) {
        const node = apply(item, added, [k]);
        if (node) sweep(node);
      }
    }
  });
  // made now and with no prototype: the options are read on every observe, and an
  // Object.prototype.characterDataOldValue would make that throw, leaving a shadow root unwatched
  const options: MutationObserverInit = { childList: true, subtree: true };
  setPrototypeOf(options, null);
  const watch = (root: Node) => {
    apply(observe, observer, [root, options]);
  };
  watch(doc);

  const fix = (owner: Owner, name: string, value: Replacement) => {
    define(owner, name, { configurable: false, value, writable: false });
  };
  const refuse = (what: string) => () => {
    throw new Refusal(`no ${what} in an artifact`, "NotSupportedError");
  };
  fix(Element.prototype, "attachShadow", function attach(this: Element, init: ShadowRootInit) {
    const root = apply(attachShadow, this, [init]);
    watch(root);
    return root;
  });
  // declarative shadow roots would come in unobserved: their markup is refused (html.ts), and so
  // is every way to parse one from a script
  if ("setHTMLUnsafe" in Element.prototype) fix(Element.prototype, "setHTMLUnsafe", refuse("declarative shadow roots"));
  if ("setHTMLUnsafe" in ShadowRoot.prototype) fix(ShadowRoot.prototype, "setHTMLUnsafe", refuse("declarative shadow roots"));
  if ("parseHTMLUnsafe" in Document) fix(Document, "parseHTMLUnsafe", refuse("declarative shadow roots"));
  for (const name of ["open", "write", "writeln"]) fix(Document.prototype, name, refuse("document.open or document.write"));
  fix(Document.prototype, "createElement", function create(this: Document, name: string, init?: ElementCreationOptions) {
    const text = toText(name);
    if (isFrameName(apply(toLowerCase, text, []))) refuse("frames")();
    return apply(createElement, this, [text, init]);
  });
  fix(Document.prototype, "createElementNS", function createNS(this: Document, namespace: string | null, name: string, init?: ElementCreationOptions) {
    const text = toText(name);
    if (isFrameName(apply(toLowerCase, apply(slice, text, [apply(lastIndexOf, text, [":"]) + 1]), []))) refuse("frames")();
    return apply(createElementNS, this, [namespace, text, init]);
  });
}

// When the guard can't be set up (a browser without one of the natives it takes), no script of
// the page runs at all: a page with frames unguarded is not shown, not shown unguarded. A CSP meta
// tag put in the head by a script holds for every script parsed after it.
export function noScripts(): void {
  const policy = document.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute("content", "script-src 'none'");
  document.head.append(policy);
}
