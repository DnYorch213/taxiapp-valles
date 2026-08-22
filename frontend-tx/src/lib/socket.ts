// src/lib/socket.ts
import { io } from "socket.io-client";

// 1. Limpieza de URL: remueve slashes finales y el sufijo /api si está presente
const RAW_URL = (import.meta.env.VITE_API_URL || "http://localhost:3001").replace(/\/+$/, '');
const SOCKET_BASE_URL = RAW_URL.endsWith('/api') ? RAW_URL.slice(0, -4) : RAW_URL;

const getDeviceId = () => {
  if (typeof window === "undefined") return undefined;
  let id = sessionStorage.getItem("deviceId");
  if (!id) {
    id = typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem("deviceId", id);
  }
  return id;
};

export const socket = io(SOCKET_BASE_URL, {
  auth: (cb) => {
    // 💡 Pasar auth como función para asegurar datos frescos de localStorage en cada intento
    if (typeof window === "undefined") {
      cb({});
      return;
    }
    cb({
      email: localStorage.getItem("email")?.toLowerCase().trim(),
      role: localStorage.getItem("role"),
      token: localStorage.getItem("token"),
      deviceId: getDeviceId(),
    });
  },
  // 🚀 PERMITIR POLLING PRIMERO Y LUEGO UPGRADE A WEBSOCKET (Indispensable para Render)
  transports: ["polling", "websocket"],
  upgrade: true,
  withCredentials: false,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 10000,
  randomizationFactor: 0.5,
  timeout: 25000, // Aumentado ligeramente para tolerar "Cold Starts" de Render
  autoConnect: false,
});

socket.on("connect_error", (err) => {
  console.warn("⚠️ Socket connect_error:", err.message, err);
});

socket.on("session_replaced", () => {
  console.warn("⚠️ Se recibió un reemplazo de sesión desde el servidor. Se limpiará el estado local.");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("socket-session-replaced"));
  }
});

export const connectSocket = (email: string, role: string) => {
  if (!email || !role) return;

  const normalizedEmail = email.toLowerCase().trim();

  // Guardar en localStorage para garantizar persistencia
  if (typeof window !== "undefined") {
    localStorage.setItem("email", normalizedEmail);
    localStorage.setItem("role", role);
  }

  // Si ya está totalmente conectado con la misma identidad, no hacer nada
  if (socket.connected) {
    return;
  }

  // Forzar reconexión limpia
  socket.connect();
  console.log(`🚀 Iniciando conexión Socket para: ${normalizedEmail} (${role}) en ${SOCKET_BASE_URL}`);
};