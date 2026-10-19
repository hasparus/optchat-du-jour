// From fx0 lib/draft-preview.ts (Apache-2.0, © Vercel, modified). An artifact's live draft (SPEC
// "Artifacts"): the page as the model writes it, cleaned so that nothing in it can run or load,
// then patched into one document so what is already drawn stays still as more streams in. The
// document is the server's /artifact/draft (no script may run in it, by its CSP and by the
// frame's sandbox); only the version the call saves runs its scripts, in the wrapper's frame.

// fx0's DRAFT_CSP: the draft document's own policy, kept on every document patched in
const DRAFT_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'";

// A template parses inertly but drops html/body wrappers. Capture their opening attributes
// separately, respecting quoted '>' and skipping raw script/style text.
function rootAttributes(html: string): Map<string, string> {
  const roots = new Map<string, string>();
  const lower = html.toLowerCase();
  const tags = /<!--[\s\S]*?(?:-->|$)|<([a-z][a-z0-9:-]*)\b/gi;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    if (!match[1]) continue;
    let end = tags.lastIndex;
    let quote = "";
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === html.length) break;
    const name = match[1].toLowerCase();
    if ((name === "html" || name === "body") && !roots.has(name)) roots.set(name, html.slice(tags.lastIndex, end));
    if (name === "script" || name === "style") {
      const closing = lower.indexOf(`</${name}`, end + 1);
      tags.lastIndex = closing === -1 ? html.length : closing;
    } else tags.lastIndex = end + 1;
  }
  return roots;
}

// every attribute that could run something or load from elsewhere goes
function clean(element: Element) {
  // by name, a list of its own: attributes are removed as it goes
  for (const attribute of element.getAttributeNames()) {
    const name = attribute.toLowerCase();
    const value = (element.getAttribute(attribute) ?? "").trim();
    const loads = ["src", "poster", "background"].includes(name) && !/^data:/i.test(value);
    const links = (name === "href" || name === "xlink:href") && !value.startsWith("#") && !(element.localName === "image" && /^data:image\//i.test(value));
    if (name.startsWith("on") || name === "target" || name === "srcdoc" || name === "srcset" || loads || links) element.removeAttribute(attribute);
  }
}

const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Model markup cannot execute scripts or fetch resources while being cleaned. */
export function draftDocument(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  for (const node of template.content.querySelectorAll("meta,base,script,noscript,iframe,frame,object,embed,form,animate,set,animateMotion,animateTransform")) node.remove();
  for (const node of template.content.querySelectorAll("*")) clean(node);
  const roots = rootAttributes(html);
  const attributes = (name: string) => {
    const wrapper = document.createElement("template");
    wrapper.innerHTML = `<div ${roots.get(name) ?? ""}></div>`;
    const element = wrapper.content.firstElementChild;
    if (!element) return "";
    clean(element);
    return [...element.attributes].map((attribute) => ` ${attribute.name}="${escapeAttribute(attribute.value)}"`).join("");
  };
  return `<!doctype html><html${attributes("html")}><head><meta http-equiv="Content-Security-Policy" content="${DRAFT_CSP}"><meta name="color-scheme" content="light dark"></head><body${attributes("body")}>${template.innerHTML}</body></html>`;
}

// by node type, not instanceof: the draft's nodes belong to the frame's document and window
const isElement = (n: Node): n is Element => n.nodeType === Node.ELEMENT_NODE;

function sameNode(a: Node, b: Node): boolean {
  if (a.nodeType !== b.nodeType) return false;
  if (!isElement(a) || !isElement(b)) return true;
  return a.namespaceURI === b.namespaceURI && a.localName === b.localName && a.id === b.id;
}

function patchNode(target: Node, source: Node) {
  if (!isElement(target) || !isElement(source)) {
    if (target.nodeValue !== source.nodeValue) target.nodeValue = source.nodeValue;
    return;
  }
  for (const name of target.getAttributeNames()) {
    if (!source.hasAttribute(name)) target.removeAttribute(name);
  }
  for (const attr of source.attributes) {
    if (target.getAttributeNS(attr.namespaceURI, attr.localName) !== attr.value) target.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
  }
  const keyed = new Map([...target.children].flatMap((child) => (child.id === "" ? [] : [[child.id, child] as const])));
  // a node goes before `current`, or at the end when there is none left
  const place = (node: ChildNode, before: ChildNode | null) => {
    if (before) before.before(node);
    else target.append(node);
  };
  let current = target.firstChild;
  // a list of its own: `source`'s live one is read as nodes are placed
  const wanted = [...source.childNodes];
  for (const desired of wanted) {
    if (!current || !sameNode(current, desired)) {
      const match = isElement(desired) ? keyed.get(desired.id) : undefined;
      if (match?.parentNode === target && sameNode(match, desired)) {
        place(match, current);
        current = match;
      } else {
        place(target.ownerDocument.importNode(desired, true), current);
        continue;
      }
    }
    patchNode(current, desired);
    current = current.nextSibling;
  }
  while (current) {
    const removed = current;
    current = current.nextSibling;
    removed.remove();
  }
}

// Only sanitized, scriptless markup enters the existing sandboxed document. Unchanged elements,
// styles, scroll position and the browsing context survive.
export function patchDraftDocument(target: Document, html: string): void {
  const source = new DOMParser().parseFromString(draftDocument(html), "text/html");
  patchNode(target.documentElement, source.documentElement);
}

// A cut that ends before any body content renders as a blank page, so the draft only takes over
// once the body has started (fx0's preview-pane `renderable`).
export function renderable(html: string): boolean {
  const body = /<body[^>]*>/i.exec(html);
  return body !== null && /<[a-z]/i.test(html.slice(body.index + body[0].length));
}
