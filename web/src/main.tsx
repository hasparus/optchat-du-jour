// Entry point: the /ws link of this origin, the app, and the service worker that makes it an
// installable PWA (SPEC "Web UI").
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./app";
import { openLink } from "./lib/connection";
import { syncThemeColor } from "./lib/look";
import { makeSession } from "./lib/session";
import "./index.css";
// the proposed design directions (src/lib/look.ts): tokens and a few rules each, under
// html[data-variant]; none applies by default
import "./variants/fonts.css";
import "./variants/a.css";
import "./variants/b.css";
import "./variants/c.css";

const ws = new URL("/ws", location.href);
ws.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const link = openLink(ws.href);
const session = makeSession(link); // for the page's lifetime, so no event falls between renders

const root = document.querySelector("#root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App link={link} session={session} />
    </StrictMode>,
  );
}
syncThemeColor();
void registerSW({ immediate: true });
