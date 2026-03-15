import { io } from "socket.io-client";

// Forzamos la URL de tu backend en Render directamente
const URL = "https://taxiapp-valles.onrender.com";

export const socket = io(URL, {
  transports: ["websocket", "polling"],
  withCredentials: true,
  autoConnect: true,
});

// Esto es para que puedas ver el estado en la consola (F12)
// En JavaScript no necesitas el "as any"
if (typeof window !== "undefined") {
  window.socket = socket;
}

console.log("🚀 Socket intentando conectar a:", URL);
