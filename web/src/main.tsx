// Entry point: the /ws link of this origin, the app, and the service worker that makes it an
// installable PWA (SPEC "Web UI").
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./app";
import { openLink } from "./lib/connection";
import "./index.css";

const ws = new URL("/ws", location.href);
ws.protocol = location.protocol === "https:" ? "wss:" : "ws:";
const link = openLink(ws.href);

const root = document.querySelector("#root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App link={link} />
    </StrictMode>,
  );
}
void registerSW({ immediate: true });
