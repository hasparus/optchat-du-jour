// From fx0 lib/design-artifact.ts (Apache-2.0, © Vercel, modified).
// Changed from fx0's: the tags are read by HTMLRewriter, not fx0's tokenizer; CSS and ping are
// checked; frames are refused at run time (frame-guard.ts); the bootstrap is functions
// (bootstrap.ts), not a template string. An artifact (SPEC "Artifacts") is one
// self-contained HTML file: what it may hold (`validateArtifactHtml`), the CSP it runs
// under, and the bootstrap put in front of its own markup when it is shown (`prepareArtifactHtml`):
// WebRTC gone, a heartbeat for the wrapper, and links opened through the parent.

import { heartbeat, noWebRtc } from "./bootstrap.ts";
import { frameGuard, noScripts } from "./frame-guard.ts";

// at most this many UTF-8 bytes in one version
export const MAX_ARTIFACT_BYTES = 512 * 1024;

// The policy an artifact's page runs under, as a meta tag in front of its markup and as the
// page's own header (server/routes/artifacts.ts): inline scripts and styles, embedded data: assets,
// and nothing that loads or sends anything.
export const ARTIFACT_EMBEDDED_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

// A function of bootstrap.ts or frame-guard.ts as a statement of the page's script: its source
// (Function.prototype.toString: what Bun transpiled), called with these arguments as JSON, each
// `<` escaped so that no argument can end the script element
export const inline = <A extends readonly string[]>(run: (...args: A) => void, ...args: A) =>
  `(${run.toString()})(${args.map((a) => JSON.stringify(a).replaceAll("<", String.raw`\u003c`)).join(",")});`;

// WebRTC gone, then no frames of the page's own (frame-guard.ts): both before any script of the
// page can run, and if the guard can't be set up, none of them runs (noScripts). A source with
// `</` or `<!--` in it could end or bend the script element; none has.
const GUARD = `${inline(noWebRtc)}try{${inline(frameGuard)}}catch{${inline(noScripts)}}`;
if (GUARD.includes("</") || GUARD.includes("<!--")) throw new Error("the artifact bootstrap's source would end its script element");

// The script put in front of the artifact's own markup: the guard, then fx0's heartbeat for the
// wrapper, links opened through it
export function artifactBootstrap(readyToken?: string): string {
  return `<script>${GUARD}${readyToken === undefined ? "" : inline(heartbeat, readyToken)}</script>`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// the artifact as its page serves it: the CSP and the bootstrap right after the doctype, before
// any of its own markup can run
export function prepareArtifactHtml(html: string, embeddedCsp?: string, readyToken?: string): string {
  const csp = embeddedCsp ? `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(embeddedCsp)}">` : "";
  return html.replace(/^(\s*<!doctype\s+html\s*>)/i, `$1${csp}${artifactBootstrap(readyToken)}`);
}

export type ArtifactValidation = { readonly ok: true; readonly bytes: number } | { readonly ok: false; readonly error: string };

type HtmlTag = {
  readonly name: string;
  readonly attributes: Map<string, string>;
  readonly duplicateAttribute: string | null;
};

const PROHIBITED_TAGS = new Map([
  ["base", "<base> elements"],
  ["form", "forms"],
  ["iframe", "<iframe> elements"],
  ["frame", "<frame> elements"],
  ["frameset", "<frameset> elements"],
  ["fencedframe", "<fencedframe> elements"],
  ["portal", "<portal> elements"],
  ["object", "<object> elements"],
  ["embed", "<embed> elements"],
]);

// Every opening tag of the page, as a browser's parser reads them, and the text of its <style>
// elements. fx0 walked the tags with a tokenizer of its own, which a browser can disagree with (a
// quote inside an attribute's name hid the rest of a tag; <svg>'s <script> and <style> are not raw
// text, so a tag inside them breaks out): Bun's HTMLRewriter is lol-html, a spec tokenizer that
// follows foreign content. Null when it can't read the page at all.
function parsePage(source: string): { readonly tags: readonly HtmlTag[]; readonly styles: readonly string[] } | null {
  const tags: HtmlTag[] = [];
  const styles: string[] = [];
  let style = "";
  try {
    new HTMLRewriter()
      .on("*", {
        element: (element) => {
          const attributes = new Map<string, string>();
          let duplicateAttribute: string | null = null;
          for (const [raw, value] of element.attributes) {
            const name = raw.toLowerCase();
            if (attributes.has(name)) duplicateAttribute ??= name;
            else attributes.set(name, value);
          }
          tags.push({ attributes, duplicateAttribute, name: element.tagName.toLowerCase() });
        },
      })
      .on("style", {
        text: (chunk) => {
          style += chunk.text;
          if (chunk.lastInTextNode) {
            styles.push(style);
            style = "";
          }
        },
      })
      .transform(source);
  } catch {
    return null;
  }
  return { styles, tags };
}

function decodeCodePoint(digits: string, radix: number): string {
  const codePoint = Number.parseInt(digits, radix);
  return codePoint <= 0x10_FF_FF ? String.fromCodePoint(codePoint) : "\uFFFD";
}

const ENTITIES = new Map([
  ["amp", "&"],
  ["colon", ":"],
  ["newline", "\n"],
  ["tab", "\t"],
]);

function decodeAttribute(value: string): string {
  return value
    .replaceAll(/&#x([0-9a-f]+);?/gi, (_, digits: string) => decodeCodePoint(digits, 16))
    .replaceAll(/&#([0-9]+);?/g, (_, digits: string) => decodeCodePoint(digits, 10))
    .replaceAll(/&(colon|tab|newline|amp);?/gi, (_, entity: string) => ENTITIES.get(entity.toLowerCase()) ?? "")
    .trim();
}

function compactUrlScheme(value: string): string {
  // oxlint-disable-next-line no-control-regex -- the controls a browser skips in a URL's scheme
  return decodeAttribute(value).replaceAll(/[\u0000- \u007F]+/g, "").toLowerCase();
}

function isEmbeddedSource(tag: string, value: string): boolean {
  const decoded = decodeAttribute(value);
  if (tag === "img" || tag === "input") return /^data:image\//i.test(decoded);
  if (tag === "audio") return /^data:audio\//i.test(decoded);
  if (tag === "video") return /^data:video\//i.test(decoded);
  if (tag === "track") return /^data:text\/vtt(?:[;,]|$)/i.test(decoded);
  if (tag === "source") return /^data:(?:image|audio|video)\//i.test(decoded);
  return false;
}

function isEmbeddedSrcset(tag: string, value: string): boolean {
  if (tag !== "img" && tag !== "source") return false;
  const decoded = decodeAttribute(value);
  const comma = decoded.indexOf(",");
  if (comma === -1 || decoded.includes(",", comma + 1)) return false;
  const metadata = decoded.slice(0, comma);
  const payload = decoded.slice(comma + 1);
  return /^data:image\/[a-z0-9.+-]+(?:;[^,\s]*)*$/i.test(metadata) && /^\S+(?:\s+\d+(?:\.\d+)?[wx])?$/.test(payload);
}

// CSS escapes decoded (`\75 rl(` is url(), as a browser reads it)
const cssText = (css: string) =>
  css.replaceAll(/\\([0-9a-f]{1,6})\s?/gi, (_, hex: string) => decodeCodePoint(hex, 16)).replaceAll(/\\(.)/g, "$1");

// What a style sheet or a style attribute would load: an @import, or a url() or image-set() of
// anything but an embedded data: URL or a fragment (ours: fx0 checked no CSS; the CSP stops these
// loads anyway, this keeps them out of a saved version)
function cssProblem(css: string): string | null {
  const text = cssText(css);
  if (/@import/i.test(text)) return "artifact styles must not @import";
  for (const found of text.matchAll(/url\(\s*(["']?)([^"')]*)\1\s*\)/gi)) {
    const target = (found[2] ?? "").trim();
    if (!/^(?:data:|#)/i.test(target)) return "artifact styles may load only embedded data: URLs";
  }
  for (const found of text.matchAll(/image-set\(([^)]*)\)/gi)) {
    for (const quoted of (found[1] ?? "").matchAll(/(["'])(.*?)\1/g)) {
      if (!/^data:/i.test(quoted[2] ?? "")) return "artifact styles may load only embedded data: URLs";
    }
  }
  return null;
}

function validateTag(tag: HtmlTag): string | null {
  if (tag.duplicateAttribute) return `artifact must not repeat the ${tag.duplicateAttribute} attribute`;

  const prohibited = PROHIBITED_TAGS.get(tag.name);
  if (prohibited) return `artifact must not contain ${prohibited}`;
  if (tag.name === "script" && tag.attributes.has("src")) return "artifact scripts must be inline";

  if (tag.name === "meta" && decodeAttribute(tag.attributes.get("http-equiv") ?? "").toLowerCase() === "refresh") {
    return "artifact must not contain meta refresh";
  }

  for (const [name, rawValue] of tag.attributes) {
    const compactValue = compactUrlScheme(rawValue);
    if (compactValue.startsWith("javascript:") || compactValue.startsWith("vbscript:")) return "artifact must not use scripted URLs";
    if (name === "action" || name === "formaction" || name === "ping") return `artifact must not contain ${name} attributes`;
    // a declarative shadow root is attached by the parser, where the frame guard's observer can't see
    if (name === "shadowrootmode" || name === "shadowroot") return "artifact must not contain declarative shadow roots";
    if (name === "style") {
      const problem = cssProblem(decodeAttribute(rawValue));
      if (problem) return problem;
    }
    if (name === "href" || name === "xlink:href") {
      const value = decodeAttribute(rawValue);
      const isSafeSvgImage = tag.name === "image" && /^data:image\//i.test(value);
      // links to https pages (cited sources, references) open in a new tab; see the bootstrap
      const isExternalLink = tag.name === "a" && name === "href" && /^https:\/\/\S+$/i.test(value);
      if (!value.startsWith("#") && !isSafeSvgImage && !isExternalLink) {
        return `artifact ${name} values must be local fragments, https links, or compatible embedded data: URLs`;
      }
    }
    if (name === "src" && !isEmbeddedSource(tag.name, rawValue)) return "artifact src values must use a compatible embedded data: URL";
    if (name === "srcset" && !isEmbeddedSrcset(tag.name, rawValue)) return "artifact srcset values must contain one embedded data:image URL";
    if (name === "poster" && !/^data:image\//i.test(decodeAttribute(rawValue))) return "artifact poster values must use an embedded data:image URL";
  }
  return null;
}

// Whether `html` is an artifact we keep and show: one complete document with a head and a body,
// at most MAX_ARTIFACT_BYTES, nothing that loads from elsewhere or navigates. The error is said to
// the model as its tool's error, worded so it can fix the page.
export function validateArtifactHtml(html: string): ArtifactValidation {
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_ARTIFACT_BYTES) return { error: "artifact exceeds 512 KiB", ok: false };

  const source = html.trim();
  if (source.includes("<!--")) return { error: "artifact must not contain HTML comments", ok: false };
  if (!/^<!doctype\s+html\s*>/i.test(source)) return { error: "artifact must start with <!doctype html>", ok: false };
  const afterDoctype = source.replace(/^<!doctype\s+html\s*>/i, "");
  if (/<[!?]/.test(afterDoctype)) return { error: "artifact must not contain markup declarations", ok: false };

  for (const tag of ["html", "head", "body"] as const) {
    const openings = source.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi"))?.length ?? 0;
    const closings = source.match(new RegExp(`</${tag}\\s*>`, "gi"))?.length ?? 0;
    if (openings !== 1 || closings !== 1) return { error: `artifact must contain exactly one <${tag}> element`, ok: false };
  }

  if (!/<html(?:\s[^>]*)?>[\s\S]*<head(?:\s[^>]*)?>[\s\S]*<\/head\s*>[\s\S]*<body(?:\s[^>]*)?>[\s\S]*<\/body\s*>[\s\S]*<\/html\s*>\s*$/i.test(source)) {
    return { error: "artifact must be one complete html document with head and body", ok: false };
  }

  const parsed = parsePage(source);
  if (parsed === null) return { error: "artifact could not be parsed as HTML", ok: false };
  for (const tag of parsed.tags) {
    const error = validateTag(tag);
    if (error) return { error, ok: false };
  }
  for (const style of parsed.styles) {
    const error = cssProblem(style);
    if (error) return { error, ok: false };
  }
  return { bytes, ok: true };
}
