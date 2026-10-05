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
const lazy = (chunk: { readonly isDynamicEntry: boolean; readonly moduleIds: readonly string[] }) =>
  chunk.isDynamicEntry || chunk.moduleIds.some((id) => id.includes("/@shikijs/") || id.includes("/shiki/"));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeManifestIcons: false, // the glob below already precaches the icons, once
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
        // the shell: everything the page loads at start (assets/, not assets/lazy/). Shiki's
        // grammars and the stats screen load on demand and are cached as they are used
        globPatterns: ["index.html", "assets/*.{js,css}", "*.{png,svg}"],
        navigateFallbackDenylist: [/^\/(api|ws|mcp)\b/],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/.*\.js$/,
            handler: "CacheFirst",
            // a chunk is cached only if it came back whole, and the cache keeps the newest ones (a
            // new build's hashed names would pile up otherwise)
            options: { cacheName: "chunks", cacheableResponse: { statuses: [200] }, expiration: { maxEntries: 60 } },
          },
        ],
      },
    }),
  ],
  build: {
    rolldownOptions: {
      // what only an import() loads (shiki and its grammars, the stats screen) goes in
      // assets/lazy/, out of the service worker's precache
      output: { chunkFileNames: (chunk) => (lazy(chunk) ? "assets/lazy/[name]-[hash].js" : "assets/[name]-[hash].js") },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("src", import.meta.url)),
      // the server's wire contract: schemas and helpers with no node imports (SPEC "Protocol")
      "@wire": fileURLToPath(new URL("../src/wire.ts", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": { changeOrigin: true, headers: { origin: `http://${server}` }, target: `http://${server}` },
      "/ws": { changeOrigin: true, headers: { origin: `http://${server}` }, target: `ws://${server}`, ws: true },
    },
  },
});
