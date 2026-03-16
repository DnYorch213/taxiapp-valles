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

// 1. Configuración de CORS unificada
const corsOptions = {
  origin: process.env.FRONTEND_URL || "*",
  methods: ["GET", "POST"],
  credentials: true
};

app.use(cors(corsOptions)); // Aplicar a Express
app.use(express.json());

// 2. Configuración de Socket.io robusta
const io = new Server(server, {
  cors: corsOptions, // Usamos la misma config
  transports: ['websocket', 'polling'], // Permitir polling mejora la conexión inicial en Render
  allowEIO3: true // Compatibilidad adicional
});

connectDB();

const PORT = Number(process.env.PORT) || 3001;

// --- VARIABLES GLOBALES Y MAPAS ---
let isAutoMode = true; // Modo de despacho automático por defecto
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
const dispatchWithRetry = async (pasajeroData: any, excludedEmails: string[] = []) => {
  // 1. 🛡️ SI EL MODO CAMBIÓ A MANUAL, DETENEMOS LA CASCADA INMEDIATAMENTE
  if (!isAutoMode) {
    console.log("🛑 Cascada detenida: El sistema pasó a MODO MANUAL.");
    return;
  }

  const checkPasajero = await Position.findOne({ email: pasajeroData.email });

  // 2. 🛡️ SI EL PASAJERO YA TIENE UN TAXI (Asignado manualmente o por otro proceso)
  // Cambiamos la condición para que solo busque si está en "esperando" o "solicitando"
  if (!checkPasajero || ["asignado", "en curso", "ocupado"].includes(checkPasajero.estado)) {
    console.log(`⚠️ Abortando cascada para ${pasajeroData.email}: Ya tiene unidad o canceló.`);
    return;
  }

  const taxistasDisponibles = await Position.find({
    role: "taxista",
    estado: { $in: ["activo", "Disponible"] },
    email: { $nin: excludedEmails }
  });

  if (taxistasDisponibles.length === 0) {
    io.to(pasajeroData.email).emit("no_taxis_available", { message: "No hay conductores disponibles." });
    await Position.updateOne({ email: pasajeroData.email }, { estado: "activo" });
    io.emit("panel_update", { email: pasajeroData.email, estado: "activo" });
    return;
  }

  // ... (Lógica de encontrar al más cercano se mantiene igual) ...
  let elMasCercano = taxistasDisponibles.reduce((prev, curr) => {
    const distPrev = calculateDistance(pasajeroData.lat, pasajeroData.lng, prev.lat, prev.lng);
    const distCurr = calculateDistance(pasajeroData.lat, pasajeroData.lng, curr.lat, curr.lng);
    return distPrev < distCurr ? prev : curr;
  });

  // 3. 🚀 BLOQUEO DE SEGURIDAD
  await Position.updateOne({ email: elMasCercano.email }, { estado: "asignado" });
  await Position.updateOne({ email: pasajeroData.email }, { estado: "asignado" });

  io.to(elMasCercano.email).emit("pasajero_asignado", {
    ...buildPayload(pasajeroData, pasajeroData, "asignado"),
    excludedEmails
  });
  io.to(pasajeroData.email).emit("taxista_asignado", buildPayload(elMasCercano, elMasCercano, "asignado"));

  // 4. EL TIMEOUT AHORA ES MÁS INTELIGENTE
  const timeout = setTimeout(async () => {
    // Re-validamos antes de reintentar: ¿Sigue el taxista en 'asignado'? 
    // Si ya aceptó, su estado será 'ocupado' o 'en curso' y el timeout no debe hacer nada.
    const tCheck = await Position.findOne({ email: elMasCercano.email });
    if (tCheck && tCheck.estado === "asignado") {
      console.log(`⏰ Expiró tiempo de ${elMasCercano.name}. Reintentando...`);
      await Position.updateOne({ email: elMasCercano.email }, { estado: "activo" });
      io.emit("panel_update", { email: elMasCercano.email, estado: "activo" });
      pendingTimeouts.delete(elMasCercano.email);

      // Pasamos a la siguiente iteración
      dispatchWithRetry(pasajeroData, [...excludedEmails, elMasCercano.email]);
    }
  }, 15000);

  pendingTimeouts.set(elMasCercano.email, timeout);
};

// --- RUTAS HTTP ---
app.post("/register", async (req: Request, res: Response) => {
  try {
    const { name, email, password, role, taxiNumber } = req.body;

    // 1. Verificar si el usuario ya existe
    // Esto evita duplicados y permite dar un mensaje claro al cliente
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "El correo electrónico ya está registrado" });
    }

    // 2. Encriptar contraseña
    const hashed = await bcrypt.hash(password, 10);

    // 3. Crear y guardar el usuario
    const user = new User({
      name,
      email,
      password: hashed,
      role,
      taxiNumber: role === "taxista" ? taxiNumber : undefined // Limpieza de datos
    });

    await user.save();

    // 4. Respuesta exitosa
    res.status(201).json({ message: "Usuario registrado con éxito" });

  } catch (err) {
    console.error("Error en registro:", err);
    res.status(500).json({ message: "Error interno al procesar el registro" });
  }
});

app.post("/login", async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // 1. Buscamos al usuario
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: "Credenciales inválidas" });
    }

    // 2. Validamos la contraseña
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(400).json({ message: "Credenciales inválidas" });
    }

    // 3. Buscamos la última posición conocida (opcional para el login)
    const lastPos = await Position.findOne({ email: user.email });

    // 4. Generamos el Token usando la variable de entorno
    // 🛡️ IMPORTANTE: No dejes "SECRET_KEY" como texto plano
    const token = jwt.sign(
      {
        email: user.email,
        name: user.name,
        role: user.role
      },
      process.env.JWT_SECRET as string, // 👈 Usamos la llave del .env
      { expiresIn: '24h' } // ⏳ El token expira en un día por seguridad
    );

    // 5. Respuesta exitosa
    res.json({
      token,
      role: user.role,
      name: user.name,
      taxiNumber: user.taxiNumber,
      email: user.email,
      lastCoords: lastPos ? { lat: lastPos.lat, lng: lastPos.lng } : null
    });

  } catch (error) {
    console.error("Error en Login:", error);
    res.status(500).json({ message: "Error interno del servidor" });
  }
});

// --- LÓGICA DE SOCKETS ---
io.on("connection", async (socket) => {
  const email = socket.handshake.auth?.email;
  const role = socket.handshake.auth?.role; // Es recomendable enviar el rol desde el cliente

  if (email) {
    socket.join(email);
    console.log(`✅ Usuario conectado y unido al room: ${email}`);

    // 🚀 CRUCIAL: Si es taxista, ponerlo como 'activo' para que la cascada lo encuentre
    if (role === "taxista") {
      await Position.updateOne(
        { email: email },
        { estado: "activo", updatedAt: new Date() },
        { upsert: true } // Por si no existe en la colección de posiciones aún
      );
      // Notificar al panel que ahora está en verde
      const updatedPos = await Position.findOne({ email });
      io.emit("panel_update", buildPayload(updatedPos, updatedPos, "activo"));
    }

    socket.emit("dispatch_mode_changed", { auto: isAutoMode });
  }

  const initialPositions = await Position.find();
  socket.emit("positions", initialPositions.map(p => buildPayload(p, p, p.estado || "activo")));

  socket.on("position", async (data: any) => {
    if (!data.email) return;

    // Buscamos el documento actual para no perder el nombre real si el data trae el email
    const currentDoc = await Position.findOne({ email: data.email });

    // Si el nombre en 'data' parece un email y ya tenemos un nombre real, lo protegemos
    const finalName = (data.name && !data.name.includes('@'))
      ? data.name
      : (currentDoc?.name || data.name);

    const updated = await Position.findOneAndUpdate(
      { email: data.email },
      { ...data, name: finalName, updatedAt: new Date() },
      { upsert: true, returnDocument: "after" }
    );
    io.emit("panel_update", buildPayload(updated, updated, updated.estado));
  });

  socket.on("toggle_dispatch_mode", (data: { auto: boolean }) => {
    isAutoMode = data.auto;
    io.emit("dispatch_mode_changed", { auto: isAutoMode });
    console.log(`📡 Modo despacho: ${isAutoMode ? "AUTO" : "MANUAL"}`);
  });

  socket.on("request_taxi", async (pasajeroData: any) => {
    if (isAutoMode) {
      dispatchWithRetry(pasajeroData);
    } else {
      console.log(`👤 Solicitud manual: ${pasajeroData.name}`);

      // 🚀 AGREGA ESTO: Actualiza la DB para que el estado persista
      await Position.updateOne(
        { email: pasajeroData.email },
        { estado: "esperando" }
      );

      // Notifica a todos
      io.emit("panel_update", buildPayload(pasajeroData, pasajeroData, "esperando"));
    }
  });

  socket.on("taxi_response", async ({ requestEmail, accepted, excludedEmails = [] }) => {
    const tEmail = socket.handshake.auth?.email;

    // 1. Limpiar el cronómetro de 30s inmediatamente si existe
    if (pendingTimeouts.has(tEmail)) {
      clearTimeout(pendingTimeouts.get(tEmail)!);
      pendingTimeouts.delete(tEmail);
    }

    // --- CASO: EL TAXISTA RECHAZA EL VIAJE ---
    if (!accepted) {
      console.log(`🚫 Taxista ${tEmail} rechazó. Reintentando con lista acumulada...`);

      // Ponemos al taxista en "activo" para que el panel lo vea libre otra vez
      await Position.updateOne({ email: tEmail }, { estado: "activo" });
      const tPos = await Position.findOne({ email: tEmail });
      io.emit("panel_update", buildPayload(tPos, tPos, "activo"));

      // Buscamos la data del pasajero para saber su ubicación y seguir buscando
      const pasajeroData = await Position.findOne({ email: requestEmail });

      if (pasajeroData) {
        // 🔄 CASCADA: Sumamos este taxista a la lista de excluidos que ya venía
        const nuevaListaExcluidos = [...excludedEmails, tEmail];

        // Llamamos a la función de búsqueda de nuevo
        dispatchWithRetry(pasajeroData, nuevaListaExcluidos);
      }
      return; // Importante: cortamos aquí para no ejecutar la lógica de "aceptado"
    }

    // --- CASO: EL TAXISTA ACEPTA EL VIAJE ---
    console.log(`✅ Taxista ${tEmail} aceptó el viaje para ${requestEmail}`);

    const estadoTaxi = "ocupado";
    const estadoPasajero = "asignado";

    await Position.updateOne({ email: tEmail }, { estado: estadoTaxi });
    await Position.updateOne({ email: requestEmail }, { estado: estadoPasajero });

    const tPos = await Position.findOne({ email: tEmail });
    const pPos = await Position.findOne({ email: requestEmail });

    // Notificar al pasajero
    io.to(requestEmail).emit("response_from_taxi", {
      accepted: true,
      tEmail,
      taxiData: buildPayload(tPos, tPos, estadoTaxi)
    });

    // Notificar al panel administrativo
    io.emit("panel_update", buildPayload(tPos, tPos, estadoTaxi));
    io.emit("panel_update", buildPayload(pPos, pPos, estadoPasajero));
  });

  // --- ASIGNACIÓN MANUAL DESDE EL PANEL ---
  socket.on("admin_assign_taxi", async ({ pasajeroEmail, taxistaEmail }) => {
    // 🛡️ LIMPIEZA PREVENTIVA: Si este taxista estaba en una cascada automática, matamos el proceso.
    if (pendingTimeouts.has(taxistaEmail)) {
      clearTimeout(pendingTimeouts.get(taxistaEmail)!);
      pendingTimeouts.delete(taxistaEmail);
      console.log(`🧹 Admin limpió timeout automático para ${taxistaEmail}`);
    }

    const pasajeroData = await Position.findOne({ email: pasajeroEmail });
    const taxistaData = await Position.findOne({ email: taxistaEmail });

    if (pasajeroData && taxistaData) {
      await Position.updateOne({ email: taxistaEmail }, { estado: "asignado" });
      await Position.updateOne({ email: pasajeroEmail }, { estado: "asignado" });

      // Notificaciones...
      io.to(taxistaEmail).emit("pasajero_asignado", buildPayload(pasajeroData, pasajeroData, "asignado"));
      io.to(pasajeroEmail).emit("taxista_asignado", buildPayload(taxistaData, taxistaData, "asignado"));

      io.emit("panel_update", buildPayload(pasajeroData, pasajeroData, "asignado"));
      io.emit("panel_update", buildPayload(taxistaData, taxistaData, "asignado"));
    }
  });
  // Resto de eventos (on_board, cancel, end_trip, etc.) se mantienen igual
  socket.on("passenger_on_board", async ({ taxistaEmail, pasajeroEmail }) => {
    await Position.updateOne({ email: taxistaEmail }, { estado: "en curso" });
    await Position.updateOne({ email: pasajeroEmail }, { estado: "en curso" });
    io.to(pasajeroEmail).emit("trip_status_update", { status: "en curso" });
    io.emit("panel_update", { email: pasajeroEmail, estado: "en curso" });
  });

  socket.on("passenger_cancel", async ({ pasajeroEmail, taxistaEmail }) => {
    console.log(`‹-- El pasajero ${pasajeroEmail} ha cancelado la solicitud --›`);

    // 1. Si había un taxista con el cronómetro de 30s corriendo, lo detenemos
    if (taxistaEmail && pendingTimeouts.has(taxistaEmail)) {
      clearTimeout(pendingTimeouts.get(taxistaEmail)!);
      pendingTimeouts.delete(taxistaEmail);
      console.log(`🛑 Cronómetro detenido para el taxista ${taxistaEmail}`);
    }

    // 2. Liberamos al pasajero en la DB
    const pPos = await Position.findOneAndUpdate(
      { email: pasajeroEmail },
      { estado: "activo" },
      { returnDocument: 'after' }
    );

    // 3. Si ya había un taxista asignado, lo liberamos también
    if (taxistaEmail) {
      const tPos = await Position.findOneAndUpdate(
        { email: taxistaEmail },
        { estado: "activo" },
        { returnDocument: 'after' }
      );

      // Avisamos al taxista que el viaje se canceló
      io.to(taxistaEmail).emit("trip_cancelled_by_passenger", {
        message: "El pasajero canceló el viaje",
        newStatus: "activo"
      });

      io.emit("panel_update", buildPayload(tPos, tPos, "activo"));
    }

    // 4. Limpiamos el rastro en el panel
    io.emit("panel_update", buildPayload(pPos, pPos, "activo"));
    io.emit("trip_finished", { pasajeroEmail, taxistaEmail, status: "cancelado" });
  });

  socket.on("end_trip", async ({ pasajeroEmail, taxistaEmail }) => {
    await Position.updateOne({ email: taxistaEmail }, { estado: "activo" });
    await Position.updateOne({ email: pasajeroEmail }, { estado: "activo" });
    io.emit("trip_finished", { pasajeroEmail, taxistaEmail, status: "terminado" });
    const tPos = await Position.findOne({ email: taxistaEmail });
    const pPos = await Position.findOne({ email: pasajeroEmail });
    io.emit("panel_update", buildPayload(pPos, pPos, "activo"));
    io.emit("panel_update", buildPayload(tPos, tPos, "activo"));
  });

  // --- EVENTO DE CHAT (Agrégalo aquí) ---
  socket.on("send_message", (data) => {
    const { toEmail, message, senderName } = data;

    console.log(`📩 Reenviando mensaje de ${senderName} para ${toEmail}: ${message}`);

    // IMPORTANTE: io.to(toEmail) envía el mensaje a la sala privada del destinatario
    io.to(toEmail).emit("receive_message", {
      senderName,
      message,
      timestamp: new Date().toISOString()
    });
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

// 2. Escuchamos en el puerto dinámico
server.listen(PORT, "0.0.0.0", () => {
  console.log(`---------------------------------------------------`);
  console.log(`🚀 SERVIDOR ACTIVO EN PUERTO: ${PORT}`);
  console.log(`📡 MODO: ${process.env.NODE_ENV || 'development'}`);
  console.log(`---------------------------------------------------`);
});