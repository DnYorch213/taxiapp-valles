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
    // 🚩 AGREGAMOS ESTO: Si no viene en 'extra', lo buscamos en 'pos' o 'user'
    pushSubscription: extra.pushSubscription || pos?.pushSubscription || user?.pushSubscription || null,
    pickupAddress: extra.pickupAddress || pos?.pickupAddress || "Dirección opcional",
    estado: estado || pos?.estado || "activo",
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
        data: {
          emailPasajero: pasajeroData.email,
          emailTaxista: taxistaEmail,
          url: "/taxista"
        },
        actions: [
          { action: "aceptar", title: "✅ ACEPTAR VIAJE" },
          { action: "rechazar", title: "❌ IGNORAR" }
        ]
      }
    });

    const options = {
      TTL: 60,
      urgency: 'high' as const,
      headers: { 'Topic': 'nuevos-servicios' }
    };

    await webpush.sendNotification(subscription, payload, options);
    console.log(`🔔 Push enviado con éxito a: ${taxistaEmail}`);
  } catch (error) {
    console.error(`❌ Error en web-push:`, error);
  }
};

// --- 🚩 NUEVO ENDPOINT PARA EL SERVICE WORKER ---
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

    // 2. Vincular en BD
    await Position.updateOne({ email: tEmail }, { $set: { estado: "ocupado" } });
    await Position.updateOne({ email: pEmail }, {
      $set: { estado: "asignado", taxistaAsignado: tEmail }
    });

    const tPos = await Position.findOne({ email: tEmail });

    // 3. Avisar al Pasajero por Socket (si está conectado)
    io.to(pEmail).emit("response_from_taxi", {
      accepted: true,
      tEmail: tEmail,
      name: tPos?.name || "Conductor",
      taxiNumber: tPos?.taxiNumber || "S/N"
    });

    // 4. Actualizar Panel Admin
    io.emit("panel_update", { email: tEmail, estado: "ocupado" });
    io.emit("panel_update", { email: pEmail, estado: "asignado" });

    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Error procesando aceptación push" });
  }
});
const dispatchWithRetry = async (pasajeroData: any, excludedEmails: string[] = [], attempt: number = 1) => {
  if (!isAutoMode) return;

  // 1. Límite de seguridad
  if (attempt > MAX_RETRIES) {
    console.log(`❌ Límite alcanzado para ${pasajeroData.email}`);
    await Position.updateOne({ email: pasajeroData.email }, { $set: { estado: "activo" } });
    io.to(pasajeroData.email).emit("no_taxis_available", { message: "Sin unidades disponibles." });
    return;
  }

  // 2. 🛡️ BÚSQUEDA INMORTAL (Basada en Push, no en Socket)
  // Buscamos taxistas que tengan suscripción, sin importar si el socket parpadeó
  const taxistasCandidatos = await Position.find({
    role: "taxista",
    pushSubscription: { $exists: true, $ne: null }, // 🚩 CRUCIAL: Debe tener llave Push
    estado: { $nin: ["EnCurso", "ocupado", "asignado"] }, // Que no estén ocupados
    email: { $nin: excludedEmails } // Que no sea uno que ya rechazó
  }).lean() as IPosition[];

  if (taxistasCandidatos.length === 0) {
    console.log(`📭 No hay taxistas con Push activo para ${pasajeroData.email}`);
    io.to(pasajeroData.email).emit("no_taxis_available", { message: "Buscando conductores..." });
    return;
  }

  // 3. Selección por cercanía (Valles GPS)
  const elMasCercano = taxistasCandidatos.reduce((prev, curr) => {
    const distPrev = calculateDistance(pasajeroData.lat, pasajeroData.lng, prev.lat, prev.lng);
    const distCurr = calculateDistance(pasajeroData.lat, pasajeroData.lng, curr.lat, curr.lng);
    return distPrev < distCurr ? prev : curr;
  });

  console.log(`🎯 Intentando con Tx-${elMasCercano.taxiNumber} (Estado: ${elMasCercano.estado})`);

  // 4. Bloqueo de estados en BD
  await Position.updateOne({ email: elMasCercano.email }, { $set: { estado: "asignado" } });
  await Position.updateOne({ email: pasajeroData.email }, { $set: { estado: "asignado" } });

  // 5. 🔔 NOTIFICACIÓN DUAL ESTRATÉGICA
  // Enviamos por socket (si está conectado la recibe al instante)
  io.to(elMasCercano.email).emit("pasajero_asignado", { ...pasajeroData, attempt });

  // Enviamos el PUSH (el "misil" que lo despierta si el socket murió hace 12 seg)
  enviarNotificacionPush(elMasCercano.pushSubscription, pasajeroData, elMasCercano.email);

  // 6. Temporizador de Cascada
  const timeout = setTimeout(async () => {
    const tCheck = await Position.findOne({ email: elMasCercano.email }).lean();

    if (tCheck && tCheck.estado === "asignado") {
      console.log(`⏳ Tx-${elMasCercano.taxiNumber} no respondió al Push/Socket. Saltando...`);

      // Limpiamos la alerta en el frontend si es que el socket volvió
      io.to(elMasCercano.email).emit("dispatch_timeout");

      // Liberar al taxista para que vuelva a estar disponible
      await Position.updateOne({ email: elMasCercano.email }, { $set: { estado: "activo" } });

      // Actualizar el Panel Central
      io.emit("panel_update", { email: elMasCercano.email, estado: "activo" });

      // Reintento: Pasamos al siguiente más cercano
      dispatchWithRetry(pasajeroData, [...excludedEmails, elMasCercano.email], attempt + 1);
    }
  }, 22000);

  pendingTimeouts.set(elMasCercano.email, timeout);
};

// --- RUTAS HTTP: REGISTRO CON BLOQUEO DE SEGURIDAD ---
app.post("/register", async (req: Request, res: Response) => {
  try {
    const { name, email, password, role, taxiNumber } = req.body;

    // 🛡️ 1. BLOQUEO DE ADMIN (Lo que ya pusimos)
    if (role === "admin") {
      return res.status(403).json({ message: "No puedes registrarte como administrador." });
    }

    // 📧 2. VALIDACIÓN DE FORMATO DE CORREO
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "El formato de correo no es válido." });
    }

    // 🔑 3. VALIDACIÓN DE CONTRASEÑA (Mínimo 6 caracteres)
    if (!password || password.length < 6) {
      return res.status(400).json({ message: "La contraseña debe tener al menos 6 caracteres." });
    }

    // 📝 4. VALIDACIÓN DE NOMBRE (Mínimo 3 caracteres)
    if (!name || name.trim().length < 3) {
      return res.status(400).json({ message: "El nombre es demasiado corto." });
    }

    // 🚖 5. VALIDACIÓN DE NÚMERO DE TAXI (Específica para Cd. Valles)
    if (role === "taxista") {
      const numeroTaxi = parseInt(taxiNumber); // Convertimos a número para validar rango

      if (!taxiNumber || taxiNumber.trim() === "") {
        return res.status(400).json({ message: "El número de unidad es obligatorio." });
      }

      // Validamos que sea un número, que no exceda 3 dígitos y que esté en el rango de Valles (1-849)
      if (isNaN(numeroTaxi) || numeroTaxi < 1 || numeroTaxi > 849) {
        return res.status(400).json({
          message: "Número de unidad inválido. Debe ser entre 1 y 849 (Rango local de Valles)."
        });
      }
    }

    // --- CONTINÚA TU LÓGICA NORMAL ---
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: "El correo ya existe" });

    const hashed = await bcrypt.hash(password, 10);
    const user = new User({
      name: name.trim(),
      email: email.toLowerCase().trim(), // Guardamos siempre en minúsculas para evitar errores
      password: hashed,
      role,
      taxiNumber: role === "taxista" ? taxiNumber.trim() : undefined
    });

    await user.save();
    res.status(201).json({ message: "Usuario registrado con éxito" });

  } catch (err) {
    res.status(500).json({ message: "Error en el servidor al registrar" });
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
      estado: { $in: ["asignado", "en curso", "ocupado"] }
    });

    // 5. DETERMINAR ESTADO REAL (Persistencia de "En Curso")
    const currentDoc = await Position.findOne({ email });
    let nuevoEstado = "activo";

    if (viajeActivo) {
      // Si el documento dice "en curso", mantenemos la sesión de viaje viva
      nuevoEstado = (currentDoc?.estado === "en curso" || currentDoc?.estado === "ocupado")
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
    socket.emit("positions", allPositions.map(p => buildPayload(p, p, p.estado || "activo")));
    socket.emit("dispatch_mode_changed", { auto: isAutoMode });

    // 8. 🚀 RECUPERACIÓN CRÍTICA (Rehidratación de Interfaz)
    if (viajeActivo && role === "taxista") {
      setTimeout(() => {
        // Enviamos al taxista los datos del pasajero que lo está esperando
        // Importante: Mandamos el estado REAL del pasajero para que los botones coincidan
        socket.emit("pasajero_asignado", buildPayload(viajeActivo, viajeActivo, viajeActivo.estado));
        console.log(`✅ Viaje recuperado: Pasajero[${viajeActivo.email}] -> Taxista[${email}]`);
      }, 1000);
    }

    // 9. AVISAR AL PANEL DE CONTROL
    io.emit("panel_update", buildPayload(updatedPos, updatedPos, nuevoEstado));

  } catch (error) {
    console.error("❌ Error crítico en la conexión de socket:", error);
  }

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
            estado: data.estado || currentDoc?.estado || "activo",
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
      estado: { $in: ["Asignado", "en curso", "ocupado", "EnCamino", "asignado"] }
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
  // 🔄 REPRODUCIR ESTADO (Optimizado)
  socket.on("reproducir_estado_viaje", async ({ email, role }) => {
    try {
      const cleanEmail = email.toLowerCase().trim();

      if (role === "taxista") {
        const pasajero = await Position.findOne({
          taxistaAsignado: cleanEmail,
          estado: { $in: ["asignado", "en curso", "ocupado"] }
        });

        if (pasajero) {
          socket.emit("pasajero_asignado", buildPayload(pasajero, pasajero, pasajero.estado));
        }
      } else if (role === "pasajero") {
        const miEstado = await Position.findOne({ email: cleanEmail });

        if (miEstado?.taxistaAsignado) {
          const miTaxista = await Position.findOne({ email: miEstado.taxistaAsignado });
          if (miTaxista) {
            // 🚩 IMPORTANTE: El pasajero espera "response_from_taxi" para activar su UI
            socket.emit("response_from_taxi", {
              accepted: true,
              tEmail: miTaxista.email,
              name: miTaxista.name,
              taxiNumber: miTaxista.taxiNumber,
              lat: miTaxista.lat,
              lng: miTaxista.lng,
              estado: miEstado.estado === "asignado" ? "Asignado" : "EnCamino"
            });
          }
        }
      }
    } catch (err) {
      console.error("❌ Error al reproducir estado:", err);
    }
  });

  socket.on("toggle_dispatch_mode", (data: { auto: boolean }) => {
    isAutoMode = data.auto;
    io.emit("dispatch_mode_changed", { auto: isAutoMode });
  });

  socket.on("request_taxi", async (pasajeroData: any) => {
    const pEmail = pasajeroData.email.toLowerCase().trim();

    if (isAutoMode) {
      dispatchWithRetry(pasajeroData, [], 1);
    } else {
      // 🚩 IMPORTANTE: Actualizar BD y avisar al mundo
      await Position.updateOne({ email: pEmail }, { $set: { estado: "esperando" } });

      // Obtenemos los datos completos para que el panel tenga el nombre y el icono
      const updatedP = await Position.findOne({ email: pEmail });
      io.emit("panel_update", buildPayload(updatedP, updatedP, "esperando"));

      console.log(`📢 Solicitud manual detectada en panel para: ${pEmail}`);
    }
  });

  socket.on("taxi_response", async ({ requestEmail, accepted, excludedEmails = [] }) => {
    const tEmail = socket.handshake.auth?.email || socket.handshake.query?.email;

    if (pendingTimeouts.has(tEmail)) {
      clearTimeout(pendingTimeouts.get(tEmail)!);
      pendingTimeouts.delete(tEmail);
    }

    // --- CASO: EL TAXISTA RECHAZA EL VIAJE ---
    if (!accepted) {
      await Position.updateOne({ email: tEmail }, { $set: { estado: "activo" } });
      const tPos = await Position.findOne({ email: tEmail });
      io.emit("panel_update", buildPayload(tPos, tPos, "activo"));

      // Avisamos al pasajero para que limpie la UI del taxista que rechazó
      io.to(requestEmail).emit("taxi_rejected_request");

      const pData = await Position.findOne({ email: requestEmail });
      if (pData) dispatchWithRetry(pData, [...excludedEmails, tEmail], 1);
      return;
    }

    // --- CASO: EL TAXISTA ACEPTA EL VIAJE (Refactorizado) ---
    try {
      // 1. Sincronizamos estados en la Base de Datos (Ambos como "Asignado")
      await Position.updateOne(
        { email: tEmail },
        { $set: { estado: "Asignado" } }
      );

      await Position.updateOne(
        { email: requestEmail },
        {
          $set: {
            estado: "Asignado",
            taxistaAsignado: tEmail
          }
        }
      );

      // 2. Obtenemos la posición actual del taxista para el mapa del pasajero
      const tPos = await Position.findOne({ email: tEmail });
      const pPos = await Position.findOne({ email: requestEmail });

      // 3. Construimos el Payload "Inmortal" para el Pasajero
      const payloadParaPasajero = {
        accepted: true,
        tEmail: tEmail,
        name: tPos?.name || "Conductor",
        taxiNumber: tPos?.taxiNumber || "S/N",
        estado: "Asignado", // Coincide con el if de React
        lat: tPos?.lat,     // 🚩 Crucial para que el marcador aparezca YA
        lng: tPos?.lng,     // 🚩 Crucial para que el marcador aparezca YA
        taxiData: buildPayload(tPos, tPos, "Asignado")
      };

      // 4. Enviamos la señal de éxito al Pasajero
      io.to(requestEmail).emit("response_from_taxi", payloadParaPasajero);

      // 5. Actualizamos el Panel Administrativo
      io.emit("panel_update", buildPayload(tPos, tPos, "Asignado"));
      io.emit("panel_update", buildPayload(pPos, pPos, "Asignado"));

      console.log(`✅ Viaje vinculado: [${tEmail}] recogerá a [${requestEmail}]`);

    } catch (error) {
      console.error("❌ Error en la vinculación del viaje:", error);
    }
  });

  socket.on("admin_assign_taxi", async ({ pasajeroEmail, taxistaEmail }) => {
    const pEmail = pasajeroEmail.toLowerCase().trim();
    const tEmail = taxistaEmail.toLowerCase().trim();

    // Limpiar timeouts
    if (pendingTimeouts.has(tEmail)) {
      clearTimeout(pendingTimeouts.get(tEmail)!);
      pendingTimeouts.delete(tEmail);
    }

    const pData = await Position.findOne({ email: pEmail });
    const tData = await Position.findOne({ email: tEmail });

    if (pData && tData) {
      // 1. Actualizamos BD
      await Position.updateOne({ email: tEmail }, { $set: { estado: "asignado" } });
      await Position.updateOne({ email: pEmail }, { $set: { estado: "asignado", taxistaEmail: tEmail } });

      // 2. Emitimos a las SALAS (Rooms)
      io.to(tEmail).emit("pasajero_asignado", buildPayload(pData, pData, "asignado"));
      io.to(pEmail).emit("taxista_asignado", buildPayload(tData, tData, "asignado"));

      // 3. ACTUALIZAMOS AL MONITOR (Esto da la "acción" al panel)
      // Enviamos ambos updates para que las listas del panel se muevan solas
      io.emit("panel_update", buildPayload(pData, pData, "asignado"));
      io.emit("panel_update", buildPayload(tData, tData, "asignado"));

      console.log(`🚀 MONITOR: Asignación manual completada [${tEmail} -> ${pEmail}]`);
    }
  });

  socket.on("passenger_on_board", async ({ taxistaEmail, pasajeroEmail }) => {
    const pEmail = pasajeroEmail.toLowerCase().trim();
    const tEmail = taxistaEmail.toLowerCase().trim();

    await Position.updateOne({ email: tEmail }, { $set: { estado: "en curso" } });
    await Position.updateOne({ email: pEmail }, { $set: { estado: "en curso" } });

    // 🚀 MANDAMOS EL EMAIL TAMBIÉN
    // Esto permite que el PasajeroView haga: if(data.pasajeroEmail === miEmail)
    io.to(pEmail).emit("trip_status_update", {
      estado: "EnCurso",
      pasajeroEmail: pEmail
    });

    // Avisar al panel
    io.emit("panel_update", { email: pEmail, estado: "EnCurso" });
    io.emit("panel_update", { email: tEmail, estado: "EnCurso" });
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
      { $set: { estado: "activo", taxistaAsignado: null } }
    );

    if (tEmail) {
      await Position.updateOne(
        { email: tEmail },
        { $set: { estado: "activo" } }
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
    io.emit("panel_update", { email: pEmail, estado: "activo" });
    if (tEmail) {
      io.emit("panel_update", { email: tEmail, estado: "activo" });
    }

    console.log(`❌ Cancelación procesada: ${pEmail} liberó a ${tEmail || 'N/A'}`);
  });

  socket.on("end_trip", async ({ pasajeroEmail, taxistaEmail }) => {
    // 1. Limpieza de datos (Evitamos errores si vienen undefined)
    const pEmail = pasajeroEmail?.toLowerCase().trim();
    const tEmail = taxistaEmail?.toLowerCase().trim();

    if (!pEmail || !tEmail) return;

    // 2. Actualizar BD (Muy bien hecho con updateMany)
    await Position.updateMany(
      { email: { $in: [pEmail, tEmail] } },
      { $set: { estado: "activo", taxistaAsignado: null } }
    );

    const payload = {
      pasajeroEmail: pEmail,
      taxistaEmail: tEmail, // Agregamos esto
      estado: "finalizado"
    };

    // 🚩 LA CLAVE: Si no usas Rooms, usa io.emit para pruebas. 
    // Si usas Rooms, asegúrate de que ambos hicieron .join()
    io.emit("trip_finished", payload);

    // Notificar al panel de administración
    io.emit("panel_update", { email: pEmail, estado: "activo" });
    io.emit("panel_update", { email: tEmail, estado: "activo" });

    console.log(`✅ Viaje finalizado exitosamente entre ${tEmail} y ${pEmail}`);
  });

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
