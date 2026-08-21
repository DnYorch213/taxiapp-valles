// src/lib/socket.ts
import { io } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

// Identificador estable por pestaña: permite al backend distinguir una reconexión
// de la misma pestaña (red inestable) de una sesión realmente nueva en otro dispositivo.
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

export const socket = io(API_URL, {
  auth: {
    email: typeof window !== "undefined" ? localStorage.getItem("email") : undefined,
    role: typeof window !== "undefined" ? localStorage.getItem("role") : undefined,
    token: typeof window !== "undefined" ? localStorage.getItem("token") : undefined,
    deviceId: getDeviceId(),
  },
  transports: ["websocket", "polling"],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  randomizationFactor: 0.5,
  timeout: 20000,
  upgrade: true,
  rememberUpgrade: true,
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

// 🚀 FUNCIÓN CORREGIDA:
export const connectSocket = (email: string, role: string) => {
  if (!email || !role) return;

  const normalizedEmail = email.toLowerCase().trim();
  const currentAuth = (typeof socket.auth === "function" ? {} : (socket.auth || {})) as {
    email?: string;
    role?: string;
    token?: string;
  };
  const sameIdentity = currentAuth.email === normalizedEmail && currentAuth.role === role;

  const storedToken = typeof window !== "undefined" ? localStorage.getItem("token") : undefined;
  socket.auth = { ...currentAuth, email: normalizedEmail, role, token: storedToken || currentAuth.token, deviceId: getDeviceId() };

  if (sameIdentity && (socket.connected || socket.active)) {
    return;
  }

  if (socket.connected && !sameIdentity) {
    socket.disconnect();
  }

  if (!socket.connected && !socket.active) {
    socket.connect();
  }

  console.log(`✅ Socket conectado: ${normalizedEmail} como ${role}`);
};