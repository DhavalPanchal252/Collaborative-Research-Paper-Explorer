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
    // Raise the inline-asset limit slightly so small SVGs don't stay as
    // separate requests (default is 4 kB)
    assetsInlineLimit: 8192,

    rollupOptions: {
      output: {
        manualChunks: {
          // React runtime — cached forever, changes rarely
          "vendor-react": ["react", "react-dom"],

          // PDF.js is enormous; isolate it so users who only chat never pay
          // the cost of loading it
          "vendor-pdfjs": ["pdfjs-dist"],

          // Force graph is heavy (d3 + canvas rendering); only loaded on the
          // citation tab
          "vendor-graph": ["react-force-graph-2d", "d3-force", "d3-selection"],
        },
      },
    },
  },
});