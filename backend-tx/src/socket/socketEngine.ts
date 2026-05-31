// src/socket/socketEngine.ts
import { Server } from "socket.io";
import { Position } from "../models/Position";
import { User } from "../models/User";
import { buildPayload } from "../utils/payloadBuilder";
import { pendingTimeouts, isAutoMode } from "../services/dispatchService";
import { registerLocationHandlers } from "./handlers/locationHandler";
import { registerTripHandlers } from "./handlers/tripHandler";

export const initSocketEngine = (io: Server) => {
    io.on("connection", async (socket) => {
        const rawEmail = socket.handshake.auth?.email || socket.handshake.query?.email;
        const email = rawEmail ? rawEmail.toString().toLowerCase().trim() : null;
        const role = socket.handshake.auth?.role || socket.handshake.query?.role;

        // 🎯 LOG DE DIAGNÓSTICO:
        console.log(`🔌 Intento de conexión: Email[${email}] | Role[${role}] | SocketID[${socket.id}]`);

        if (!email || email === "null" || email === "undefined") {
            console.log(`⚠️ Conclusión: Conexión rechazada por credenciales inválidas o vacías.`);
            socket.disconnect(true); // Expulsamos limpia y definitivamente sin bucles
            return;
        }
        socket.join(email);

        socket.on("join_room", (roomEmail) => {
            socket.join(roomEmail.toLowerCase().trim());
        });

        try {
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

            // 🔍 Buscamos si hay un viaje activo donde este email participe (como pasajero o como taxista asignado)
            const viajeActivo = await Position.findOne({
                role: "pasajero",
                $or: [
                    { email: email },           // Si el que se conecta es el pasajero
                    { taxistaAsignado: email }  // Si el que se conecta es el taxista
                ],
                estado: { $in: ["asignado", "encurso", "encamino", "preasignado"] }
            });

            const currentDoc = await Position.findOne({ email });

            // Seteamos los estados por defecto iniciales
            let nuevoEstado = role === "taxista" ? "activo" : "buscando";

            // 🎯 CANDADO DE REHIDRATACIÓN PROACTIVO (PROTECCIÓN CONTRA MICROCORTES EN RENDER)
            if (currentDoc && ["encamino", "encurso", "asignado", "preasignado"].includes(currentDoc.estado)) {
                // Si el usuario ya estaba metido en medio de un viaje válido, CONGELAMOS su estado real
                nuevoEstado = currentDoc.estado;
                console.log(`🛡️ [Render Conexión] Detectado parpadeo de red para ${email}. Preservando estado histórico: ${nuevoEstado}`);
            } else if (viajeActivo) {
                // Si no se cumple lo anterior pero hay un registro cruzado activo
                if (role === "taxista" && currentDoc?.estado === "asignado") {
                    nuevoEstado = "asignado";
                } else if (["encurso", "encamino"].includes(currentDoc?.estado ?? "")) {
                    nuevoEstado = currentDoc?.estado ?? "activo";
                }
            }

            // Actualizamos el socketId y mantenemos el estado correcto blindado
            const updatedPos = await Position.findOneAndUpdate(
                { email },
                { $set: { estado: nuevoEstado, socketId: socket.id, updatedAt: new Date() } },
                { upsert: true, returnDocument: 'after' }
            );

            const allPositions = await Position.find();
            socket.emit("positions", allPositions.map(p => buildPayload(p, p, p.estado || "activo")));
            socket.emit("dispatch_mode_changed", { auto: isAutoMode });

            // 🚀 Enviar respuesta inmediata al taxista si se reconectó en viaje
            if (viajeActivo && role === "taxista") {
                setTimeout(() => {
                    socket.emit("pasajero_asignado", {
                        ...buildPayload(viajeActivo, viajeActivo, nuevoEstado),
                        isNewOffer: nuevoEstado === "asignado"
                    });
                }, 1000);
            }

            // 🚀 Enviar respuesta inmediata al pasajero si se reconectó en viaje
            // (¡Esto lo rehidrata de golpe sin esperar a que el frontend parpadee!)
            if (role === "pasajero" && ["encamino", "encurso", "asignado"].includes(nuevoEstado)) {
                const registroPasajero = currentDoc || updatedPos;
                if (registroPasajero?.taxistaAsignado) {
                    const taxistaData = await Position.findOne({ email: registroPasajero.taxistaAsignado });
                    console.log(`📡 Inyectando rehidratación relámpago a pasajero reconectado: ${email}`);
                    socket.emit("response_from_taxi", {
                        accepted: true,
                        tEmail: taxistaData?.email,
                        name: taxistaData?.name,
                        taxiNumber: taxistaData?.taxiNumber,
                        lat: taxistaData?.lat,
                        lng: taxistaData?.lng,
                        estado: nuevoEstado,
                        rehydrated: true
                    });
                }
            }

            io.emit("panel_update", buildPayload(updatedPos, updatedPos, nuevoEstado));

        } catch (error) {
            console.error("❌ Error en conexión de socket:", error);
        }
        // 🚀 Registramos los listeners modulares inyectando instancias
        registerLocationHandlers(io, socket, email);
        registerTripHandlers(io, socket, email);

        // En tu servidor backend, dentro del io.on("connection", (socket) => { ... })

        socket.on("reproducir_estado_viaje", async ({ email, role }) => {
            const cleanEmail = email.toLowerCase().trim();
            try {
                if (role === "pasajero") {
                    // Buscamos el estado real persistido en la base de datos
                    const miEstado = await Position.findOne({ email: cleanEmail }).lean();

                    // 🎯 ESCUDO ABSOLUTO: Si en la base de datos ya figura que tiene un taxista asignado
                    // o está en camino/curso, bajo ninguna circunstancia le permitimos volver a buscar.
                    if (miEstado && (miEstado.taxistaAsignado || ["encamino", "encurso", "asignado", "preasignado"].includes(miEstado.estado))) {

                        const taxistaEmail = miEstado.taxistaAsignado;
                        const miTaxista = taxistaEmail ? await Position.findOne({ email: taxistaEmail }).lean() : null;

                        // Forzamos al estado a mantenerse estable en lo que dicte la BD
                        const estadoSincronizado = ["encamino", "encurso"].includes(miEstado.estado)
                            ? miEstado.estado
                            : "encamino";

                        console.log(`🛡️ [Garantía] Forzando rehidratación estricta para ${cleanEmail} en estado: ${estadoSincronizado}`);

                        // Devolvemos la confirmación total al cliente para congelar su interfaz en la pantalla de viaje
                        return socket.emit("response_from_taxi", {
                            accepted: true,
                            tEmail: taxistaEmail || "",
                            name: miTaxista ? miTaxista.name : "Conductor",
                            taxiNumber: miTaxista ? miTaxista.taxiNumber : "ECO",
                            lat: miTaxista ? miTaxista.lat : null,
                            lng: miTaxista ? miTaxista.lng : null,
                            estado: estadoSincronizado
                        });
                    }

                    // Si de verdad está libre en la base de datos, le permitimos adoptar el estado correspondiente
                    if (miEstado && miEstado.estado === "buscando") {
                        return socket.emit("trip_status_update", { estado: "buscando" });
                    }

                    // Por defecto si no hay nada activo
                    socket.emit("trip_status_update", { estado: "pendiente" });
                }
            } catch (err) {
                console.error("Error al reproducir estado del pasajero:", err);
            }
        });

        socket.on("rehydrate_trip", async ({ pasajero, taxista }) => {
            try {
                const pPos = await Position.findOne({ email: pasajero });
                const tPos = await Position.findOne({ email: taxista });
                if (pPos && tPos && ["encamino", "encurso"].includes(pPos.estado)) {
                    socket.emit("assignment_confirmed", { success: true, pasajero: buildPayload(pPos, pPos, pPos.estado) });
                }
            } catch (err) {
                console.error(err);
            }
        });

        socket.on("force_disconnect", async ({ email: targetEmail }) => {
            if (targetEmail) {
                const cleanEmail = targetEmail.toLowerCase().trim();
                if (pendingTimeouts.has(cleanEmail)) {
                    clearTimeout(pendingTimeouts.get(cleanEmail)!);
                    pendingTimeouts.delete(cleanEmail);
                }
                await Position.updateOne({ email: cleanEmail }, { $set: { estado: "desconectado", socketId: null } });
                io.emit("panel_update", { email: cleanEmail, estado: "desconectado", force: true });
                socket.disconnect(true);
            }
        });

        socket.on("disconnect", async (reason) => {
            if (email) {
                console.log(`📡 Socket cerrado temporalmente para: ${email} | Razón: ${reason}`);
                try {
                    const checkActive = await Position.findOne({ email });

                    if (checkActive && ["encamino", "encurso"].includes(checkActive.estado)) {
                        console.log(`🛡️ Conservando estado '${checkActive.estado}' para ${email} (Protección contra microcortes).`);
                        await Position.updateOne({ email }, { $set: { socketId: null } });
                        return;
                    }

                    await Position.updateOne({ email }, { $set: { estado: "desconectado", socketId: null, updatedAt: new Date() } });
                    io.emit("panel_update", { email, estado: "desconectado", force: true });
                } catch (error) {
                    console.error("Error en disconnect pasivo:", error);
                }
            }
        });
    });
};