// src/socket/socketEngine.ts
import { Server } from "socket.io";
import { Position } from "../models/Position";
import { User } from "../models/User";
import { buildPayload } from "../utils/payloadBuilder";
import { pendingTimeouts, isAutoMode } from "../services/dispatchService";
import { registerLocationHandlers } from "./handlers/locationHandler";
import { registerTripHandlers } from "./handlers/tripHandler";
import { logMotor } from "../utils/logger";

export const initSocketEngine = (io: Server) => {
    io.on("connection", async (socket) => {
        const rawEmail = socket.handshake.auth?.email || socket.handshake.query?.email;
        const email = rawEmail ? rawEmail.toString().toLowerCase().trim() : null;
        const role = socket.handshake.auth?.role || socket.handshake.query?.role;

        // 🎯 LOG DE DIAGNÓSTICO:
        logMotor("Conexión Iniciada", `Intento de conexión: Email[${email}] | Role[${role}] | SocketID[${socket.id}]`);

        if (!email || email === "null" || email === "undefined") {
            logMotor("Conexión Rechazada", `Conexión rechazada por credenciales inválidas o vacías.`);
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

            // 🔍 1. Buscamos el viaje activo en la base de datos
            const viajeActivo = await Position.findOne({
                role: "pasajero",
                $or: [
                    { email: email },
                    { taxistaAsignado: email }
                ],
                estado: { $in: ["asignado", "encurso", "encamino", "preasignado"] }
            });

            const currentDoc = await Position.findOne({ email });

            // Seteamos los estados base por defecto por rol
            let nuevoEstado = role === "taxista" ? "activo" : "buscando";

            // 🎯 ESCUDO CRÍTICO DE RECONEXIÓN POR ROLES (BLINDAJE RENDER)
            if (viajeActivo) {
                if (role === "pasajero") {
                    // Si el que se reconecta es el pasajero, preservamos exactamente su estado de viaje
                    nuevoEstado = viajeActivo.estado;
                    logMotor("Conexión Recuperada", `Pasajero ${email} recuperado. Manteniendo viaje en: ${nuevoEstado}`);
                }
                else if (role === "taxista") {
                    // Si el que se reconecta es el taxista, mantenemos su estado de ocupación (encamino o encurso)
                    // mapeándolo con el estado real que lleva el pasajero en la BD
                    nuevoEstado = ["encurso", "encamino"].includes(viajeActivo.estado)
                        ? viajeActivo.estado
                        : "encamino";
                    logMotor("Conexión Recuperada", `Taxista ${email} recuperado en ruta. Manteniendo sincronía en: ${nuevoEstado}`);
                }
            } else if (currentDoc && ["encamino", "encurso", "asignado", "preasignado"].includes(currentDoc.estado)) {
                // Respaldo histórico por documento individual
                nuevoEstado = currentDoc.estado;
            }

            // 🔍 2. Guardamos de forma segura el estado calculado sin machacar el viaje activo
            const updatedPos = await Position.findOneAndUpdate(
                { email },
                { $set: { estado: nuevoEstado, socketId: socket.id, updatedAt: new Date() } },
                { upsert: true, returnDocument: 'after' }
            );

            const allPositions = await Position.find();
            socket.emit("positions", allPositions.map(p => buildPayload(p, p, p.estado || "activo")));
            socket.emit("dispatch_mode_changed", { auto: isAutoMode });

            // 🚀 Rehidratación relámpago para el Taxista
            if (viajeActivo && role === "taxista") {
                setTimeout(() => {
                    logMotor("Rehidratación en Ruta", `Inyectando rehidratación en ruta para taxista: ${email}`);
                    socket.emit("pasajero_asignado", {
                        ...buildPayload(viajeActivo, viajeActivo, nuevoEstado),
                        isNewOffer: false // Falso porque es una reconexión de un viaje que ya existía
                    });
                }, 500);
            }

            // 🚀 Rehidratación relámpago para el Pasajero (CORREGIDA CON PAYLOAD INDUSTRIAL)
            if (viajeActivo && role === "pasajero") {
                if (viajeActivo.taxistaAsignado) {
                    const taxistaData = await Position.findOne({ email: viajeActivo.taxistaAsignado });
                    logMotor("Rehidratación en Ruta", `Inyectando rehidratación relámpago estructurada a pasajero reconectado: ${email} en estado: ${nuevoEstado}`);

                    // Emitimos el payload completo idéntico al que espera la lógica de PasajeroView
                    socket.emit("response_from_taxi", {
                        accepted: true,
                        tEmail: taxistaData?.email || viajeActivo.taxistaAsignado,
                        name: taxistaData?.name || "Taxista",
                        taxiNumber: taxistaData?.taxiNumber || "ECO",
                        lat: taxistaData?.lat || null,
                        lng: taxistaData?.lng || null,
                        estado: nuevoEstado, // "encurso" o "encamino" original preservado
                        rehydrated: true,
                        // 🎯 ADICIÓN CRÍTICA: Inyectamos el payload estructurado del taxista para evitar campos undefined y distancias en cero
                        taxiData: taxistaData ? buildPayload(taxistaData, taxistaData, nuevoEstado) : null
                    });
                }
            }

            io.emit("panel_update", buildPayload(updatedPos, updatedPos, nuevoEstado));
        } catch (error) {
            logMotor("Error en Conexión de Socket", `Error en conexión de socket para ${email}: ${error}`, "ERROR");
        }

        // 🚀 Registramos los listeners modulares inyectando instancias
        registerLocationHandlers(io, socket, email);
        registerTripHandlers(io, socket, email);

        socket.on("reproducir_estado_viaje", async ({ email, role }) => {
            const cleanEmail = email.toLowerCase().trim();
            try {
                if (role === "pasajero") {
                    const miEstado = await Position.findOne({ email: cleanEmail }).lean();

                    if (miEstado && (miEstado.taxistaAsignado || ["encamino", "encurso", "asignado", "preasignado"].includes(miEstado.estado))) {
                        const taxistaEmail = miEstado.taxistaAsignado;
                        const miTaxista = taxistaEmail ? await Position.findOne({ email: taxistaEmail }).lean() : null;

                        const estadoSincronizado = ["encamino", "encurso"].includes(miEstado.estado)
                            ? miEstado.estado
                            : "encamino";

                        logMotor("Rehidratación en Ruta", `Forzando rehidratación estricta para ${cleanEmail} en estado: ${estadoSincronizado}`);

                        return socket.emit("response_from_taxi", {
                            accepted: true,
                            tEmail: taxistaEmail || "",
                            name: miTaxista ? miTaxista.name : "Conductor",
                            taxiNumber: miTaxista ? miTaxista.taxiNumber : "ECO",
                            lat: miTaxista ? miTaxista.lat : null,
                            lng: miTaxista ? miTaxista.lng : null,
                            estado: estadoSincronizado,
                            // 🎯 ADICIÓN CRÍTICA: Payload estructurado en el listener redundante
                            taxiData: miTaxista ? buildPayload(miTaxista, miTaxista, estadoSincronizado) : null
                        });
                    }

                    if (miEstado && miEstado.estado === "buscando") {
                        return socket.emit("trip_status_update", { estado: "buscando" });
                    }

                    socket.emit("trip_status_update", { estado: "pendiente" });
                }
            } catch (err) {
                logMotor("Error en Reproducción de Estado", `Error al reproducir estado del pasajero ${cleanEmail}: ${err}`, "ERROR");
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
                logMotor("Error en Rehidratación de Viaje", `Error al rehidratar el viaje para ${pasajero}: ${err}`, "ERROR");
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
                logMotor("Desconexión Temporal", `Socket cerrado temporalmente para: ${email} | Razón: ${reason}`);
                try {
                    const checkActive = await Position.findOne({ email });

                    if (checkActive && ["encamino", "encurso"].includes(checkActive.estado)) {
                        logMotor("Protección contra Microcortes", `Conservando estado '${checkActive.estado}' para ${email} (Protección contra microcortes).`);
                        await Position.updateOne({ email }, { $set: { socketId: null } });
                        return;
                    }

                    await Position.updateOne({ email }, { $set: { estado: "desconectado", socketId: null, updatedAt: new Date() } });
                    io.emit("panel_update", { email, estado: "desconectado", force: true });
                } catch (error) {
                    logMotor("Error en Desconexión Pasiva", `Error en desconexión pasiva para ${email}: ${error}`, "ERROR");
                }
            }
        });
    });
};