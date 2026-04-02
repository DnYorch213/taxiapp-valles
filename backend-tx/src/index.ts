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
    // 🚩 AGREGAMOS ESTO: Si no viene en 'extra', lo buscamos en 'pos' o 'user'
    pushSubscription: extra.pushSubscription || pos?.pushSubscription || user?.pushSubscription || null,
    pickupAddress: extra.pickupAddress || pos?.pickupAddress || "Dirección opcional",
    estado: estado || pos?.estado || "activo",
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

// 🔔 FUNCIÓN PUSH OPTIMIZADA (Con Sonido y Prioridad)
const enviarNotificacionPush = async (subscription: any, pasajeroData: any, taxistaEmail: string) => {
  if (!subscription) {
    console.log(`⚠️ El taxista ${taxistaEmail} no tiene el 'candadito' activo (sin suscripción).`);
    return;
  }

  const payload = JSON.stringify({
    notification: { // 👈 Envolverlo en 'notification' ayuda a algunos navegadores
      title: "🚕 ¡NUEVO SERVICIO!",
      body: `Cliente: ${pasajeroData.name}\n📍 Toca para ver la ubicación`,
      icon: "/icon-192x192.png", // Asegúrate de tener este icono en tu carpeta public
      vibrate: [200, 100, 200, 100, 200, 100, 400],
      data: {
        url: "/taxista" // Esto lo leerá el Service Worker
      }
    }
  });

  // ✅ CORRECTO: Cumple con lo que pide la librería web-push
  const options = {
    TTL: 60,
    urgency: 'high' as const, // La librería usa 'urgency' para el nivel de prioridad
    headers: {
      // Para FCM (Google/Android), la prioridad se pasa en los headers
      'Urgency': 'high',
      'Topic': 'nuevos-servicios'
    }
  };

  try {
    // 🚀 Pasamos 'options' como tercer argumento
    await webpush.sendNotification(subscription, payload, options);
    console.log(`🔔 Push enviado con éxito a: ${taxistaEmail}`);
  } catch (error: any) {
    if (error.statusCode === 410 || error.statusCode === 404) {
      console.log(`⚠️ Suscripción de ${taxistaEmail} reportada como expirada.`);
    } else {
      console.error(`❌ Error en web-push:`, error);
    }
  }
};

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
  // 1. Captura de datos
  const rawEmail = socket.handshake.auth?.email || socket.handshake.query?.email;
  const email = rawEmail ? rawEmail.toString().toLowerCase().trim() : null;
  const role = socket.handshake.auth?.role || socket.handshake.query?.role;

  console.log(`Log: Usuario conectado [${email}] con rol [${role}]`);

  if (email) {
    socket.join(email);

    // --- 🔥 LÓGICA DE RECONEXIÓN CON RETRASO DE CORTESÍA ---
    // Usamos setTimeout para que el Frontend tenga tiempo de montar el componente
    setTimeout(async () => {
      const checkStatus = await Position.findOne({ email });

      if (checkStatus && role === "taxista" && checkStatus.estado === "asignado") {
        // Buscamos al pasajero vinculado
        const pasajero = await Position.findOne({
          estado: { $in: ["esperando", "asignado"] },
          role: "pasajero"
          // Si guardas taxistaAsignado en el pasajero, úsalo aquí para mayor precisión:
          // taxistaAsignado: email 
        });

        if (pasajero) {
          console.log(`♻️ Sincronización forzada para ${email} (Re-enviando pasajero)`);
          socket.emit("pasajero_asignado", buildPayload(pasajero, pasajero, "asignado"));
        }
      }
    }, 1000); // 1 segundo para estabilizar la conexión en redes móviles

    // 2. Actualización de estado en BD
    const currentDoc = await Position.findOne({ email });
    const updatedPos = await Position.findOneAndUpdate(
      { email },
      {
        $set: {
          // Mantenemos el estado 'asignado' si ya lo tenía, si no, 'activo'
          estado: currentDoc?.estado === "asignado" ? "asignado" : "activo",
          socketId: socket.id,
          updatedAt: new Date()
        }
      },
      { upsert: true, returnDocument: 'after' }
    );

    // 3. Avisar al Panel Central
    io.emit("panel_update", buildPayload(updatedPos, updatedPos, updatedPos.estado));

    // Enviar modo de despacho a admins
    socket.emit("dispatch_mode_changed", { auto: isAutoMode });
  }

  const initialPositions = await Position.find();
  socket.emit("positions", initialPositions.map(p => buildPayload(p, p, p.estado || "activo")));

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

  socket.on("check_my_status", async ({ email }) => {
    const statusDoc = await Position.findOne({ email: email?.toLowerCase() });
    if (statusDoc && statusDoc.estado === "asignado") {
      const p = await Position.findOne({ estado: "asignado", role: "pasajero" });
      if (p) socket.emit("pasajero_asignado", buildPayload(p, p, "asignado"));
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

    // 🚀 CONSTRUCCIÓN DEL PAYLOAD PARA EL PASAJERO
    const payloadParaPasajero = {
      accepted: true,
      tEmail,
      // Enviamos los datos importantes al primer nivel para que el Frontend los lea fácil
      name: tPos?.name || "Conductor",
      taxiNumber: tPos?.taxiNumber || "S/N",
      // Mantenemos taxiData por si lo usas en otra parte del código
      taxiData: buildPayload(tPos, tPos, "ocupado")
    };

    // 1. Avisar al pasajero (Aquí es donde Sara recibe los datos de Jorge)
    io.to(requestEmail).emit("response_from_taxi", payloadParaPasajero);

    // 2. Actualizar el Panel de Admin
    io.emit("panel_update", buildPayload(tPos, tPos, "ocupado"));
    io.emit("panel_update", buildPayload(pPos, pPos, "asignado"));
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

  // --- EVENTO DE LOGOUT FORZADO ---
  socket.on("force_disconnect", async ({ email }) => {
    if (email) {
      const cleanEmail = email.toLowerCase().trim();

      try {
        // 1. Limpiamos cualquier timeout pendiente de este taxista
        if (pendingTimeouts.has(cleanEmail)) {
          clearTimeout(pendingTimeouts.get(cleanEmail)!);
          pendingTimeouts.delete(cleanEmail);
        }

        // 2. Actualizamos la BD de inmediato
        await Position.updateOne(
          { email: cleanEmail },
          { $set: { estado: "desconectado", updatedAt: new Date() } }
        );

        // 3. Avisamos al Panel Central para que lo borre del mapa YA
        io.emit("panel_update", {
          email: cleanEmail,
          estado: "desconectado",
          force: true // Bandera opcional para que el frontend sepa que fue manual
        });

        console.log(`🚪 Logout manual procesado para: ${cleanEmail}`);

        // 4. Desconectamos el socket físicamente desde el servidor
        socket.disconnect(true);

      } catch (error) {
        console.error("Error en force_disconnect:", error);
      }
    }
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
