import * as dotenv from "dotenv";
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
import webpush from "web-push";

dotenv.config();

webpush.setVapidDetails(
  "mailto:jorgelopezarevalo0@gmail.com",
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!
);

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
  allowEIO3: true,

  // 🚨 AÑADE ESTAS LÍNEAS PARA EL CONTROL DE SEGUNDO PLANO:
  pingInterval: 5000,  // Envía un "ping" cada 5 segundos
  pingTimeout: 10000,  // Si en 10 segundos el pasajero no responde el ping, lo desconecta y borra del mapa
  upgradeTimeout: 10000 // Tiempo máximo para pasar de polling a websocket
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

// --- FUNCIÓN AUXILIAR PARA ENVIAR NOTIFICACIÓN PUSH ---
const enviarNotificacionPush = async (taxistaEmail: string, pasajeroData: any) => {
  try {
    const taxista = await User.findOne({ email: taxistaEmail, role: "taxista" });

    if (taxista && taxista.pushSubscription) {
      const payload = JSON.stringify({
        title: "🚕 ¡Nuevo Servicio en Valles!",
        body: `Cliente: ${pasajeroData.name}\n📍 Recoger en su ubicación actual`,
        data: {
          url: "/taxista",
          timestamp: Date.now()
        }
      });

      // Enviamos la señal al servidor de Google/Apple (Push)
      await webpush.sendNotification(taxista.pushSubscription, payload);
      console.log(`🔔 Push enviado con éxito a: ${taxistaEmail}`);
    }
    // ... dentro de enviarNotificacionPush
  } catch (error: any) { // 👈 Forzamos a 'any' para acceder a sus propiedades
    // Si la suscripción expiró o es inválida (Google/Apple nos avisan con 410 o 404)
    if (error.statusCode === 410 || error.statusCode === 404) {
      console.log(`⚠️ Suscripción expirada para ${taxistaEmail}. Limpiando base de datos...`);
      await User.updateOne({ email: taxistaEmail }, { pushSubscription: null });
    } else {
      console.error(`❌ Error enviando Push a ${taxistaEmail}:`, error.message || error);
    }
  }
};

// --- LÓGICA DE DESPACHO EN CASCADA (REFACTORIZADA) ---
const dispatchWithRetry = async (pasajeroData: any, excludedEmails: string[] = [], attempt: number = 1) => {
  if (!isAutoMode) return;

  // 1. Límite de reintentos (Fail-safe)
  if (attempt > MAX_RETRIES) {
    console.log(`❌ Límite de reintentos alcanzado para ${pasajeroData.email}`);
    await Position.updateOne({ email: pasajeroData.email }, { estado: "activo" });
    io.to(pasajeroData.email).emit("no_taxis_available", { message: "No hay unidades disponibles en este momento." });

    // Notificamos al panel para que el pasajero no se quede pegado en "buscando"
    const pPos = await Position.findOne({ email: pasajeroData.email }).lean();
    io.emit("panel_update", buildPayload(null, pPos, "activo"));
    return;
  }

  // 2. Validar que el pasajero siga necesitando el taxi (Estado fresco de DB)
  const checkPasajero = await Position.findOne({ email: pasajeroData.email }).lean();
  if (!checkPasajero || ["en curso", "ocupado"].includes(checkPasajero.estado)) {
    console.log(`⚠️ Abortando cascada: Pasajero ya en viaje o canceló.`);
    return;
  }

  // 3. Buscar taxistas disponibles (Usamos .lean() para obtener el taxiNumber real)
  const taxistasDisponibles = await Position.find({
    role: "taxista",
    estado: { $in: ["activo", "Disponible"] },
    email: { $nin: excludedEmails }
  }).lean();

  if (taxistasDisponibles.length === 0) {
    console.log(`🚫 Sin taxistas para el intento ${attempt}`);
    await Position.updateOne({ email: pasajeroData.email }, { estado: "activo" });
    io.to(pasajeroData.email).emit("no_taxis_available", { message: "No hay conductores cerca." });
    return;
  }

  // 4. Haversine: Encontrar al más cercano
  const elMasCercano = taxistasDisponibles.reduce((prev, curr) => {
    const distPrev = calculateDistance(pasajeroData.lat, pasajeroData.lng, prev.lat, prev.lng);
    const distCurr = calculateDistance(pasajeroData.lat, pasajeroData.lng, curr.lat, curr.lng);
    return distPrev < distCurr ? prev : curr;
  });

  // 5. BLOQUEO DE ESTADOS
  await Position.updateOne({ email: elMasCercano.email }, { estado: "asignado" });
  await Position.updateOne({ email: pasajeroData.email }, { estado: "asignado" });

  // 🚀 ALERTA 1: Socket al Taxista (Datos del cliente)
  io.to(elMasCercano.email).emit("pasajero_asignado", { ...pasajeroData, excludedEmails });

  // 🚀 ALERTA 2: Socket al Pasajero (¡AQUÍ SE CORRIGE EL TAXI NUMBER!)
  // Usamos buildPayload con el objeto 'elMasCercano' que ya trae el taxiNumber de la DB
  io.to(pasajeroData.email).emit("taxista_asignado", buildPayload(null, elMasCercano, "asignado"));

  // 🚀 ALERTA 3: Push Notification
  enviarNotificacionPush(elMasCercano.email, pasajeroData);

  // 6. Cronómetro de 15 segundos mejorado
  // Limpiamos cualquier timeout previo del mismo taxista por seguridad
  if (pendingTimeouts.has(elMasCercano.email)) {
    clearTimeout(pendingTimeouts.get(elMasCercano.email)!);
  }

  const timeout = setTimeout(async () => {
    const tCheck = await Position.findOne({ email: elMasCercano.email }).lean();

    // Si pasaron 15s y no cambió de estado, saltamos al siguiente
    if (tCheck && tCheck.estado === "asignado") {
      console.log(`⏳ Tiempo agotado para Tx-${elMasCercano.taxiNumber}. Reintentando...`);

      await Position.updateOne({ email: elMasCercano.email }, { estado: "activo" });
      pendingTimeouts.delete(elMasCercano.email);

      // Llamada recursiva con lista negra actualizada
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
    const token = jwt.sign({ email: user.email, name: user.name, role: user.role }, process.env.JWT_SECRET as string, { expiresIn: '30d' });

    res.json({ token, role: user.role, name: user.name, taxiNumber: user.taxiNumber, email: user.email, lastCoords: lastPos ? { lat: lastPos.lat, lng: lastPos.lng } : null });
  } catch (error) {
    res.status(500).json({ message: "Error en login" });
  }
});

app.post("/save-subscription", async (req: Request, res: Response) => {
  const { email, subscription } = req.body;
  try {
    await User.findOneAndUpdate({ email }, { pushSubscription: subscription });
    res.status(200).json({ message: "Suscripción guardada con éxito" });
  } catch (err) {
    res.status(500).json({ message: "Error al guardar suscripción" });
  }
});

// --- SOCKETS ---
io.on("connection", async (socket) => {
  const email = socket.handshake.auth?.email;
  const role = socket.handshake.auth?.role;

  console.log(`Log: Usuario conectado [${email}] con rol [${role}]`);

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

      // 🚨 ESTA ES LA LÍNEA QUE FALTA:
      // Avisamos al pasajero que limpie al taxista actual porque fue rechazado
      io.to(requestEmail).emit("taxi_rejected_request");

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
    // Usamos las constantes 'email' que capturamos arriba 👆
    if (email) {
      console.log(`👻 Detectada desconexión de: ${email}`);

      try {
        // 1. Limpiamos cualquier timeout de reconexión si existía
        if (pendingTimeouts.has(email)) {
          clearTimeout(pendingTimeouts.get(email)!);
          pendingTimeouts.delete(email);
        }

        // 2. Actualizamos la base de datos para que no aparezca en el mapa
        await Position.updateOne({ email: email }, { estado: "desconectado" });

        // 3. Obtenemos el registro para avisar al Panel Central
        const p = await Position.findOne({ email: email });

        // 4. Emitimos el aviso de que este usuario ya NO debe estar en el mapa
        // El Frontend (PanelCentral) recibirá esto y lo borrará de la vista
        io.emit("panel_update", buildPayload(p, p, "desconectado"));

      } catch (error) {
        console.error("Error al procesar desconexión:", error);
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 SERVIDOR EN PUERTO: ${PORT} | AUTO: ${isAutoMode}`);

});
