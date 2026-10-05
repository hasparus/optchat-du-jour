// Builds the web UI into web/dist, which optchat-server serves at / (SPEC "Web UI", E2). `bun run
// dev` proxies /ws and /api to a server on 127.0.0.1:7700, as that server's own origin (it refuses
// cross-origin requests). Installable as a PWA; the service
// worker caches the app shell only, never the API.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const server = "127.0.0.1:7700";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "optchat",
        short_name: "optchat",
        description: "an endless chat whose history is its memory",
        display: "standalone",
        start_url: "/",
        background_color: "#0a0a0a",
        theme_color: "#0a0a0a",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // the shell; shiki's grammars load on demand and are cached as they are used
        globPatterns: ["index.html", "assets/index-*.{js,css}", "*.{png,svg}"],
        navigateFallbackDenylist: [/^\/(api|ws|mcp)\b/],
        runtimeCaching: [{ urlPattern: /\/assets\/.*\.js$/, handler: "CacheFirst", options: { cacheName: "chunks" } }],
      },
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("src", import.meta.url)) } },
  server: {
    proxy: {
      "/api": { changeOrigin: true, headers: { origin: `http://${server}` }, target: `http://${server}` },
      "/ws": { changeOrigin: true, headers: { origin: `http://${server}` }, target: `ws://${server}`, ws: true },
    },
  },
});
