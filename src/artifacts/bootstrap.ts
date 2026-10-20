// From fx0 lib/design-artifact.ts (Apache-2.0, © Vercel, modified).
// Changed from fx0's: the same code, as functions this repo type-checks and lints rather than a
// template string; html.ts inlines them with Function.prototype.toString, so each may use only
// globals, its parameters and its own locals (a type of this module is erased, so it is fine; a
// value, an import or a helper is not).

// The page's globals the heartbeat uses, declared for this module alone (see frame-guard.ts)
interface Element {
  readonly closest: (this: Element, selectors: string) => Element | null;
  readonly getAttribute: (this: Element, name: string) => string | null;
}
type PageEvent = { readonly target: object | null; readonly preventDefault: () => void };
type Said = { readonly token: string; readonly type: string; readonly url?: string };
declare const Element: abstract new () => Element;
declare const parent: { readonly postMessage: (message: Said, targetOrigin: string) => void };
declare function addEventListener(type: "load", listener: () => void, options: { readonly once: boolean }): void;
declare function addEventListener(type: "click", listener: (event: PageEvent) => void, capture: boolean): void;
declare function requestAnimationFrame(callback: () => void): number;

// WebRTC gone from the page's window: STUN would reach any host, and no CSP stops it
export function noWebRtc(): void {
  for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCIceGatherer"]) {
    try {
      Object.defineProperty(globalThis, name, { configurable: false, value: undefined, writable: false });
    } catch {
      // already gone, or never there
    }
  }
}

// The wrapper (server/routes/artifacts.ts) waits for these, said with the token it gave the page:
// a heartbeat every 500 ms, "ready" at load and "painted" two frames later. The sandbox grants no
// popups, so a clicked https link asks the wrapper to open it instead of navigating the page away.
export function heartbeat(token: string): void {
  const send = (type: string) => {
    parent.postMessage({ token, type }, "*");
  };
  send("heartbeat");
  setInterval(() => {
    send("heartbeat");
  }, 500);
  addEventListener(
    "load",
    () => {
      send("ready");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          send("painted");
        });
      });
    },
    { once: true },
  );
  addEventListener(
    "click",
    (event) => {
      const link = event.target instanceof Element && event.target.closest("a[href]");
      const url = link ? (link.getAttribute("href") ?? "") : "";
      if (/^https:/i.test(url)) {
        event.preventDefault();
        parent.postMessage({ token, type: "open", url }, "*");
      }
    },
    true,
  );
}
