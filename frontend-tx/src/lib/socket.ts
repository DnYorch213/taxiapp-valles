// src/lib/socket.ts
import { io } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

export const socket = io(API_URL, {
  auth: {
    email: localStorage.getItem("email"),
    role: localStorage.getItem("role") // 👈 Añadimos esto también aquí
  },
  transports: ["websocket"],
  autoConnect: false,
});

// 🚀 FUNCIÓN CORREGIDA:
export const connectSocket = (email: string, role: string) => { // 👈 Ahora pide el rol
  if (!email || !role) return;

  // Actualizamos la identidad completa
  socket.auth = { email, role };

  if (socket.connected) {
    socket.disconnect();
  }

  socket.connect();
  console.log(`✅ Socket conectado: ${email} como ${role}`);
};