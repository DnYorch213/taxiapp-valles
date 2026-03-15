// src/lib/socket.ts
import { io } from "socket.io-client";

// 🌐 Detectamos la URL automáticamente según el entorno
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

export const socket = io(API_URL, {
  // 🔐 Recuperamos el email solo si existe, si no, lo enviamos vacío al inicio
  auth: {
    email: localStorage.getItem("email")
  },
  transports: ["websocket"],
  // 💡 Cambiamos a false para controlar la conexión nosotros mismos en el Login
  autoConnect: false,
});

// 🚀 Función vital para arreglar tu problema:
export const connectSocket = (email: string) => {
  if (!email) return;

  socket.auth = { email }; // Actualizamos la identidad

  // Si ya está conectado, desconectamos primero para limpiar la sesión vieja
  if (socket.connected) {
    socket.disconnect();
  }

  socket.connect(); // Forzamos conexión con el nuevo ID
  console.log("✅ Socket re-identificado y conectado con:", email);
};