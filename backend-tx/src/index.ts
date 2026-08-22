import * as dotenv from "dotenv";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { connectDB } from "./db";
import adminRoutes from "./routes/adminRoutes";
import authRoutes from "./routes/authRoutes";
import { handleSaveSubscription } from "./controllers/pushController";
import { initSocketEngine } from "./socket/socketEngine";
import { verifyToken } from "./middleware/authMiddleware";
import { Trip } from "./models/Trip";
import { isAutoMode } from "./services/dispatchService";

dotenv.config();
connectDB();

const app = express();
const server = http.createServer(app);
const isDev = process.env.NODE_ENV === 'development';

const allowedOrigins = [
  process.env.FRONTEND_URL,
  "https://taxiapp-valles.vercel.app", // 👈 Aseguramos el dominio de producción explícitamente
  "http://localhost:5173",
  "http://127.0.0.1:5173"
].filter((origin): origin is string => Boolean(origin));

if (process.env.NODE_ENV !== "production" && allowedOrigins.length === 0) {
  console.warn("⚠️ FRONTEND_URL no configurado. Solo orígenes de desarrollo permitidos.");
}

// Función centralizada para validación de CORS
const checkOrigin = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
  // Permite solicitudes sin origen (mobile apps, Postman, curl, PWA instalada)
  if (!origin || isDev) {
    return callback(null, true);
  }

  if (allowedOrigins.some((o) => origin.startsWith(o))) {
    return callback(null, true);
  }

  console.warn(`🚫 Bloqueado por CORS: ${origin}`);
  return callback(new Error("🚫 Bloqueado por seguridad de Red Taxi"));
};

const corsOptions = {
  origin: checkOrigin,
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
};

app.use(cors(corsOptions));
app.use(express.json());

// 🚀 Configuración de Socket.io corregida
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      // Si no hay origin (p. ej. cliente socket directo), permitimos la conexión
      if (!origin) return callback(null, true);
      return checkOrigin(origin, callback);
    },
    credentials: true,
    methods: ["GET", "POST"]
  },
  // 💡 CRÍTICO: Primero 'polling', luego upgrade a 'websocket'
  transports: ['polling', 'websocket'],
  allowEIO3: true,
  pingInterval: 25000,
  pingTimeout: 120000,
  upgradeTimeout: 30000
});

// Rutas HTTP REST
app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);

app.post("/api/save-subscription", verifyToken, handleSaveSubscription);

// 🔐 Historial de viajes (PROTEGIDO)
app.get("/api/history/:email", verifyToken, async (req: any, res) => {
  try {
    const paramEmail = req.params.email.toLowerCase().trim();
    const userEmail = req.user?.email?.toLowerCase().trim();

    if (userEmail !== paramEmail && req.user?.role !== 'admin') {
      return res.status(403).json({
        message: "❌ No puedes ver el historial de otro usuario"
      });
    }

    const viajes = await Trip.find({ taxistaEmail: paramEmail }).sort({ fecha: -1 }).limit(50);
    return res.json(viajes);
  } catch (error) {
    return res.status(500).json({ message: "Error al obtener historial" });
  }
});

// Endpoint de salud para Render.com
app.get("/ping", (req, res) => {
  return res.status(200).send("Taxi ECO Valles despierto ✅");
});

// Inicialización de la lógica en tiempo real
initSocketEngine(io);

const PORT = Number(process.env.PORT) || 3001;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 SERVIDOR EN PUERTO: ${PORT} | AUTO: ${isAutoMode}`);
});