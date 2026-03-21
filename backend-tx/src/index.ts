import "dotenv/config";
import express from "express";
import { Request, Response } from "express";
import http from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import cors from "cors";
import { connectDB } from "./db";
import { Position } from "./models/Position";
import { User } from "./models/User";

const app = express();
const server = http.createServer(app);

const isDev = process.env.NODE_ENV === 'development';

const allowedOrigins = [
  "https://taxiapp-valles.vercel.app", // Producción
  "http://localhost:5173",            // Tu Vite local
  "http://127.0.0.1:5173"
];

const corsOptions = {
  origin: (origin: string | undefined, callback: any) => {
    // En modo desarrollo (isDev), permitimos TODO lo que venga de localhost
    // En producción, solo lo que esté en la lista blanca
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
  allowEIO3: true
});

connectDB();

const PORT = Number(process.env.PORT) || 3001;
const MAX_RETRIES = 5; // ✋ Límite de taxistas antes de rendirse

let isAutoMode = true;
const pendingTimeouts = new Map<string, NodeJS.Timeout>();

// --- HELPERS ---

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const R = 6371;
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

function buildPayload(user: any, pos: any, estado: string, extra: any = {}) {
  return {
    email: user?.email || pos?.email,
    name: user?.name || pos?.name,
    role: user?.role || pos?.role,
    taxiNumber: user?.taxiNumber || pos?.taxiNumber,
    lat: pos?.lat ?? null,
    lng: pos?.lng ?? null,
    pickupAddress: extra.pickupAddress || pos?.pickupAddress || "Dirección opcional",
    estado: estado || pos?.estado || "activo",
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

// --- LÓGICA DE DESPACHO EN CASCADA (RECURSIVA) ---
const dispatchWithRetry = async (pasajeroData: any, excludedEmails: string[] = [], attempt: number = 1) => {
  if (!isAutoMode) return;

  // 1. Límite de reintentos
  if (attempt > MAX_RETRIES) {
    await Position.updateOne({ email: pasajeroData.email }, { estado: "activo" });
    io.to(pasajeroData.email).emit("no_taxis_available", { message: "No hay unidades disponibles en este momento." });
    io.emit("panel_update", { email: pasajeroData.email, estado: "activo" });
    return;
  }

  const checkPasajero = await Position.findOne({ email: pasajeroData.email });

  // 2. Validar que el pasajero siga necesitando el taxi
  if (!checkPasajero || ["en curso", "ocupado"].includes(checkPasajero.estado)) {
    console.log(`⚠️ Abortando cascada: Pasajero ya en viaje o no existe.`);
    return;
  }

  const taxistasDisponibles = await Position.find({
    role: "taxista",
    estado: { $in: ["activo", "Disponible"] },
    email: { $nin: excludedEmails }
  });

  if (taxistasDisponibles.length === 0) {
    await Position.updateOne({ email: pasajeroData.email }, { estado: "activo" });
    io.to(pasajeroData.email).emit("no_taxis_available", { message: "No hay conductores cerca." });
    io.emit("panel_update", { email: pasajeroData.email, estado: "activo" });
    return;
  }

  // 3. Haversine: Encontrar al más cercano
  let elMasCercano = taxistasDisponibles.reduce((prev, curr) => {
    const distPrev = calculateDistance(pasajeroData.lat, pasajeroData.lng, prev.lat, prev.lng);
    const distCurr = calculateDistance(pasajeroData.lat, pasajeroData.lng, curr.lat, curr.lng);
    return distPrev < distCurr ? prev : curr;
  });

  // 4. Bloqueo de estados
  await Position.updateOne({ email: elMasCercano.email }, { estado: "asignado" });
  await Position.updateOne({ email: pasajeroData.email }, { estado: "asignado" });

  io.to(elMasCercano.email).emit("pasajero_asignado", buildPayload(pasajeroData, pasajeroData, "asignado", { excludedEmails }));
  io.to(pasajeroData.email).emit("taxista_asignado", buildPayload(elMasCercano, elMasCercano, "asignado"));

  // 5. Cronómetro de 15 segundos
  const timeout = setTimeout(async () => {
    const tCheck = await Position.findOne({ email: elMasCercano.email });
    if (tCheck && tCheck.estado === "asignado") {
      await Position.updateOne({ email: elMasCercano.email }, { estado: "activo" });
      io.emit("panel_update", { email: elMasCercano.email, estado: "activo" });

      // REINTENTO (Siguiente en la cascada)
      dispatchWithRetry(pasajeroData, [...excludedEmails, elMasCercano.email], attempt + 1);
    }
  }, 15000);

  pendingTimeouts.set(elMasCercano.email, timeout);
};

// --- RUTAS HTTP ---
app.post("/register", async (req: Request, res: Response) => {
  try {
    const { name, email, password, role, taxiNumber } = req.body;
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: "El correo ya existe" });

    const hashed = await bcrypt.hash(password, 10);
    const user = new User({ name, email, password: hashed, role, taxiNumber: role === "taxista" ? taxiNumber : undefined });
    await user.save();
    res.status(201).json({ message: "Usuario registrado" });
  } catch (err) {
    res.status(500).json({ message: "Error en registro" });
  }
});

app.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ message: "Credenciales inválidas" });
    }

    const lastPos = await Position.findOne({ email: user.email });
    const token = jwt.sign({ email: user.email, name: user.name, role: user.role }, process.env.JWT_SECRET as string, { expiresIn: '24h' });

    res.json({ token, role: user.role, name: user.name, taxiNumber: user.taxiNumber, email: user.email, lastCoords: lastPos ? { lat: lastPos.lat, lng: lastPos.lng } : null });
  } catch (error) {
    res.status(500).json({ message: "Error en login" });
  }
});

// --- SOCKETS ---
io.on("connection", async (socket) => {
  const email = socket.handshake.auth?.email;
  const role = socket.handshake.auth?.role;

  if (email) {
    socket.join(email);
    if (role === "taxista") {
      await Position.updateOne({ email }, { estado: "activo", updatedAt: new Date() }, { upsert: true });
      const updatedPos = await Position.findOne({ email });
      io.emit("panel_update", buildPayload(updatedPos, updatedPos, "activo"));
    }
    socket.emit("dispatch_mode_changed", { auto: isAutoMode });
  }

  const initialPositions = await Position.find();
  socket.emit("positions", initialPositions.map(p => buildPayload(p, p, p.estado || "activo")));

  socket.on("position", async (data: any) => {
    if (!data.email) return;
    const currentDoc = await Position.findOne({ email: data.email });
    const finalName = (data.name && !data.name.includes('@')) ? data.name : (currentDoc?.name || data.name);
    const updated = await Position.findOneAndUpdate({ email: data.email }, { ...data, name: finalName, updatedAt: new Date() }, { upsert: true, returnDocument: "after" });
    io.emit("panel_update", buildPayload(updated, updated, updated.estado));
  });

  socket.on("toggle_dispatch_mode", (data: { auto: boolean }) => {
    isAutoMode = data.auto;
    io.emit("dispatch_mode_changed", { auto: isAutoMode });
  });

  socket.on("request_taxi", async (pasajeroData: any) => {
    if (isAutoMode) {
      dispatchWithRetry(pasajeroData, [], 1);
    } else {
      await Position.updateOne({ email: pasajeroData.email }, { estado: "esperando" });
      io.emit("panel_update", buildPayload(pasajeroData, pasajeroData, "esperando"));
    }
  });

  socket.on("taxi_response", async ({ requestEmail, accepted, excludedEmails = [] }) => {
    const tEmail = socket.handshake.auth?.email;
    if (pendingTimeouts.has(tEmail)) {
      clearTimeout(pendingTimeouts.get(tEmail)!);
      pendingTimeouts.delete(tEmail);
    }

    if (!accepted) {
      await Position.updateOne({ email: tEmail }, { estado: "activo" });
      const tPos = await Position.findOne({ email: tEmail });
      io.emit("panel_update", buildPayload(tPos, tPos, "activo"));
      const pData = await Position.findOne({ email: requestEmail });
      if (pData) dispatchWithRetry(pData, [...excludedEmails, tEmail], 1); // Reinicia conteo o sigue flujo
      return;
    }

    await Position.updateOne({ email: tEmail }, { estado: "ocupado" });
    await Position.updateOne({ email: requestEmail }, { estado: "asignado" });
    const tPos = await Position.findOne({ email: tEmail });
    const pPos = await Position.findOne({ email: requestEmail });

    io.to(requestEmail).emit("response_from_taxi", { accepted: true, tEmail, taxiData: buildPayload(tPos, tPos, "ocupado") });
    io.emit("panel_update", buildPayload(tPos, tPos, "ocupado"));
    io.emit("panel_update", buildPayload(pPos, pPos, "asignado"));
  });

  socket.on("admin_assign_taxi", async ({ pasajeroEmail, taxistaEmail }) => {
    if (pendingTimeouts.has(taxistaEmail)) {
      clearTimeout(pendingTimeouts.get(taxistaEmail)!);
      pendingTimeouts.delete(taxistaEmail);
    }
    const pData = await Position.findOne({ email: pasajeroEmail });
    const tData = await Position.findOne({ email: taxistaEmail });
    if (pData && tData) {
      await Position.updateOne({ email: taxistaEmail }, { estado: "asignado" });
      await Position.updateOne({ email: pasajeroEmail }, { estado: "asignado" });
      io.to(taxistaEmail).emit("pasajero_asignado", buildPayload(pData, pData, "asignado"));
      io.to(pasajeroEmail).emit("taxista_asignado", buildPayload(tData, tData, "asignado"));
      io.emit("panel_update", buildPayload(pData, pData, "asignado"));
      io.emit("panel_update", buildPayload(tData, tData, "asignado"));
    }
  });

  socket.on("passenger_on_board", async ({ taxistaEmail, pasajeroEmail }) => {
    await Position.updateOne({ email: taxistaEmail }, { estado: "en curso" });
    await Position.updateOne({ email: pasajeroEmail }, { estado: "en curso" });
    io.to(pasajeroEmail).emit("trip_status_update", { status: "en curso" });
    io.emit("panel_update", { email: pasajeroEmail, estado: "en curso" });
  });

  socket.on("passenger_cancel", async ({ pasajeroEmail, taxistaEmail }) => {
    if (taxistaEmail && pendingTimeouts.has(taxistaEmail)) {
      clearTimeout(pendingTimeouts.get(taxistaEmail)!);
      pendingTimeouts.delete(taxistaEmail);
    }
    await Position.updateOne({ email: pasajeroEmail }, { estado: "activo" });
    if (taxistaEmail) {
      await Position.updateOne({ email: taxistaEmail }, { estado: "activo" });
      io.to(taxistaEmail).emit("trip_cancelled_by_passenger", { message: "Cancelado", newStatus: "activo" });
    }
    io.emit("trip_finished", { pasajeroEmail, taxistaEmail, status: "cancelado" });
  });

  socket.on("end_trip", async ({ pasajeroEmail, taxistaEmail }) => {
    await Position.updateOne({ email: taxistaEmail }, { estado: "activo" });
    await Position.updateOne({ email: pasajeroEmail }, { estado: "activo" });
    io.emit("trip_finished", { pasajeroEmail, taxistaEmail, status: "terminado" });
  });

  socket.on("send_message", (data) => {
    io.to(data.toEmail).emit("receive_message", { senderName: data.senderName, message: data.message, timestamp: new Date().toISOString() });
  });

  socket.on("disconnect", async () => {
    const uEmail = socket.handshake.auth?.email;
    if (uEmail) {
      if (pendingTimeouts.has(uEmail)) {
        clearTimeout(pendingTimeouts.get(uEmail)!);
        pendingTimeouts.delete(uEmail);
      }
      await Position.updateOne({ email: uEmail }, { estado: "desconectado" });
      const p = await Position.findOne({ email: uEmail });
      io.emit("panel_update", buildPayload(p, p, "desconectado"));
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 SERVIDOR EN PUERTO: ${PORT} | AUTO: ${isAutoMode}`);
});