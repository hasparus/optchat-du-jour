// From fx0 lib/design-artifact.ts (Apache-2.0, © Vercel, modified). An artifact (SPEC "Artifacts")
// is one self-contained HTML file: what it may hold (`validateArtifactHtml`), the CSP it runs
// under, and the bootstrap put in front of its own markup when it is shown (`prepareArtifactHtml`):
// WebRTC gone, a heartbeat for the wrapper, and links opened through the parent.

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

function artifactBootstrap(readyToken?: string): string {
  // The sandbox grants no popups, so a clicked https link asks the trusted wrapper to open it
  // (server/routes/artifacts.ts) instead of navigating the preview away.
  const heartbeat = readyToken
    ? `const token=${JSON.stringify(readyToken)};const send=type=>parent.postMessage({type,token},"*");send("heartbeat");setInterval(()=>send("heartbeat"),500);addEventListener("load",()=>{send("ready");requestAnimationFrame(()=>requestAnimationFrame(()=>send("painted")))},{once:true});addEventListener("click",event=>{const link=event.target instanceof Element&&event.target.closest("a[href]");const url=link?link.getAttribute("href")||"":"";if(/^https:/i.test(url)){event.preventDefault();parent.postMessage({type:"open",token,url},"*")}},true);`
    : "";
  return `<script>(()=>{for(const name of ["RTCPeerConnection","webkitRTCPeerConnection","RTCIceGatherer"]){try{Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false})}catch{}}${heartbeat}})()</script>`;
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
  ["object", "<object> elements"],
  ["embed", "<embed> elements"],
]);

function findTagEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index;
    }
  }
  return -1;
}

function parseAttributes(source: string): Pick<HtmlTag, "attributes" | "duplicateAttribute"> {
  const attributes = new Map<string, string>();
  let duplicateAttribute: string | null = null;
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = (match[1] ?? "").toLowerCase();
    if (attributes.has(name)) {
      duplicateAttribute ??= name;
      continue;
    }
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return { attributes, duplicateAttribute };
}

function parseOpeningTags(source: string): HtmlTag[] {
  const tags: HtmlTag[] = [];
  const normalized = source.toLowerCase();
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf("<", cursor);
    if (start === -1) break;
    if (source.startsWith("<!--", start)) {
      const end = source.indexOf("-->", start + 4);
      cursor = end === -1 ? source.length : end + 3;
      continue;
    }
    const marker = source[start + 1];
    if (!marker || marker === "/" || marker === "!" || marker === "?") {
      cursor = start + 2;
      continue;
    }
    const nameMatch = /^([a-z][a-z0-9:-]*)/i.exec(source.slice(start + 1));
    if (!nameMatch) {
      cursor = start + 1;
      continue;
    }
    const end = findTagEnd(source, start + 1 + nameMatch[0].length);
    if (end === -1) break;
    const name = (nameMatch[1] ?? "").toLowerCase();
    const attributeSource = source.slice(start + 1 + nameMatch[0].length, end);
    tags.push({ name, ...parseAttributes(attributeSource) });
    if (name === "script" || name === "style") {
      const closing = normalized.indexOf(`</${name}`, end + 1);
      cursor = closing === -1 ? source.length : closing;
    } else {
      cursor = end + 1;
    }
  }
  return tags;
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
    if (name === "action" || name === "formaction") return `artifact must not contain ${name} attributes`;
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

  for (const tag of parseOpeningTags(source)) {
    const error = validateTag(tag);
    if (error) return { error, ok: false };
  }
  return { bytes, ok: true };
}
