// Entry point: the /ws link of this origin, the app, and the service worker that makes it an
// installable PWA (SPEC "Web UI"). In the iOS app's WebView there is no service worker (WKWebView
// gives one only to app-bound domains); registerSW checks for it and does nothing.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./app";
import { openLink } from "./lib/connection";
import { makeSession } from "./lib/session";
import { WAKE_EVENT } from "./lib/shell";
import "./index.css";

const ws = new URL("/ws", location.href);
ws.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const link = openLink(ws.href);
const session = makeSession(link); // for the page's lifetime, so no event falls between renders

// back in front (a phone unlocked, the app reopened, the network back): a dropped link retries now
const wake = () => {
  if (document.visibilityState === "visible") link.wake();
};
document.addEventListener("visibilitychange", wake);
addEventListener("online", wake);
addEventListener(WAKE_EVENT, wake);

const root = document.querySelector("#root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App link={link} session={session} />
    </StrictMode>,
  );
}
void registerSW({ immediate: true });
