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

            const viajeActivo = await Position.findOne({
                role: "pasajero",
                taxistaAsignado: email,
                estado: { $in: ["asignado", "encurso", "encamino", "preasignado"] }
            });

            const currentDoc = await Position.findOne({ email });
            let nuevoEstado = role === "taxista" ? "activo" : "buscando";

            if (viajeActivo) {
                // 🛡️ Si el taxista ya estaba en estado "asignado", RESPETAMOS ese estado 
                // para que no se salte la pantalla de aceptación del viaje.
                if (role === "taxista" && currentDoc?.estado === "asignado") {
                    nuevoEstado = "asignado";
                } else {
                    nuevoEstado = currentDoc?.estado === "encurso" ? "encurso" : currentDoc?.estado === "encamino" ? "encamino" : "asignado";
                }
            }

            const updatedPos = await Position.findOneAndUpdate(
                { email },
                { $set: { estado: nuevoEstado, socketId: socket.id, updatedAt: new Date() } },
                { upsert: true, returnDocument: 'after' }
            );

            const allPositions = await Position.find();
            socket.emit("positions", allPositions.map(p => buildPayload(p, p, p.estado || "activo")));
            socket.emit("dispatch_mode_changed", { auto: isAutoMode });

            if (viajeActivo && role === "taxista") {
                setTimeout(() => {
                    // 🚀 Forzamos que si el estado es asignado, viaje la bandera isNewOffer en true
                    socket.emit("pasajero_asignado", {
                        ...buildPayload(viajeActivo, viajeActivo, nuevoEstado),
                        isNewOffer: nuevoEstado === "asignado"
                    });
                }, 1000);
            }

            if (viajeActivo && role === "pasajero") {
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
                }
            }

            io.emit("panel_update", buildPayload(updatedPos, updatedPos, nuevoEstado));

        } catch (error) {
            console.error("❌ Error en conexión de socket:", error);
        }

        // 🚀 Registramos los listeners modulares inyectando instancias
        registerLocationHandlers(io, socket, email);
        registerTripHandlers(io, socket, email);

        socket.on("reproducir_estado_viaje", async ({ email, role }) => {
            const cleanEmail = email.toLowerCase().trim();
            try {
                if (role === "taxista") {
                    const pasajero = await Position.findOne({ taxistaAsignado: cleanEmail, estado: { $in: ["asignado", "encurso", "encamino"] } });
                    if (pasajero) {
                        socket.emit("pasajero_asignado", { ...buildPayload(pasajero, pasajero, pasajero.estado), isNewOffer: pasajero.estado === "asignado" });
                    } else {
                        socket.emit("trip_status_update", { estado: "activo" });
                    }
                    // src/services/socketEngine.ts o donde manejes "reproducir_estado_viaje"

                } else if (role === "pasajero") {
                    const miEstado = await Position.findOne({ email: cleanEmail });

                    // 🎯 REVISIÓN DE ORO: Si el pasajero tiene registrado un taxistaAsignado,
                    // significa que el viaje está amarrado pase lo que pase, incluso si por un lag
                    // su estado en la BD dice otra cosa temporalmente.
                    if (miEstado && (miEstado.taxistaAsignado || ["encamino", "encurso", "asignado"].includes(miEstado.estado))) {

                        // Buscamos al taxista real usando el campo que guarda su correo
                        const taxistaEmail = miEstado.taxistaAsignado;
                        const miTaxista = taxistaEmail ? await Position.findOne({ email: taxistaEmail }) : null;

                        // Determinamos el estado real: si ya estaba en curso o camino, lo forzamos.
                        // Si por error se movió a buscando, lo rescatamos devolviéndolo a "encamino"
                        const estadoReal = ["encamino", "encurso"].includes(miEstado.estado)
                            ? miEstado.estado
                            : "encamino";

                        console.log(`🛡️ [Rehidratación] Asegurando estado '${estadoReal}' para el pasajero ${cleanEmail} con el taxista ${taxistaEmail}`);

                        // Le clavamos al pasajero su pantalla correcta de viaje activo
                        socket.emit("response_from_taxi", {
                            accepted: true,
                            tEmail: taxistaEmail || "",
                            name: miTaxista ? miTaxista.name : "Conductor",
                            taxiNumber: miTaxista ? miTaxista.taxiNumber : "S/N",
                            lat: miTaxista ? miTaxista.lat : null,
                            lng: miTaxista ? miTaxista.lng : null,
                            estado: estadoReal
                        });

                        // Opcional: Sincronizamos la BD por si el lag la había corrompido
                        if (miEstado.estado !== estadoReal) {
                            await Position.updateOne({ email: cleanEmail }, { $set: { estado: estadoReal } });
                        }

                    } else if (miEstado && miEstado.estado === "buscando") {
                        // Si de verdad no tiene taxista y está buscando legítimamente
                        socket.emit("trip_status_update", { estado: "buscando" });
                    } else {
                        socket.emit("trip_status_update", { estado: "activo" });
                    }
                }
            } catch (err) {
                console.error("Error al reproducir estado:", err);
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