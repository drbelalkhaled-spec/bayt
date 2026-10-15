import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  root: "web",
  publicDir: "../public",
  build: { outDir: "../dist", emptyOutDir: true },
  plugins: [
    VitePWA({
      strategies: "injectManifest",
      srcDir: ".", // relative to `root` (web/)
      filename: "sw.ts",
      injectRegister: false, // registered manually in web/main.ts
      registerType: "prompt", // the page decides when to activate (SKIP_WAITING message)
      manifest: {
        name: "Bayt",
        short_name: "Bayt",
        description: "Our home: shopping list, tasks and chat",
        start_url: "/#/list",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        background_color: "#2B4636",
        theme_color: "#C9651F",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
        ],
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        rollupFormat: "iife", // classic SW: works everywhere, registered without type:'module'
      },
      devOptions: { enabled: false },
    }),
  ],
});
