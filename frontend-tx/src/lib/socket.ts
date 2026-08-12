// src/lib/socket.ts
import { io } from "socket.io-client";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

export const socket = io(API_URL, {
  withCredentials: true,
  auth: {
    email: typeof window !== "undefined" ? localStorage.getItem("email") : undefined,
    role: typeof window !== "undefined" ? localStorage.getItem("role") : undefined,
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

socket.on("connect_error", () => {
  console.warn("?? Socket connect_error: la sesi?n puede estar siendo reemplazada o la red est? inestable.");
});

socket.on("session_replaced", () => {
  console.warn("?? Se recibi? un reemplazo de sesi?n desde el servidor. Se limpiar? el estado local.");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("socket-session-replaced"));
  }
});

export const connectSocket = (email: string, role: string) => {
  if (!email || !role) return;

  const normalizedEmail = email.toLowerCase().trim();
  const currentAuth = (typeof socket.auth === "function" ? {} : (socket.auth || {})) as {
    email?: string;
    role?: string;
    token?: string;
  };
  const sameIdentity = currentAuth.email === normalizedEmail && currentAuth.role === role;

  socket.auth = { ...currentAuth, email: normalizedEmail, role };

  if (sameIdentity && (socket.connected || socket.active)) {
    return;
  }

  if (socket.connected && !sameIdentity) {
    socket.disconnect();
  }

  if (!socket.connected && !socket.active) {
    socket.connect();
  }

  console.log(`? Socket conectado: ${normalizedEmail} como ${role}`);
};
