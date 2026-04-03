import * as dotenv from "dotenv";
import express from "express";
import { Request, Response } from "express";
import http from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import cors from "cors";
import { connectDB } from "./db";
import { IPosition, Position } from "./models/Position";
import { User } from "./models/User";
import webpush from "web-push";

dotenv.config();

// --- CONFIGURACIONES INICIALES ---
webpush.setVapidDetails(
  "mailto:jorgelopezarevalo0@gmail.com",
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);

const app = express();
const server = http.createServer(app);
const isDev = process.env.NODE_ENV === 'development';

const allowedOrigins = [
  "https://taxiapp-valles.vercel.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173"
];

const corsOptions = {
  origin: (origin: any, callback: any) => {
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

const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  pingInterval: 5000,
  pingTimeout: 10000
});

connectDB();

const PORT = Number(process.env.PORT) || 3001;
const MAX_RETRIES = 5;
let isAutoMode = true;
const pendingTimeouts = new Map<string, NodeJS.Timeout>();

// --- HELPERS ---

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

function buildPayload(user: any, pos: any, estado: string, extra: any = {}) {
  return {
    email: user?.email || pos?.email,
    name: user?.name || pos?.name,
    role: user?.role || pos?.role,
    taxiNumber: user?.taxiNumber || pos?.taxiNumber,
    lat: pos?.lat ?? null,
    lng: pos?.lng ?? null,
    pushSubscription: extra.pushSubscription || pos?.pushSubscription || user?.pushSubscription || null,
    estado: estado || pos?.estado || "activo",
    taxistaAsignado: pos?.taxistaAsignado || null, // 👈 Importante para el tracking
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

const enviarNotificacionPush = async (subscription: any, pasajeroData: any, taxistaEmail: string) => {
  if (!subscription) return;
  const payload = JSON.stringify({
    notification: {
      title: "🚕 ¡NUEVO SERVICIO!",
      body: `Cliente: ${pasajeroData.name}\n📍 Toca para ver la ubicación`,
      data: { url: "/taxista" }
    }
  });
  try {
    await webpush.sendNotification(subscription, payload, { TTL: 60, urgency: 'high' });
  } catch (error) {
    console.error(`❌ Error Push a ${taxistaEmail}:`, error);
  }
};

const dispatchWithRetry = async (pasajeroData: any, excludedEmails: string[] = [], attempt: number = 1) => {
  if (!isAutoMode || attempt > MAX_RETRIES) {
    if (attempt > MAX_RETRIES) io.to(pasajeroData.email).emit("no_taxis_available");
    return;
  }

  const taxistas = await Position.find({
    role: "taxista",
    pushSubscription: { $exists: true, $ne: null },
    estado: "activo",
    email: { $nin: excludedEmails }
  }).lean();

  if (taxistas.length === 0) return;

  const elMasCercano = taxistas.reduce((prev, curr) =>
    calculateDistance(pasajeroData.lat, pasajeroData.lng, prev.lat, prev.lng) <
      calculateDistance(pasajeroData.lat, pasajeroData.lng, curr.lat, curr.lng) ? prev : curr
  );

  // 1. Vincular en BD antes de avisar
  await Position.updateOne({ email: elMasCercano.email }, { $set: { estado: "asignado" } });
  await Position.updateOne({ email: pasajeroData.email }, { $set: { estado: "asignado", taxistaAsignado: elMasCercano.email } });

  // 2. Notificar
  io.to(elMasCercano.email).emit("pasajero_asignado", buildPayload(pasajeroData, pasajeroData, "asignado"));
  enviarNotificacionPush(elMasCercano.pushSubscription, pasajeroData, elMasCercano.email);

  const timeout = setTimeout(async () => {
    const tCheck = await Position.findOne({ email: elMasCercano.email });
    if (tCheck && tCheck.estado === "asignado") {
      await Position.updateOne({ email: elMasCercano.email }, { $set: { estado: "activo" } });
      dispatchWithRetry(pasajeroData, [...excludedEmails, elMasCercano.email], attempt + 1);
    }
  }, 22000);

  pendingTimeouts.set(elMasCercano.email, timeout);
};

// --- SOCKETS ---
// ... (Tus imports y configs iniciales se mantienen igual)

// --- SOCKETS ---
io.on("connection", async (socket) => {
  const email = (socket.handshake.auth?.email || socket.handshake.query?.email)?.toString().toLowerCase().trim();
  const role = socket.handshake.auth?.role || socket.handshake.query?.role;

  if (!email) return;
  socket.join(email);
  console.log(`📡 Conectado: ${email} [${role}]`);

  // 1. RECUPERACIÓN INTELIGENTE (Crucial para Jorge)
  // Buscamos si este taxista tiene un pasajero que lo esté esperando o que ya vaya a bordo
  const viajeActivo = await Position.findOne({
    role: "pasajero",
    taxistaAsignado: email,
    estado: { $in: ["asignado", "en curso", "ocupado"] }
  });

  const currentDoc = await Position.findOne({ email });

  // Si hay viaje activo, mantenemos el estado actual del taxista (ocupado/asignado)
  // Si no hay viaje, lo ponemos como "activo" (disponible para recibir viajes)
  let nuevoEstado = viajeActivo ? (currentDoc?.estado || "asignado") : "activo";

  const updatedPos = await Position.findOneAndUpdate(
    { email },
    { $set: { estado: nuevoEstado, socketId: socket.id, updatedAt: new Date() } },
    { upsert: true, new: true } // 'new: true' devuelve el doc actualizado en Mongoose
  );

  // 2. ENVIAR DATOS DE RECUPERACIÓN
  if (viajeActivo && role === "taxista") {
    // Un pequeño delay asegura que el socket del cliente esté listo para escuchar
    setTimeout(() => {
      // Usamos 'estado: viajeActivo.estado' para que el frontend sepa si poner 
      // "Aceptar/Rechazar" o "Confirmar Abordo"
      socket.emit("pasajero_asignado", buildPayload(viajeActivo, viajeActivo, viajeActivo.estado));
      console.log(`✅ Viaje recuperado para el taxista: ${email} con cliente ${viajeActivo.name}`);
    }, 1000);
  }

  // 3. ACTUALIZAR PANEL ADMIN
  io.emit("panel_update", buildPayload(updatedPos, updatedPos, updatedPos.estado));

  // --- GESTIÓN DE RESPUESTA DEL TAXISTA ---
  socket.on("taxi_response", async ({ requestEmail, accepted }) => {
    const tEmail = email;

    // Detenemos el reloj de 22 segundos (el "dispatch_timeout")
    if (pendingTimeouts.has(tEmail)) {
      clearTimeout(pendingTimeouts.get(tEmail)!);
      pendingTimeouts.delete(tEmail);
    }

    if (!accepted) {
      // Si rechaza, lo volvemos a poner activo y buscamos al siguiente
      await Position.updateOne({ email: tEmail }, { $set: { estado: "activo" } });
      const pData = await Position.findOne({ email: requestEmail });
      if (pData) {
        // Re-intentamos el despacho excluyendo a este taxista
        dispatchWithRetry(pData, [tEmail], 1);
      }
      return;
    }

    // --- LOGICA DE ACEPTACIÓN ---
    // Marcamos al taxista como ocupado y vinculamos permanentemente al pasajero
    await Position.updateOne({ email: tEmail }, { $set: { estado: "ocupado" } });
    await Position.updateOne({ email: requestEmail }, { $set: { estado: "asignado", taxistaAsignado: tEmail } });

    const tPos = await Position.findOne({ email: tEmail });
    const pPos = await Position.findOne({ email: requestEmail });

    // Notificamos al pasajero que ya tiene taxi
    io.to(requestEmail).emit("response_from_taxi", {
      accepted: true,
      tEmail,
      name: tPos?.name,
      taxiNumber: tPos?.taxiNumber
    });

    // Actualizamos a todos los interesados (Admin)
    io.emit("panel_update", buildPayload(tPos, tPos, "ocupado"));
    io.emit("panel_update", buildPayload(pPos, pPos, "asignado"));
  });

  // --- FINALIZACIÓN DE VIAJE ---
  socket.on("end_trip", async ({ pasajeroEmail, taxistaEmail }) => {
    // Limpiamos los estados de ambos
    await Position.updateOne({ email: taxistaEmail }, { $set: { estado: "activo" } });
    await Position.updateOne({ email: pasajeroEmail }, { $set: { estado: "activo", taxistaAsignado: null } });

    // Avisamos a las partes
    io.to(pasajeroEmail).emit("trip_finished", { taxistaEmail });
    io.to(taxistaEmail).emit("trip_finished", { pasajeroEmail });

    console.log(`🏁 Viaje finalizado entre ${taxistaEmail} y ${pasajeroEmail}`);
  });

  socket.on("disconnect", async () => {
    console.log(`🔌 Desconectado: ${email}`);
    // No borramos la posición, solo marcamos offline o desconectado
    // para que si vuelve a entrar pueda recuperar su sesión.
    await Position.updateOne({ email }, { $set: { estado: "desconectado" } });
    io.emit("panel_update", { email, estado: "desconectado" });
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`🚀 Red Taxi Valles Online en puerto ${PORT}`));