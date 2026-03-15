import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite"; // 👈 1. Importa esto
import path from "path";
import { fileURLToPath } from "url"; // 👈 Cambio menor para Windows

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(), // 👈 2. Añade esto aquí
  ],
  server: {
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
