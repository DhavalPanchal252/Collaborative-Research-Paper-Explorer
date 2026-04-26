import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: {
    port: 5173,
  },

  build: {
    assetsInlineLimit: 8192,

    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("react") || id.includes("react-dom")) {
            return "vendor-react";
          }

          if (id.includes("pdfjs-dist")) {
            return "vendor-pdfjs";
          }

          if (
            id.includes("react-force-graph-2d") ||
            id.includes("d3-force") ||
            id.includes("d3-selection")
          ) {
            return "vendor-graph";
          }

          if (id.includes("node_modules")) {
            return "vendor-misc";
          }
        },
      },
    },
  },
});