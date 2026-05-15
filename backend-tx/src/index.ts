import * as dotenv from "dotenv";
import express from "express";
import { Request, Response } from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import { connectDB } from "./db";
import { IPosition, Position } from "./models/Position";
import { User } from "./models/User";
import webpush from "web-push";
import adminRoutes from "./routes/adminRoutes";
import authRoutes from "./routes/authRoutes";
import { Trip } from "./models/Trip";
import { reverseGeocode } from "./services/geocodingService";

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
  process.env.FRONTEND_URL,
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

app.use("/api/admin", adminRoutes);
app.use("/api/auth", authRoutes);

const io = new Server(server, {
  cors: corsOptions,
  transports: ['websocket', 'polling'],
  allowEIO3: true,

  // 🚨 AÑADE ESTAS LÍNEAS PARA EL CONTROL DE SEGUNDO PLANO:
  pingInterval: 25000,  // Envía un "ping" cada 25 segundos
  pingTimeout: 120000,  // 👈 ESPERA 2 MINUTOS antes de cerrar el socket (Ideal para Valles)
  upgradeTimeout: 30000 // Tiempo máximo para pasar de polling a websocket
});

connectDB();

const PORT = Number(process.env.PORT) || 3001;
const MAX_RETRIES = 5; // ✋ Límite de taxistas antes de rendirse

let isAutoMode = true;
const pendingTimeouts = new Map<string, NodeJS.Timeout>();

// --- HELPERS ---

const calculateDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
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

    // 🚩 Relaciones pasajero ↔ taxista
    taxistaAsignado: extra.taxistaAsignado || pos?.taxistaAsignado || null,
    pasajeroAsignado: extra.pasajeroAsignado || pos?.pasajeroAsignado || null,

    // 🚩 Push y direcciones
    pushSubscription: extra.pushSubscription || pos?.pushSubscription || user?.pushSubscription || null,
    pickupAddress: extra.pickupAddress || pos?.pickupAddress || user?.pickupAddress || "Calculando ubicación...",
    destinationAddress: extra.destinationAddress || pos?.destinationAddress || user?.destinationAddress || "Destino no especificado",

    // 🚩 Estado con prioridad clara
    estado: estado ?? pos?.estado ?? "cancelado",

    timestamp: new Date().toISOString(),
    ...extra,
  };
}


// 🔔 FUNCIÓN PUSH OPTIMIZADA
const enviarNotificacionPush = async (subscription: any, pasajeroData: any, taxistaEmail: string) => {
  if (!subscription) return;

  try {
    // 🔍 BUSCAMOS LA POSICIÓN DEL TAXISTA PARA CALCULAR DISTANCIA REAL
    const taxistaPos = await Position.findOne({ email: taxistaEmail });

    let distanciaMetros = 0;
    if (taxistaPos && taxistaPos.lat && pasajeroData.lat) {
      const distKM = calculateDistance(
        Number(pasajeroData.lat),
        Number(pasajeroData.lng),
        Number(taxistaPos.lat),
        Number(taxistaPos.lng)
      );
      distanciaMetros = Math.round(distKM * 1000);
    }

    const payload = JSON.stringify({
      notification: {
        title: "¡NUEVO VIAJE DISPONIBLE! 🚕",
        body: `Pasajero: ${pasajeroData.name}\nDistancia: ${distanciaMetros}m`,
        icon: "/icon-192x192.png",
        vibrate: [200, 100, 200, 100, 200],
        // Mantenemos las acciones aquí
        actions: [
          { action: "aceptar", title: "✅ ACEPTAR VIAJE" },
          { action: "rechazar", title: "❌ IGNORAR" }
        ],
        // 💡 RECOMENDACIÓN: Pon la data también dentro de notification para el SW
        data: {
          emailPasajero: pasajeroData.email,
          emailTaxista: taxistaEmail,
          action: "OPEN_TRIP_REQUEST",
          url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/taxista`
        }
      },
      // 🚀 PRO-TIP: Algunos navegadores prefieren la data aquí afuera
      data: {
        emailPasajero: pasajeroData.email,
        emailTaxista: taxistaEmail,
        url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/taxista`
      }
    });

    const options = {
      TTL: 60,
      urgency: 'high' as const,
      headers: { 'Topic': 'nuevos-servicios' }
    };

    await webpush.sendNotification(subscription, payload, options);
    console.log(`🔔 Push enviado con éxito a: ${taxistaEmail}`);
  } catch (error: any) {
    if (error.statusCode === 410 || error.statusCode === 404) {
      console.log(`⚠️ La suscripción de ${taxistaEmail} ha expirado. Limpiando BD...`);
      await Position.updateOne({ email: taxistaEmail }, { $set: { pushSubscription: null } });
      await User.updateOne({ email: taxistaEmail }, { $set: { pushSubscription: null } });
    }
    console.error(`❌ Error en web-push:`, error);
  }
};

// --- 🚩 ENDPOINT PARA EL SERVICE WORKER ---
// Este recibe la acción de "Aceptar" de la notificación
app.post("/api/accept-trip-push", async (req: Request, res: Response) => {
  const { taxistaEmail, pasajeroEmail } = req.body;

  try {
    const tEmail = taxistaEmail.toLowerCase().trim();
    const pEmail = pasajeroEmail.toLowerCase().trim();

    // 1. Limpiar timeouts si existían
    if (pendingTimeouts.has(tEmail)) {
      clearTimeout(pendingTimeouts.get(tEmail)!);
      pendingTimeouts.delete(tEmail);
    }
    if (pendingTimeouts.has(pEmail)) {
      clearTimeout(pendingTimeouts.get(pEmail)!);
      pendingTimeouts.delete(pEmail);
    }

    // 2. Vincular en BD con estados consistentes
    await Position.updateOne({ email: tEmail }, { $set: { estado: "encamino", pasajeroAsignado: pEmail } });
    await Position.updateOne({ email: pEmail }, { $set: { estado: "encamino", taxistaAsignado: tEmail } });

    const tPos = await Position.findOne({ email: tEmail });
    const pPos = await Position.findOne({ email: pEmail });

    // 3. Avisar al Pasajero por Socket
    io.to(pEmail).emit("response_from_taxi", {
      accepted: true,
      tEmail,
      name: tPos?.name || "Conductor",
      taxiNumber: tPos?.taxiNumber || "S/N",
      pickupAddress: pPos?.pickupAddress || "Calculando ubicación...",
      destinationAddress: pPos?.destinationAddress || "Destino no especificado"
    });

    // 4. Avisar al Taxista con confirmación explícita
    io.to(tEmail).emit("assignment_confirmed", {
      success: true,
      pasajero: {
        email: pEmail,
        name: pPos?.name || "Pasajero",
        pickupAddress: pPos?.pickupAddress || "Calculando ubicación...",
        destinationAddress: pPos?.destinationAddress || "Destino no especificado"
      },
      estado: "encamino"
    });

    // 5. Actualizar Panel Admin con payloads completos
    io.emit("panel_update", buildPayload(tPos, tPos, "encamino", { pasajeroAsignado: pEmail }));
    io.emit("panel_update", buildPayload(pPos, pPos, "encamino", { taxistaAsignado: tEmail }));

    console.log(`✅ Viaje vinculado: ${tEmail} -> ${pEmail}`);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error("❌ Error procesando aceptación push:", error);
    res.status(500).json({ error: "Error procesando aceptación push" });
  }
});


const dispatchWithRetry = async (
  pasajeroData: any,
  excludedEmails: string[] = [],
  attempt: number = 1
) => {
  if (!isAutoMode) return;

  // 1. 🛡️ VALIDACIÓN DE SEGURIDAD
  if (!pasajeroData || !pasajeroData.email) {
    console.error("⚠️ Error: Se intentó un reintento pero los datos del pasajero se perdieron.");
    return;
  }

  const pEmail = pasajeroData.email.toLowerCase().trim();
  const currentExcluidos = [...new Set(excludedEmails.map(e => e.toLowerCase().trim()))];

  if (attempt > MAX_RETRIES) {
    console.log(`❌ Límite alcanzado para ${pEmail}`);
    await Position.updateOne({ email: pEmail }, { $set: { estado: "cancelado" } });
    io.to(pEmail).emit("no_taxis_available", { message: "Sin unidades disponibles." });
    return;
  }

  // 2. 🛡️ BÚSQUEDA DE TAXISTAS
  const taxistasCandidatos = await Position.find({
    role: "taxista",
    pushSubscription: { $exists: true, $ne: null },
    estado: "activo",
    email: { $nin: currentExcluidos }
  }).lean() as IPosition[];

  if (taxistasCandidatos.length === 0) {
    console.log(`📭 No hay taxistas con Push activo para ${pEmail}`);
    io.to(pEmail).emit("no_taxis_available", { message: "Buscando conductores..." });
    return;
  }

  // 3. Selección por cercanía
  const elMasCercano = taxistasCandidatos.reduce((prev, curr) => {
    const distPrev = calculateDistance(pasajeroData.lat, pasajeroData.lng, prev.lat, prev.lng);
    const distCurr = calculateDistance(pasajeroData.lat, pasajeroData.lng, curr.lat, curr.lng);
    return distPrev < distCurr ? prev : curr;
  });

  const tEmail = elMasCercano.email.toLowerCase().trim();
  console.log(`🎯 Intentando con Tx-${elMasCercano.taxiNumber} (Estado: ${elMasCercano.estado})`);

  // --- 🚩 PUNTO CLAVE: ASEGURAR DIRECCIÓN UNA SOLA VEZ ---
  if (!pasajeroData.pickupAddress || pasajeroData.pickupAddress.includes("Ubicación:")) {
    console.log("🔄 Generando dirección con colonia para el despacho...");
    pasajeroData.pickupAddress = await reverseGeocode(pasajeroData.lat, pasajeroData.lng);
  }

  // 4. Bloqueo de estados en BD
  // 🚩 SOLO bloqueamos al taxista, el pasajero sigue en "buscando"
  await Position.updateOne(
    { email: tEmail },
    { $set: { estado: "asignado", pasajeroAsignado: pEmail } }
  );

  // 🚩 Nuevo: marcar al pasajero como preasignado
  await Position.updateOne(
    { email: pEmail },
    { $set: { estado: "preasignado" } }
  );

  const pCheck = await Position.findOne({ email: pEmail }).lean();
  console.log(`🔍 Estado pasajero ${pEmail} antes de oferta: ${pCheck?.estado}`);

  // 5. Preparar Payload y Notificar
  const fullPayload = {
    ...pasajeroData,
    email: pEmail,
    pickupAddress: pasajeroData.pickupAddress,
    excludedEmails: currentExcluidos,
    isNewOffer: true,
    attempt
  };

  io.to(tEmail).emit("pasajero_asignado", fullPayload);
  enviarNotificacionPush(elMasCercano.pushSubscription, fullPayload, tEmail);

  // 6. Temporizador de Cascada
  const timeout = setTimeout(async () => {
    const tCheck = await Position.findOne({ email: tEmail }).lean();

    if (tCheck && tCheck.estado === "asignado") {
      console.log(`⏳ Tx-${elMasCercano.taxiNumber} no respondió. Saltando...`);

      const pRefresh = await Position.findOne({ email: pEmail }).lean();

      if (!pRefresh || pRefresh.estado === "cancelado" || pRefresh.estado === "inactivo") {
        console.log(`🛑 El pasajero ${pEmail} ya no busca viaje. Cancelando cascada.`);
        await Position.updateOne({ email: tEmail }, { $set: { estado: "activo" } });
        io.emit("panel_update", { email: pEmail, estado: "cancelado" });
        return;
      }


      io.to(tEmail).emit("dispatch_timeout");
      await Position.updateOne({ email: tEmail }, { $set: { estado: "activo" } });
      io.emit("panel_update", { email: tEmail, estado: "activo" });

      const dataParaSiguiente = {
        ...pasajeroData,
        pickupAddress: pRefresh.pickupAddress || pasajeroData.pickupAddress
      };

      dispatchWithRetry(dataParaSiguiente, [...currentExcluidos, tEmail], attempt + 1);
    }
  }, 22000);

  pendingTimeouts.set(tEmail, timeout);
};


app.post("/save-subscription", async (req: Request, res: Response) => {
  const { email, subscription } = req.body;

  console.log("📩 Recibida solicitud de suscripción para:", email);

  if (!email || !subscription) {
    return res.status(400).json({ message: "Faltan datos (email/subscription)" });
  }

  try {
    const cleanEmail = email.toLowerCase().trim();

    // 1. Actualización en la colección de Usuarios (Perfil)
    const userUpdate = await User.findOneAndUpdate(
      { email: cleanEmail },
      { $set: { pushSubscription: subscription } },
      { returnDocument: "after" }
    );

    // 2. Actualización en la colección de Positions (Despacho)
    // Usamos upsert: false porque si el taxista no ha abierto el mapa, no queremos crear basura, 
    // pero si ya existe, forzamos la actualización.
    const posUpdate = await Position.findOneAndUpdate(
      { email: cleanEmail },
      { $set: { pushSubscription: subscription } },
      { returnDocument: "after", upsert: true }
    );

    if (!userUpdate && !posUpdate) {
      console.log(`⚠️ No se encontró registro para: ${cleanEmail}`);
      return res.status(404).json({ message: "Usuario no encontrado" });
    }

    console.log(`✅ Suscripción guardada físicamente en la BD para ${cleanEmail}`);
    res.status(200).json({
      message: "Suscripción guardada con éxito",
      en_user: !!userUpdate?.pushSubscription,
      en_pos: !!posUpdate?.pushSubscription
    });
  } catch (err) {
    console.error("🔥 Error crítico en save-subscription:", err);
    res.status(500).json({ message: "Error interno del servidor" });
  }
});

app.get("/api/history/:email", async (req: Request, res: Response) => {
  try {
    const email = req.params.email.toLowerCase().trim();
    const viajes = await Trip.find({ taxistaEmail: email }).sort({ fecha: -1 }).limit(50);
    res.json(viajes);
  } catch (error) {
    res.status(500).json({ message: "Error al obtener historial" });
  }
});

// Ruta para mantener el servidor despierto (Ping)
app.get("/ping", (req: Request, res: Response) => {
  console.log("📍 Ping recibido de Cron-job.org - Manteniendo el motor encendido.");
  res.status(200).send("Taxi ECO Valles despierto ✅");
});

// --- SOCKETS ---
io.on("connection", async (socket) => {
  // 1. Normalización y Extracción de Credenciales
  const rawEmail = socket.handshake.auth?.email || socket.handshake.query?.email;
  const email = rawEmail ? rawEmail.toString().toLowerCase().trim() : null;
  const role = socket.handshake.auth?.role || socket.handshake.query?.role;

  if (!email) return;

  // 2. Gestión de Salas (Rooms) - PRIORIDAD ALTA
  socket.join(email);
  console.log(`📡 Conectado y Sala privada creada: ${email} (${role})`);

  // Evento explícito para re-unión manual desde el Frontend
  socket.on("join_room", (roomEmail) => {
    const cleanEmail = roomEmail.toLowerCase().trim();
    socket.join(cleanEmail);
    console.log(`🚪 Re-unión forzada a sala: ${cleanEmail}`);
  });

  try {
    // 3. Sincronización con el "Archivo Maestro" (Users -> Positions)
    const userMaster = await User.findOne({ email });

    if (userMaster) {
      await Position.findOneAndUpdate(
        { email },
        {
          $set: {
            pushSubscription: userMaster.pushSubscription,
            name: userMaster.name,
            taxiNumber: userMaster.taxiNumber,
            role: userMaster.role,
            socketId: socket.id,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
    }

    // 4. BÚSQUEDA DE VIAJE ACTIVO (Para recuperar estado tras desconexión)
    // Si soy taxista, busco si algún pasajero me tiene asignado
    const viajeActivo = await Position.findOne({
      role: "pasajero",
      taxistaAsignado: email,
      estado: { $in: ["asignado", "encurso", "ocupado"] }
    });

    // 5. DETERMINAR ESTADO REAL
    const currentDoc = await Position.findOne({ email });
    let nuevoEstado = role === "taxista" ? "activo" : "buscando";

    // Si soy taxista y tengo un viaje vinculado
    if (viajeActivo) {
      nuevoEstado = (currentDoc?.estado === "encurso" || currentDoc?.estado === "ocupado")
        ? currentDoc.estado
        : "asignado";
    }


    // 6. ACTUALIZAR SOCKET E INFO EN BD
    const updatedPos = await Position.findOneAndUpdate(
      { email },
      {
        $set: {
          estado: nuevoEstado,
          socketId: socket.id,
          updatedAt: new Date()
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    // 7. EMISIONES INICIALES (Mapa y Modo de Despacho)
    const allPositions = await Position.find();
    socket.emit("positions", allPositions.map(p => buildPayload(p, p, p.estado || (p.role === "taxista" ? "activo" : "buscando"))));
    socket.emit("dispatch_mode_changed", { auto: isAutoMode });

    // 8. 🚀 RECUPERACIÓN CRÍTICA (Rehidratación)

    // CASO TAXISTA:
    if (viajeActivo && role === "taxista") {
      setTimeout(() => {
        socket.emit("pasajero_asignado", buildPayload(viajeActivo, viajeActivo, viajeActivo.estado));
        console.log(`✅ Viaje recuperado (TX): Pasajero[${viajeActivo.email}] -> Taxista[${email}]`);
      }, 1000);
    }

    // CASO PASAJERO:
    if (viajeActivo && role === "pasajero") {
      // Si ya tiene taxista asignado, mandamos la info del taxi
      if (viajeActivo.taxistaAsignado) {
        const taxistaData = await Position.findOne({ email: viajeActivo.taxistaAsignado });
        socket.emit("response_from_taxi", {
          accepted: true,
          tEmail: taxistaData?.email,
          name: taxistaData?.name,
          taxiNumber: taxistaData?.taxiNumber,
          lat: taxistaData?.lat,
          lng: taxistaData?.lng,
          rehydrated: true
        });
      } else {
        // Si solo estaba "Buscando", le avisamos que siga en ese estado
        socket.emit("status_rehydration", { estado: "buscando" });
      }
      console.log(`✅ Viaje recuperado (PSJ): ${email} sigue en estado ${viajeActivo.estado}`);
    }

    // 9. AVISAR AL PANEL DE CONTROL
    io.emit("panel_update", buildPayload(updatedPos, updatedPos, nuevoEstado));

  } catch (error) {
    console.error("❌ Error crítico en la conexión de socket:", error);
  }

  // --- 🛣️ PUENTE PARA EL RASTRO EN VIVO (POLYLINE) ---
  socket.on("update_trip_path", async (data: { pasajeroEmail: string, lat: number, lng: number }) => {
    const { pasajeroEmail, lat, lng } = data;

    if (pasajeroEmail) {
      const pEmail = pasajeroEmail.toLowerCase().trim();
      // Le enviamos las coordenadas solo a la sala privada de ese pasajero
      io.to(pEmail).emit("update_trip_path", { lat, lng });

      // Opcional: Log para depuración en la terminal
      // console.log(`📍 Rastro: Enviando punto a ${pEmail} [${lat}, ${lng}]`);
    }
  });

  // 🚩 REHIDRATACIÓN DE VIAJE
  socket.on("rehydrate_trip", async ({ pasajero, taxista }) => {
    try {
      const pPos = await Position.findOne({ email: pasajero });
      const tPos = await Position.findOne({ email: taxista });

      if (pPos && tPos && ["encamino", "encurso"].includes(pPos.estado)) {
        socket.emit("assignment_confirmed", {
          success: true,
          pasajero: buildPayload(pPos, pPos, pPos.estado)
        });

        console.log(`🔄 Rehidratación exitosa: ${taxista} retomó viaje con ${pasajero}`);
      } else {
        console.log(`⚠️ No se encontró viaje activo para rehidratar: ${taxista} / ${pasajero}`);
      }
    } catch (err) {
      console.error("❌ Error en rehidratación:", err);
    }
  });


  // --- 💬 SISTEMA DE CHAT PRIVADO ---
  socket.on("send_message", ({ toEmail, message, fromName }) => {
    if (!toEmail || !message) return;

    const cleanToEmail = toEmail.toLowerCase().trim();
    const cleanFromEmail = email; // Ya lo tienes definido al inicio de la conexión

    console.log(`📩 Chat: [${fromName}] -> [${cleanToEmail}]: ${message}`);

    // Enviamos el mensaje a la sala privada del destinatario
    // Usamos 'receive_message' que es lo que el Frontend está esperando
    io.to(cleanToEmail).emit("receive_message", {
      fromEmail: cleanFromEmail,
      fromName: fromName || "Usuario",
      message: message,
      timestamp: new Date().toISOString()
    });
  });

  socket.on("position", async (data: any) => {
    if (!data.email) return;

    try {
      const currentDoc = await Position.findOne({ email: data.email });
      const finalName = (data.name && !data.name.includes('@')) ? data.name : (currentDoc?.name || data.name);

      // 🛡️ ACTUALIZACIÓN SELECTIVA: Solo tocamos lo que el GPS envía
      const updated = await Position.findOneAndUpdate(
        { email: data.email },
        {
          $set: {
            lat: data.lat,          // Solo latitud
            lng: data.lng,          // Solo longitud
            name: finalName,        // Nombre validado
            estado: data.estado
              || currentDoc?.estado
              || (data.role === "taxista" ? "activo" : "buscando"),
            updatedAt: new Date()   // Fecha de movimiento
            // 💡 NOTA: Al no poner 'pushSubscription' aquí, Mongo NO lo toca.
          }
        },
        { upsert: true, returnDocument: "after" }
      );

      if (updated) {
        io.emit("panel_update", buildPayload(updated, updated, updated.estado));
      }
    } catch (error) {
      console.error("❌ Error en socket position:", error);
    }
  });

  socket.on("taxi_moved", async (data) => {
    const { email, lat, lng, taxiNumber } = data; // Extraemos todo lo que venga del taxista

    // 1. Buscamos al pasajero que tiene a este taxista asignado
    // OJO: Tu consulta usa "Asignado", "EnCurso", "Ocupado" (Case sensitive)
    const pasajeroRelacionado = await Position.findOne({
      taxistaAsignado: email,
      estado: { $in: ["asignado", "encurso", "ocupado", "encamino"] }
    });

    if (pasajeroRelacionado) {
      // 🎯 ENVIAR AL PASAJERO EL PAYLOAD EXACTO
      io.to(pasajeroRelacionado.email).emit("taxi_moved", {
        lat: Number(lat),
        lng: Number(lng),
        email: email,      // Enviamos ambos por seguridad
        tEmail: email,
        taxiNumber: taxiNumber || pasajeroRelacionado.taxiNumber
      });

      // Log para que veas en la terminal si el puente se cruza
      console.log(`📡 Movimiento enviado de Tx[${email}] a Psj[${pasajeroRelacionado.email}]`);
    }
  });
  // 🔄 REPRODUCIR ESTADO (Optimizado para Rehidratación y Notificaciones)
  socket.on("reproducir_estado_viaje", async ({ email, role }) => {
    try {
      const cleanEmail = email.toLowerCase().trim();

      if (role === "taxista") {
        // Buscamos si este taxista tiene algún pasajero vinculado en cualquier estado activo
        const pasajero = await Position.findOne({
          taxistaAsignado: cleanEmail,
          estado: { $in: ["asignado", "encurso", "ocupado", "encamino"] }
        });

        if (pasajero) {
          const payload = buildPayload(pasajero, pasajero, pasajero.estado);

          // 🚩 CLAVE: Si el estado en la BD es "asignado", significa que el taxista 
          // abrió la app (quizás desde una notificación) pero aún no ha aceptado formalmente.
          socket.emit("pasajero_asignado", {
            ...payload,
            isNewOffer: pasajero.estado === "asignado"
          });
        }
      } else if (role === "pasajero") {
        const miEstado = await Position.findOne({ email: cleanEmail });

        if (miEstado?.taxistaAsignado) {
          const miTaxista = await Position.findOne({ email: miEstado.taxistaAsignado });
          if (miTaxista) {
            socket.emit("response_from_taxi", {
              accepted: true,
              tEmail: miTaxista.email,
              name: miTaxista.name,
              taxiNumber: miTaxista.taxiNumber,
              lat: miTaxista.lat,
              lng: miTaxista.lng,
              estado: miEstado.estado === "asignado" ? "asignado" : "encamino"
            });
          }
        }
      }
    } catch (err) {
      console.error("❌ Error al reproducir estado:", err);
    }
  });

  // 🔘 CAMBIO DE MODO DE DESPACHO
  socket.on("toggle_dispatch_mode", (data: { auto: boolean }) => {
    isAutoMode = data.auto;
    io.emit("dispatch_mode_changed", { auto: isAutoMode });
    console.log(`🕹️ Modo de despacho cambiado a: ${isAutoMode ? 'AUTOMÁTICO' : 'MANUAL'}`);
  });

  socket.on("request_taxi", async (pasajeroData: any) => {
    const pEmail = pasajeroData.email.toLowerCase().trim();

    try {
      // 1. Obtenemos la dirección real con tu servicio de geocoding
      const direccionReal = await reverseGeocode(pasajeroData.lat, pasajeroData.lng);

      // 🚩 CORRECCIÓN CRUCIAL:
      // Siempre guardamos al pasajero en estado "buscando"
      const updatedP = await Position.findOneAndUpdate(
        { email: pEmail },
        {
          $set: {
            estado: "buscando",
            pickupAddress: direccionReal,
            lat: pasajeroData.lat,
            lng: pasajeroData.lng,
            updatedAt: new Date()
          }
        },
        { upsert: true, returnDocument: "after" }
      );

      if (updatedP) {
        io.emit("panel_update", buildPayload(updatedP, updatedP, updatedP.estado));
      }


      console.log(`🟢 Pasajero ${pEmail} guardado en estado BUSCANDO (${isAutoMode ? 'auto' : 'manual'})`);

      // 2. Preparamos el paquete de datos con la dirección ya inyectada
      const dataConDireccion = {
        ...pasajeroData,
        pickupAddress: direccionReal,
        email: pEmail
      };

      if (isAutoMode) {
        // 🚀 MOTOR AUTOMÁTICO: ahora sí se asigna desde "buscando"
        dispatchWithRetry(dataConDireccion, [], 1);
      } else {
        // 📢 MODO MANUAL: el panel verá al pasajero en "buscando"
        await Position.updateOne(
          { email: pEmail },
          { $set: { estado: "buscando" } }
        );

        const updatedP = await Position.findOne({ email: pEmail });
        io.emit("panel_update", buildPayload(updatedP, updatedP, "buscando"));

        console.log(`📢 Solicitud manual en Valles: ${pEmail} está en ${direccionReal}`);
      }
    } catch (error) {
      console.error("❌ Error en request_taxi:", error);
      socket.emit("error_message", "Hubo un error al solicitar el taxi. Intenta de nuevo.");
    }
  });


  socket.on("taxi_response", async ({ requestEmail, accepted, excludedEmails = [] }) => {
    // 1. Normalización de emails (Seguridad industrial)
    const tEmailRaw = socket.handshake.auth?.email || socket.handshake.query?.email;
    const tEmail = tEmailRaw?.toLowerCase().trim();
    const pEmail = requestEmail?.toLowerCase().trim();

    if (!tEmail || !pEmail) return;

    // 🛡️ Limpieza de timeouts
    if (pendingTimeouts.has(tEmail)) {
      clearTimeout(pendingTimeouts.get(tEmail)!);
      pendingTimeouts.delete(tEmail);
    }

    // --- ❌ CASO: EL TAXISTA RECHAZA EL VIAJE ---
    if (!accepted) {
      await Position.updateOne({ email: tEmail }, { $set: { estado: "activo" } });
      const tPos = await Position.findOne({ email: tEmail });
      io.emit("panel_update", buildPayload(tPos, tPos, "activo"));

      io.to(pEmail).emit("taxi_rejected_request");

      const pData = await Position.findOne({ email: pEmail });
      if (pData) {
        // Pasamos la lista negra actualizada al siguiente reintento
        dispatchWithRetry(pData, [...excludedEmails, tEmail], 1);
      }
      return;
    }

    // --- ✅ CASO: EL TAXISTA ACEPTA EL VIAJE ---
    try {
      // 📊 Estado actual del pasajero justo al aceptar
      const pEstadoActual = await Position.findOne({ email: pEmail });
      console.log("📊 Estado pasajero justo al aceptar:", pEstadoActual?.estado);

      // 🛡️ CANDADO ATÓMICO: solo si el pasajero sigue en "buscando"
      const pPosActualizado = await Position.findOneAndUpdate(
        {
          email: pEmail, estado: {
            $in: ["buscando", "preasignado", "asignado", "encamino",
              "encurso", "cancelado", "activo"]

          }
        },


        {
          $set: {
            estado: "encamino", // 🚩 sincronizamos aquí
            taxistaAsignado: tEmail
          }
        },
        { returnDocument: "after" }
      );

      if (!pPosActualizado) {
        console.log(`🚫 LATE: El taxista ${tEmail} llegó tarde para el pasajero ${pEmail}`);
        return socket.emit("trip_already_taken", {
          message: "¡Lo sentimos! Otro compañero aceptó este viaje primero."
        });
      }

      // ✅ Vinculamos al taxista en el mismo estado
      await Position.updateOne(
        { email: tEmail },
        { $set: { estado: "encamino", pasajeroAsignado: pEmail } }
      );

      const tPos = await Position.findOne({ email: tEmail });

      // 3. Payload para el Pasajero
      const payloadParaPasajero = {
        accepted: true,
        tEmail,
        name: tPos?.name || "Conductor",
        taxiNumber: tPos?.taxiNumber || "S/N",
        estado: "encamino",
        lat: tPos?.lat,
        lng: tPos?.lng,
        taxiData: buildPayload(tPos, tPos, "encamino")
      };

      io.to(pEmail).emit("response_from_taxi", payloadParaPasajero);

      // 4. Confirmación al Taxista ganador
      socket.emit("assignment_confirmed", {
        success: true,
        pasajero: buildPayload(pPosActualizado, pPosActualizado, "encamino")
      });

      // 5. Panel Administrativo
      io.emit("panel_update", buildPayload(tPos, tPos, "encamino", { pasajeroAsignado: pEmail }));
      io.emit("panel_update", buildPayload(pPosActualizado, pPosActualizado, "encamino", { taxistaAsignado: tEmail }));

      console.log(`✅ Viaje vinculado EXCLUSIVAMENTE: ${tEmail} -> ${pEmail}`);

    } catch (error) {
      console.error("❌ Error en la vinculación del viaje:", error);
      socket.emit("error_message", "Hubo un error al procesar el viaje.");
    }
  });

  socket.on("admin_assign_taxi", async ({ pasajeroEmail, taxistaEmail }) => {
    const pEmail = pasajeroEmail.toLowerCase().trim();
    const tEmail = taxistaEmail.toLowerCase().trim();

    if (pendingTimeouts.has(tEmail)) {
      clearTimeout(pendingTimeouts.get(tEmail)!);
      pendingTimeouts.delete(tEmail);
    }

    const pData = await Position.findOne({ email: pEmail });
    const tData = await Position.findOne({ email: tEmail });

    if (pData && tData) {
      // 1. Actualizamos BD
      await Position.updateOne({ email: tEmail }, { $set: { estado: "asignado", pasajeroAsignado: pEmail } });
      await Position.updateOne({ email: pEmail }, { $set: { estado: "asignado", taxistaAsignado: tEmail } });

      // 2. Emitimos a las SALAS
      io.to(tEmail).emit("pasajero_asignado", buildPayload(pData, pData, "asignado"));
      io.to(pEmail).emit("taxista_asignado", buildPayload(tData, tData, "asignado"));

      // 3. Panel update
      io.emit("panel_update", buildPayload(pData, pData, "asignado"));
      io.emit("panel_update", buildPayload(tData, tData, "asignado"));

      console.log(`🚀 MONITOR: Asignación manual completada [${tEmail} -> ${pEmail}]`);
    }
  });


  socket.on("passenger_on_board", async ({ taxistaEmail, pasajeroEmail }) => {
    try {
      // 🛡️ ESCUDO DE SEGURIDAD: Si no hay emails, cancelamos el proceso
      if (!pasajeroEmail || !taxistaEmail) {
        console.error("⚠️ Intento de Abordo fallido: Datos incompletos", { taxistaEmail, pasajeroEmail });
        return;
      }

      const pEmail = pasajeroEmail.toLowerCase().trim();
      const tEmail = taxistaEmail.toLowerCase().trim();

      await Position.updateOne({ email: tEmail }, { $set: { estado: "encurso" } });
      await Position.updateOne({ email: pEmail }, { $set: { estado: "encurso" } });

      // 🚀 MANDAMOS EL EMAIL TAMBIÉN
      io.to(pEmail).emit("trip_status_update", {
        estado: "encurso",
        pasajeroEmail: pEmail
      });

      // También avisamos al taxista
      io.to(tEmail).emit("trip_status_update", { estado: "encurso" });

      // Avisar al panel
      io.emit("panel_update", { email: pEmail, estado: "encurso" });
      io.emit("panel_update", { email: tEmail, estado: "encurso" });

      console.log(`✅ Viaje EN CURSO: ${tEmail} lleva a ${pEmail}`);

    } catch (error) {
      console.error("❌ Error en passenger_on_board:", error);
    }
  });

  socket.on("passenger_cancel", async ({ pasajeroEmail, taxistaEmail }) => {
    const pEmail = pasajeroEmail.toLowerCase().trim();
    const tEmail = taxistaEmail ? taxistaEmail.toLowerCase().trim() : null;

    // 1. Limpiar cronómetros de búsqueda (si el taxista aún no aceptaba)
    if (tEmail && pendingTimeouts.has(tEmail)) {
      clearTimeout(pendingTimeouts.get(tEmail)!);
      pendingTimeouts.delete(tEmail);
    }

    // 2. DESVINCULACIÓN Y RESET EN BD
    // Quitamos el 'taxistaAsignado' y regresamos a 'activo'
    await Position.updateOne(
      { email: pEmail },
      { $set: { estado: "cancelado", taxistaAsignado: null } }
    );

    if (tEmail) {
      await Position.updateOne(
        { email: tEmail },
        { $set: { estado: "activo", pasajeroAsignado: null } }
      );

      // 3. AVISO PRIVADO AL TAXISTA
      // Para que su app oculte el chat y el marcador del pasajero
      io.to(tEmail).emit("trip_cancelled_by_passenger", {
        message: "El pasajero ha cancelado la solicitud.",
        newStatus: "activo"
      });
    }

    // 4. AVISO GLOBAL (Limpieza de mapas y Panel Admin)
    // Al enviar esto, el PasajeroView ejecutará su lógica de limpieza
    io.emit("trip_finished", {
      pasajeroEmail: pEmail,
      taxistaEmail: tEmail,
      estado: "cancelado"
    });

    // 5. ACTUALIZACIÓN PANEL ADMIN (Monitor de Ciudad Valles)
    io.emit("panel_update", { email: pEmail, estado: "cancelado" });
    if (tEmail) {
      io.emit("panel_update", { email: tEmail, estado: "activo" });
    }

    console.log(`❌ Cancelación procesada: ${pEmail} liberó a ${tEmail || 'N/A'}`);
  });

  socket.on("end_trip", async ({ pasajeroEmail, taxistaEmail }) => {
    const pEmail = pasajeroEmail?.toLowerCase().trim();
    const tEmail = taxistaEmail?.toLowerCase().trim();

    if (!pEmail || !tEmail) {
      console.log("⚠️ Intento de finalizar viaje con datos incompletos.");
      return;
    }

    try {
      // 1. RECUPERAR DATOS ACTUALES (Para nombres y coordenadas antes de limpiar)
      const pPos = await Position.findOne({ email: pEmail });
      const tPos = await Position.findOne({ email: tEmail });

      // 2. GEOPROCESAMIENTO DE DIRECCIONES
      // Obtenemos la dirección donde el taxista está físicamente terminando el viaje
      const direccionDestino = tPos
        ? await reverseGeocode(tPos.lat, tPos.lng)
        : "Destino no detectado";

      // Recuperamos el origen (priorizando lo que ya estaba en BD para no gastar cuota de API)
      const direccionOrigen = pPos?.pickupAddress || (pPos ? await reverseGeocode(pPos.lat, pPos.lng) : "Origen desconocido");

      // 3. GUARDAR EN EL HISTORIAL (Colección Trip)
      const nuevoHistorial = new Trip({
        pasajeroEmail: pEmail,
        pasajeroName: pPos?.name || "Pasajero",
        taxistaEmail: tEmail,
        taxistaName: tPos?.name || "Taxista",
        taxiNumber: tPos?.taxiNumber || "S/N",
        pickupAddress: direccionOrigen,
        destinationAddress: direccionDestino,
        estado: "finalizado",
        fecha: new Date()
      });

      await nuevoHistorial.save();
      console.log(`📖 Historial guardado: ${tEmail} terminó viaje en ${direccionDestino}`);

      // 4. ACTUALIZAR BD (Limpieza de estados)
      await Position.updateOne(
        { email: tEmail },
        {
          $set: {
            estado: "activo", // taxista vuelve a estar disponible
            pasajeroAsignado: null
          }
        }
      );

      await Position.updateOne(
        { email: pEmail },
        {
          $set: {
            estado: "cancelado", // pasajero queda cancelado
            taxistaAsignado: null,
            pickupAddress: null
          }
        }
      );


      // 5. REFRESH DE DATOS PARA EL PANEL (Refactorizado)
      // Buscamos los documentos ya actualizados para tener el "payload" limpio
      const pUpdated = await Position.findOne({ email: pEmail });
      const tUpdated = await Position.findOne({ email: tEmail });

      const payloadFin = {
        pasajeroEmail: pEmail,
        taxistaEmail: tEmail,
        estado: "finalizado",
        pickupAddress: direccionOrigen,
        destinationAddress: direccionDestino
      };

      // 6. NOTIFICACIONES
      // Avisar a las apps móviles
      io.to(pEmail).emit("trip_finished", payloadFin);
      io.to(tEmail).emit("trip_finished", payloadFin);

      // Avisar al Panel Admin con el objeto completo de buildPayload
      // Esto evita que el icono del taxi o pasajero desaparezca o se quede "congelado"
      if (pUpdated) io.emit("panel_update", buildPayload(pUpdated, pUpdated, "finalizado"));
      if (tUpdated) io.emit("panel_update", buildPayload(tUpdated, tUpdated, "activo"));

      console.log(`✅ Viaje finalizado con éxito y panel actualizado.`);

    } catch (error) {
      console.error("❌ Error crítico al finalizar viaje e historial:", error);
      socket.emit("error_message", "Hubo un problema al cerrar el viaje.");
    }
  });
  // Al final de tu main.tsx o index.tsx
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js') // <--- Asegúrate que el nombre coincida
        .then(reg => console.log('✅ Service Worker registrado', reg))
        .catch(err => console.error('❌ Error al registrar SW', err));
    });
  }

  // --- EVENTO DE LOGOUT FORZADO (Solo cuando pica "Cerrar Sesión") ---
  socket.on("force_disconnect", async ({ email }) => {
    if (email) {
      const cleanEmail = email.toLowerCase().trim();
      try {
        if (pendingTimeouts.has(cleanEmail)) {
          clearTimeout(pendingTimeouts.get(cleanEmail)!);
          pendingTimeouts.delete(cleanEmail);
        }

        // 🚩 AQUÍ SÍ borramos de la BD porque es un Logout voluntario
        await Position.updateOne(
          { email: cleanEmail },
          { $set: { estado: "desconectado", updatedAt: new Date() } }
        );

        io.emit("panel_update", {
          email: cleanEmail,
          estado: "desconectado",
          force: true
        });

        console.log(`🚪 Logout manual procesado para: ${cleanEmail}`);
        socket.disconnect(true);
      } catch (error) {
        console.error("Error en force_disconnect:", error);
      }
    }
  });

  // --- GESTIÓN DE DESCONEXIÓN ACCIDENTAL (Pantalla apagada, túneles, internet lento) ---
  socket.on("disconnect", async (reason) => {
    if (email) {
      console.log(`📡 Socket cerrado para: ${email} | Razón: ${reason}`);

      // 🚩 EL CAMBIO CLAVE:
      // NO actualizamos la base de datos a "desconectado". 
      // Jorge se queda en el mapa con su último estado y ubicación.

      // Solo registramos que el socketId ya no es válido para no intentar enviar por ahí
      try {
        await Position.updateOne(
          { email: email },
          { $set: { socketId: null, updatedAt: new Date() } }
        );

        // OPCIONAL: Podrías emitir un evento para que el Admin vea que su icono
        // está "gris" pero sigue ahí, aunque para tu caso es mejor que siga viéndose activo.
        console.log(`✅ ${email} sigue inmortal en el mapa de Valles.`);

      } catch (error) {
        console.error("Error en disconnect pasivo:", error);
      }
    }
  });

});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 SERVIDOR EN PUERTO: ${PORT} | AUTO: ${isAutoMode}`);

});