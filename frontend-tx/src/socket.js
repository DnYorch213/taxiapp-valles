import { io } from "socket.io-client";

const URL = "https://taxiapp-valles.onrender.com";

export const socket = io(URL, {
  transports: ["websocket", "polling"],
  withCredentials: true,
  autoConnect: true,
});

// --- ESTE BLOQUE ES EL QUE SOLUCIONA TU ERROR ---
if (typeof window !== "undefined") {
  // @ts-ignore (por si usas TypeScript)
  window.socket = socket;

  // Si esto sale en tu consola, window.socket.id DEBE funcionar
  console.log("🔌 Socket.js cargado. ID actual:", socket.id);
}

socket.on("connect", () => {
  console.log("✅ Conexión establecida con el servidor. ID:", socket.id);
});
