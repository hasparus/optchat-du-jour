// Entry point: the /ws link of this origin, the app, and the service worker that makes it an
// installable PWA (SPEC "Web UI"). In the iOS app's WebView there is no service worker (WKWebView
// gives one only to app-bound domains); registerSW checks for it and does nothing.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./app";
import { openLink, wakeOnReturn } from "./lib/connection";
import { makeSession } from "./lib/session";
import "./index.css";

const ws = new URL("/ws", location.href);
ws.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const link = openLink(ws.href);
const session = makeSession(link); // for the page's lifetime, so no event falls between renders

wakeOnReturn(link); // back in front: a link that dropped, or may have, reconnects at once

const root = document.querySelector("#root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App link={link} session={session} />
    </StrictMode>,
  );
}
void registerSW({ immediate: true });
