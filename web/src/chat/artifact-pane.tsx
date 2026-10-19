// From fx0 components/preview-pane.tsx and components/design-export.tsx (Apache-2.0, © Vercel, modified).
// The preview pane (SPEC "Artifacts"; DESIGN.md, Artifacts): one artifact, any of its versions, in
// the wrapper route's sandboxed frame, with a version picker, copy, download, open in a new tab
// and refresh; while the model writes a version of it, the draft so far, drawn without scripts.
// Changed from fx0's: one frame instead of two swapping slots (a version is opened on purpose here,
// not replaced under the reader every few seconds), the draft held over it until the new version
// has painted, and the export menu's actions as the pane's own buttons. Loaded only when a pane
// opens.
import { Button } from "@/components/ui/button";
import { DRAFT_URL, type Draft, fileName, frameUrl, kb, rawUrl } from "@/lib/artifacts";
import { patchDraftDocument, renderable } from "@/lib/draft-preview";
import { nativeShell } from "@/lib/shell";
import { cn } from "@/lib/utils";
import type { ArtifactInfo } from "@wire";
import { Schema } from "effect";
import { CheckIcon, CopyIcon, DownloadIcon, ExternalLinkIcon, RotateCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { CompactSelect } from "./pickers";

export type ArtifactPaneProps = {
  readonly name: string;
  // the version shown; null follows the latest
  readonly v: number | null;
  readonly info: ArtifactInfo | null;
  // the model is writing a version of this artifact now
  readonly draft: Draft | null;
  readonly onVersion: (v: number | null) => void;
  // a side panel has its own close and its own heading; a sheet's are the sheet's
  readonly onClose?: (() => void) | undefined;
  readonly heading?: boolean;
};

type Notice = { readonly tone: "status" | "error"; readonly text: string };
// the wrapper's word that the artifact has painted (server/routes/artifacts.ts)
const isPainted = Schema.is(Schema.Struct({ type: Schema.Literal("optchat-artifact-painted") }));
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: "numeric", hour: "2-digit", minute: "2-digit", month: "short" });

export function ArtifactPane({ name, v, info, draft, onVersion, onClose, heading = true }: ArtifactPaneProps) {
  const latest = info?.versions.at(-1)?.v ?? null;
  const shown = v ?? latest;
  const version = info?.versions.find((x) => x.v === shown) ?? null;
  const [reloads, setReloads] = useState(0);
  const url = shown === null ? null : frameUrl(info?.name ?? name, shown);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useCallback((n: Notice) => {
    setNotice(n);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => {
      setNotice(null);
    }, 2500);
  }, []);
  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    },
    [],
  );

  // A new version paints in its own process after the wrapper's load event; the draft stays over
  // it until the wrapper says the page has painted (fx0's held draft), so the screen never shows a
  // blank between the picture and the page.
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [painted, setPainted] = useState<string | null>(null);
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const shown = frame.current;
      if (event.origin !== globalThis.location.origin || shown === null || event.source !== shown.contentWindow || !isPainted(event.data)) return;
      setPainted(shown.getAttribute("src"));
    };
    globalThis.addEventListener("message", onMessage);
    return () => {
      globalThis.removeEventListener("message", onMessage);
    };
  }, []);
  const liveDraft = draft && renderable(draft.html) && (v === null || v === latest) ? draft.html : null;
  const [held, setHeld] = useState<string | null>(null);
  const caughtUp = url === null || painted === url;
  useEffect(() => {
    if (liveDraft) setHeld(liveDraft);
    else if (!draft && caughtUp) setHeld(null);
  }, [liveDraft, draft, caughtUp]);
  const picture = liveDraft ?? held;

  // the HTML of the version shown, read once per version: copy can then write in the same click
  const cached = useRef<{ readonly key: string; readonly html: Promise<string> } | null>(null);
  const load = useCallback(async () => {
    if (shown === null) throw new Error("no version yet");
    const key = `${name}:${shown}`;
    if (cached.current?.key !== key) {
      const html = fetch(rawUrl(info?.name ?? name, shown)).then(async (res) => {
        if (!res.ok) throw new Error(`the artifact could not be read: ${res.status}`);
        return res.text();
      });
      const entry = { html, key };
      cached.current = entry;
      html.catch(() => {
        if (cached.current === entry) cached.current = null;
      });
    }
    return cached.current.html;
  }, [info?.name, name, shown]);

  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const html = load();
    try {
      // Safari allows a clipboard write only inside the click, so a pending read goes in as a
      // promise; elsewhere the text is written once it is here
      await ("ClipboardItem" in globalThis
        ? navigator.clipboard.write([new ClipboardItem({ "text/plain": html.then((text) => new Blob([text], { type: "text/plain" })) })])
        : navigator.clipboard.writeText(await html));
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
      }, 1500);
      say({ text: "Copied the HTML", tone: "status" });
    } catch {
      say({ text: "Couldn't copy the HTML", tone: "error" });
    }
  };
  const download = async () => {
    if (shown === null) return;
    try {
      const html = await load();
      // octet-stream, so the browser saves the file and never renders it on this origin
      const href = URL.createObjectURL(new Blob([html], { type: "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = href;
      link.download = fileName(info?.name ?? name, shown);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => {
        URL.revokeObjectURL(href);
      }, 10_000);
      say({ text: `Downloaded ${link.download}`, tone: "status" });
    } catch {
      say({ text: "Couldn't download the HTML", tone: "error" });
    }
  };
  // the iOS app's WebView loads no blob: download (SPEC E27): copy stays
  const canDownload = nativeShell() === undefined;
  const versions = [...(info?.versions ?? [])].toReversed();

  return (
    <section aria-label={`Artifact ${name}`} className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="artifact-pane">
      <div className="flex min-h-12 shrink-0 items-center gap-2 px-3 pt-1 pb-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {heading && <h2 className="truncate text-base font-semibold tracking-tight">{info?.name ?? name}</h2>}
          {versions.length > 0 && (
            <CompactSelect
              label="Version"
              onChange={(e) => {
                const picked = Number(e.target.value);
                onVersion(picked === latest ? null : picked);
              }}
              shown={
                <>
                  <span>v{shown}</span>
                  <span className="text-muted-foreground">of {latest}</span>
                </>
              }
              testId="artifact-version"
              value={String(shown)}
            >
              {versions.map((x) => (
                <option key={x.v} value={x.v}>
                  {`v${x.v}${x.v === latest ? " (latest)" : ""} · ${x.by === "edit" ? "edited" : "published"} ${when(x.date)} · ${kb(x.bytes)}`}
                </option>
              ))}
            </CompactSelect>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            aria-label="Refresh"
            className="text-muted-foreground hover:text-foreground"
            data-testid="artifact-refresh"
            disabled={url === null}
            onClick={() => {
              setPainted(null);
              setReloads((n) => n + 1);
            }}
            size="icon-sm"
            title="Refresh"
            variant="ghost"
          >
            <RotateCwIcon />
          </Button>
          <Button aria-label="Copy HTML" className="text-muted-foreground hover:text-foreground" data-testid="artifact-copy" disabled={shown === null} onClick={() => void copy()} size="icon-sm" title="Copy HTML" variant="ghost">
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
          {canDownload && (
            <Button aria-label="Download .html" className="text-muted-foreground hover:text-foreground" data-testid="artifact-download" disabled={shown === null} onClick={() => void download()} size="icon-sm" title="Download .html" variant="ghost">
              <DownloadIcon />
            </Button>
          )}
          {url !== null && (
            <Button aria-label="Open in a new tab" asChild className="text-muted-foreground hover:text-foreground" size="icon-sm" title="Open in a new tab" variant="ghost">
              <a data-testid="artifact-open" href={url} rel="noopener noreferrer" target="_blank">
                <ExternalLinkIcon />
              </a>
            </Button>
          )}
          {onClose && (
            <Button aria-label="Close" className="text-muted-foreground hover:text-foreground" data-testid="artifact-close" onClick={onClose} size="icon-sm" title="Close" variant="ghost">
              <XIcon />
            </Button>
          )}
        </div>
      </div>
      <p aria-live="polite" className={cn("min-h-0 px-3 text-xs", notice?.tone === "error" ? "text-destructive" : "text-muted-foreground", notice ? "pb-1.5" : "sr-only")} role="status">
        {notice?.text ?? ""}
      </p>
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl bg-background hairline">
        {url !== null && (
          // oxlint-disable-next-line react/iframe-missing-sandbox -- the wrapper is our own page (no artifact markup in it); the artifact runs in the frame it makes, sandboxed to allow-scripts alone, and opened links leave through it
          <iframe
            className="absolute inset-0 size-full border-0 bg-background"
            data-testid="artifact-frame"
            key={`${url}#${reloads}`}
            ref={frame}
            referrerPolicy="no-referrer"
            src={url}
            title={`${info?.name ?? name}, v${shown}`}
          />
        )}
        {picture !== null && (
          <div className="absolute inset-0 z-10 flex" data-testid="artifact-draft">
            <DraftPreview html={picture} />
          </div>
        )}
        {url === null && picture === null && (
          <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-ui text-muted-foreground">{draft ? "The model is writing it…" : "Nothing saved yet."}</p>
        )}
        {version && <span className="sr-only">{`${kb(version.bytes)}, ${version.by === "edit" ? "edited" : "published"} ${when(version.date)}`}</span>}
      </div>
    </section>
  );
}

// fx0's DraftPreview: one scriptless document the draft is patched into, at most every 150 ms. The
// frame is same-origin so this page can patch it, and sandboxed without allow-scripts, under the
// server's script-src 'none' (server/routes/artifacts.ts), so nothing in it runs.
function DraftPreview({ html }: { readonly html: string }) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const ready = useRef(false);
  const [painted, setPainted] = useState(false);
  const latest = useRef(html);
  latest.current = html;
  const lastPush = useRef(0);
  const pushed = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schedule = useCallback(() => {
    if (!ready.current || timer.current || latest.current === pushed.current) return;
    timer.current = setTimeout(
      () => {
        timer.current = null;
        const doc = frame.current?.contentDocument;
        if (!doc || !ready.current) return;
        patchDraftDocument(doc, latest.current);
        pushed.current = latest.current;
        lastPush.current = Date.now();
        setPainted(true);
      },
      Math.max(0, 150 - (Date.now() - lastPush.current)),
    );
  }, []);
  useEffect(() => {
    schedule();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [html, schedule]);

  return (
    <div className="relative min-h-0 flex-1">
      <iframe
        className={cn("absolute inset-0 size-full border-0 bg-background", painted ? "" : "opacity-0")}
        data-testid="artifact-draft-frame"
        onLoad={() => {
          // only the server's draft document, under its script-src 'none': a page an old service
          // worker answered in its place (the app's own) is never drawn into
          const own = frame.current?.contentDocument?.querySelector(`meta[http-equiv="Content-Security-Policy"][content*="script-src 'none'"]`) ?? null;
          ready.current = own !== null;
          schedule();
        }}
        ref={frame}
        referrerPolicy="no-referrer"
        sandbox="allow-same-origin"
        src={DRAFT_URL}
        title="The artifact while the model writes it"
      />
    </div>
  );
}

