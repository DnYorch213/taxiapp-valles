// src/server.ts
import * as dotenv from "dotenv";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { connectDB } from "./db";
import adminRoutes from "./routes/adminRoutes";
import authRoutes from "./routes/authRoutes";
// 🎯 SOLO importamos lo que realmente usamos (eliminamos accept/reject)
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
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

const corsOptions = {
  origin: (origin: string | undefined, callback: any) => {
    if (!origin || allowedOrigins.includes(origin) || isDev) {
      callback(null, true);
    } else {
      callback(new Error("🚫 Bloqueado por seguridad de Red Taxi"));
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
};

app.use(cors(corsOptions));
app.use(express.json());

// Configuración robusta de Socket.io
const io = new Server(server, {
  cors: {
    origin: (origin: string | undefined) => {
      if (!origin) return false;
      if (allowedOrigins.includes(origin)) return true;
      return false;
    },
    credentials: true,
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling'],
  allowEIO3: true,
  pingInterval: 25000,
  pingTimeout: 120000,
  upgradeTimeout: 30000
});

// Rutas HTTP REST
app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);

// 🔐 Endpoints delegados a controladores (PROTEGIDOS)
// 🚫 ELIMINADOS: /api/accept-trip-push y /api/reject-trip-push 
// (Ahora se manejan 100% vía WebSockets para evitar conflictos de estado)
app.post("/api/save-subscription", verifyToken, handleSaveSubscription);

// 🔐 Historial de viajes (PROTEGIDO)
app.get("/api/history/:email", verifyToken, async (req: any, res) => {
  try {
    const paramEmail = req.params.email.toLowerCase().trim();
    const userEmail = req.user?.email?.toLowerCase().trim();

    // 🛡️ El usuario solo puede ver su propio historial, excepto si es admin
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