import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return;
          }

          if (id.includes("leaflet-routing-machine")) {
            return "routing-vendor";
          }

          if (id.includes("react-leaflet")) {
            return "react-leaflet-vendor";
          }

          if (id.includes("leaflet")) {
            return "leaflet-vendor";
          }

          if (
            id.includes("react-router") ||
            id.includes("react-dom") ||
            id.includes("react/")
          ) {
            return "react-vendor";
          }

          if (
            id.includes("axios") ||
            id.includes("jwt-decode") ||
            id.includes("socket.io-client")
          ) {
            return "app-vendor";
          }

          if (id.includes("lucide-react")) {
            return "icons-vendor";
          }
        },
      },
    },
  },
  server: {
    // 1. Permitimos cualquier host explícitamente
    allowedHosts: [
      "all",
      ".ngrok-free.app", // Esto permite cualquier subdominio de ngrok
    ],
    // 2. Exponemos el servidor a la red local
    host: true,

    proxy: {
      "/socket.io": {
        target: "http://localhost:3001",
        ws: true,
      },
      "/api": "http://localhost:3001",
    },
    hmr: {
      overlay: false,
    },
  },
  resolve: {
    alias: {
      "@components": path.resolve(__dirname, "src/components"),
    },
  },
});
