import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
    proxy: {
      "/api":  { target: "http://localhost:8000", changeOrigin: true },
      "/chat": { target: "http://localhost:8000", changeOrigin: true },
    },
  },

  build: {
    assetsInlineLimit: 8192,

    rollupOptions: {
      output: {
        manualChunks(id) {
          // React core (rarely changes → great for caching)
          if (id.includes("react") || id.includes("react-dom")) {
            return "vendor-react";
          }

          // PDF.js (very heavy)
          if (id.includes("pdfjs-dist")) {
            return "vendor-pdfjs";
          }

          // Graph libraries (only for citation view)
          if (
            id.includes("react-force-graph-2d") ||
            id.includes("d3-force") ||
            id.includes("d3-selection")
          ) {
            return "vendor-graph";
          }

          // Everything else from node_modules
          if (id.includes("node_modules")) {
            return "vendor-misc";
          }
        },
      },
    },
  },
});