// From fx0 app/api/artifact-frame/route.ts and app/api/artifact/route.ts (Apache-2.0, © Vercel, modified).
// The artifacts over HTTP (SPEC "Artifacts"), behind the same guard as every route (server/auth.ts).
// An artifact is model-written HTML that runs scripts, so this origin never renders it as itself:
//   GET /artifact/frame?name&v   the wrapper: our own page, no artifact markup in it. It frames the
//                                page below in an iframe sandboxed to allow-scripts only (an opaque
//                                origin: no cookies, storage, parent or our WebSocket), keeps it
//                                alive by its heartbeat, and opens an https link it asks for in a
//                                new tab, only during the click that asked
//   GET /artifact/page?name&v&token  the artifact with fx0's CSP and bootstrap in front of its own
//                                markup, served under a CSP header that sandboxes it again and lets
//                                nothing load or connect, framed only by the wrapper
//   GET /artifact/draft          the empty scriptless document a live draft is drawn into (web/src
//                                /lib/draft-preview.ts); no scripts run in it
//   GET /api/artifact?name&v     the HTML itself, for copy and download: plain text, an
//                                attachment, `default-src 'none'; sandbox` and nosniff
//   GET /api/artifacts           every artifact and its versions (src/wire.ts ArtifactList)
// fx0 frames the artifact as a data: URL; the iOS app's WebView loads no data: frame (E27), so ours
// is a page of this server's, sandboxed by its iframe and by its own header alike. A name is
// checked as a name (src/artifacts/store.ts ARTIFACT_NAME) before it goes near the disk, and an
// unknown or malformed name or version is a 404, the same either way.
import { Effect } from "effect";
import { type HttpRouter, HttpServerResponse } from "effect/http";
import { ARTIFACT_EMBEDDED_CSP, prepareArtifactHtml } from "../../src/artifacts/html.ts";
import { ARTIFACT_NAME, type Artifacts } from "../../src/artifacts/store.ts";
import { ArtifactList } from "../../src/wire.ts";

// the wrapper's own policy: its inline script and style, and frames of the artifact page only
export const wrapperCsp = (host: string) =>
  [
    "default-src 'none'",
    `frame-src ${host}/artifact/page`,
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
// the artifact page's: sandboxed to scripts alone whoever frames or opens it, fx0's embedded
// policy as a header too, and framed only by this origin (the wrapper)
export const PAGE_CSP = `sandbox allow-scripts; ${ARTIFACT_EMBEDDED_CSP}; frame-ancestors 'self'`;
// the HTML as a file: never rendered here
export const RAW_CSP = "default-src 'none'; sandbox";
// the live draft's document: styles and embedded assets, no script at all (fx0's DRAFT_CSP)
export const DRAFT_CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
export const PERMISSIONS =
  "accelerometer=(), camera=(), clipboard-read=(), clipboard-write=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=()";
const SHARED = { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" };

// fx0's EMPTY_DRAFT_DOCUMENT: what a draft is patched into (its own CSP is the header's twin)
export const EMPTY_DRAFT_DOCUMENT = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${DRAFT_CSP.replace("; frame-ancestors 'self'", "")}"><meta name="color-scheme" content="light dark"></head><body></body></html>`;

const TOKEN = /^[0-9a-f-]{36}$/;
const notFound = () => HttpServerResponse.empty({ status: 404 });

// `name` and `v` from the query: a name as names go, and a version as a whole number from 1; v
// left out is the latest. Null for anything else.
const wanted = (url: string) => {
  const q = new URL(url, "http://x").searchParams;
  const name = q.get("name") ?? "";
  const raw = q.get("v");
  const v = raw === null || raw === "" ? undefined : Number(raw);
  if (!ARTIFACT_NAME.test(name) || (v !== undefined && (!Number.isSafeInteger(v) || v < 1))) return null;
  return { name, token: q.get("token"), v };
};

// The wrapper's page (fx0's artifact-frame), the artifact page's address in it. It paints nothing
// of its own, so an artifact that has not painted yet shows the app's background.
const wrapperPage = (pageUrl: string, token: string) => `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Artifact preview</title>
<style>:root{color-scheme:light dark}html,body,#frame-root,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden}</style>
</head>
<body>
<div id="frame-root"></div>
<script>
const artifact=${JSON.stringify(pageUrl)};
const token=${JSON.stringify(token)};
const frame=document.createElement('iframe');
frame.title='Artifact';
frame.setAttribute('sandbox','allow-scripts');
frame.referrerPolicy='no-referrer';
frame.setAttribute('credentialless','');
let readySignals=0;
let consumedSignals=0;
let lastHeartbeat=Date.now();
const restore=()=>{lastHeartbeat=Date.now();frame.src=artifact;};
addEventListener('message',event=>{
  if(event.source!==frame.contentWindow||event.data?.token!==token)return;
  lastHeartbeat=Date.now();
  if(event.data.type==='ready')readySignals++;
  if(event.data.type==='painted'&&parent!==window)parent.postMessage({type:'optchat-artifact-painted'},location.origin);
  // The artifact cannot open popups itself; a clicked https link is opened here, without an
  // opener, and only during the click's user activation (it propagates to this frame).
  if(event.data.type==='open'&&typeof event.data.url==='string'&&navigator.userActivation?.isActive!==false){
    try{
      const url=new URL(event.data.url);
      if(url.protocol==='https:'&&!url.username&&!url.password)window.open(url.href,'_blank','noopener,noreferrer');
    }catch{}
  }
});
frame.addEventListener('load',()=>setTimeout(()=>{
  if(readySignals>consumedSignals){consumedSignals=readySignals;return;}
  restore();
},100));
setInterval(()=>{
  if(document.visibilityState==='visible'&&Date.now()-lastHeartbeat>3000)restore();
},500);
frame.src=artifact;
document.querySelector('#frame-root').append(frame);
</script>
</body>
</html>`;

export const artifactRoutes = (router: HttpRouter.HttpRouter, o: { readonly artifacts: Artifacts }) =>
  Effect.gen(function* () {
    const { artifacts } = o;

    yield* router.add("GET", "/api/artifacts", Effect.suspend(() => HttpServerResponse.schemaJson(ArtifactList)({ artifacts: artifacts.list() })).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 }))));

    // fx0's /api/artifact: the stored HTML, so this origin never renders it
    yield* router.add("GET", "/api/artifact", (request) =>
      Effect.gen(function* () {
        const q = wanted(request.url);
        const found = q === null ? null : yield* artifacts.read(q.name, q.v);
        if (found === null) return notFound();
        return HttpServerResponse.text(found.html, {
          contentType: "text/plain; charset=utf-8",
          headers: { ...SHARED, "content-disposition": `attachment; filename="${found.name}-v${found.version.v}.html"`, "content-security-policy": RAW_CSP },
        });
      }).pipe(Effect.orElseSucceed(notFound)),
    );

    yield* router.add("GET", "/artifact/frame", (request) =>
      Effect.sync(() => {
        const q = wanted(request.url);
        const info = q === null ? null : artifacts.info(q.name);
        const v = q?.v ?? info?.versions.at(-1)?.v;
        if (q === null || info === null || v === undefined || !info.versions.some((x) => x.v === v)) return notFound();
        const token = crypto.randomUUID();
        const page = `/artifact/page?${new URLSearchParams({ name: info.name, token, v: String(v) }).toString()}`;
        // the guard let this Host in (server/auth.ts): one of the names this server answers to
        const host = (request.headers.host ?? "").toLowerCase();
        return HttpServerResponse.text(wrapperPage(page, token), {
          contentType: "text/html; charset=utf-8",
          headers: { ...SHARED, "content-security-policy": wrapperCsp(host), "permissions-policy": PERMISSIONS },
        });
      }).pipe(Effect.orElseSucceed(notFound)),
    );

    yield* router.add("GET", "/artifact/page", (request) =>
      Effect.gen(function* () {
        const q = wanted(request.url);
        if (q?.v === undefined || q.token === null || !TOKEN.test(q.token)) return notFound();
        const found = yield* artifacts.read(q.name, q.v);
        if (found === null) return notFound();
        return HttpServerResponse.text(prepareArtifactHtml(found.html, ARTIFACT_EMBEDDED_CSP, q.token), {
          contentType: "text/html; charset=utf-8",
          headers: { ...SHARED, "content-security-policy": PAGE_CSP, "cross-origin-resource-policy": "same-origin", "permissions-policy": PERMISSIONS },
        });
      }).pipe(Effect.orElseSucceed(notFound)),
    );

    yield* router.add(
      "GET",
      "/artifact/draft",
      Effect.sync(() =>
        HttpServerResponse.text(EMPTY_DRAFT_DOCUMENT, {
          contentType: "text/html; charset=utf-8",
          headers: { ...SHARED, "content-security-policy": DRAFT_CSP, "permissions-policy": PERMISSIONS },
        }),
      ),
    );
  });
