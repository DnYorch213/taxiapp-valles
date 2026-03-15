import { io } from "socket.io-client";

// Usamos la variable de entorno, y si no existe (local), usamos localhost
const URL = import.meta.env.VITE_API_URL || "http://localhost:3001";

export const socket = io(URL, {
  transports: ["websocket"], // Recomendado para evitar problemas de CORS en Render
  withCredentials: true,
});
