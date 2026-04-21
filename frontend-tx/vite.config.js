import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
