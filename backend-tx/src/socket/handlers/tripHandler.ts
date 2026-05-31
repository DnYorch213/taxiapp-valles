// src/socket/handlers/tripHandler.ts
import { Server, Socket } from "socket.io";
import { Position } from "../../models/Position";
import { Trip } from "../../models/Trip";
import { buildPayload } from "../../utils/payloadBuilder";
import { reverseGeocode } from "../../services/geocodingService";
import { dispatchWithRetry, pendingTimeouts } from "../../services/dispatchService";

export const registerTripHandlers = (io: Server, socket: Socket, email: string) => {

    socket.on("request_taxi", async (data: any) => {
        const pEmail = data.email?.toLowerCase().trim();
        if (!pEmail) return;

        try {
            // 🎯 CONTROL CRÍTICO: Revisamos el registro real en MongoDB antes de mover una sola línea
            const viajeActivo = await Position.findOne({ email: pEmail }).lean();

            // Si ya tiene un taxista asignado o está en camino/curso/preasignado, ignoramos el evento en seco
            if (viajeActivo && (viajeActivo.taxistaAsignado || ["encamino", "encurso", "asignado", "preasignado"].includes(viajeActivo.estado))) {
                console.log(`🛡️ [Escudo Sockets] Abortado request_taxi duplicado para ${pEmail}. Viaje activo: ${viajeActivo.estado}`);

                // Rehidratamos al pasajero forzando a su frontend a mantenerse en el viaje real
                return socket.emit("response_from_taxi", {
                    accepted: true,
                    tEmail: viajeActivo.taxistaAsignado || "",
                    name: "Conductor",
                    estado: viajeActivo.estado
                });
            }

            // 🟢 SI ESTÁ COMPLETA Y LEGÍTIMAMENTE LIBRE, CONTINÚA TU FLUJO NORMAL:
            const currentRequestId = new Date().getTime().toString();
            console.log(`🚕 [Motor] Solicitud entrante legítima de: ${pEmail} (ID: ${currentRequestId})`);

            await Position.findOneAndUpdate(
                { email: pEmail },
                {
                    $set: {
                        estado: "buscando",
                        lat: data.lat,
                        lng: data.lng,
                        name: data.name || "Pasajero",
                        role: "pasajero",
                        taxistaAsignado: null,
                        pasajeroAsignado: currentRequestId,
                        updatedAt: new Date()
                    }
                },
                { upsert: true, returnDocument: "after" }
            );

            // ... Tu lógica de geocodificación silenciosa y el dispatchWithRetry abajo ...

            // 🚀 3. Geocodificación silenciosa en segundo plano (ULTRA-BLINDADA)
            let pickupAddress = data.pickupAddress || null;
            if (!pickupAddress || pickupAddress.includes("Ubicación:")) {
                reverseGeocode(data.lat, data.lng).then(async (direccion) => {

                    // 🎯 CANDADO DE ESTADO: Consultamos cómo está el pasajero JUSTO AHORA en MongoDB
                    const validacionP = await Position.findOne({ email: pEmail }).lean();

                    // 🛡️ Si el viaje ya se consolidó con Jorge o Yorchi, ABORTAMOS. No tocamos la BD a mitad de ruta.
                    if (validacionP && ["encamino", "encurso", "asignado", "preasignado"].includes(validacionP.estado)) {
                        console.log(`🛡️ [Geocoding] Ignorando dirección tardía (${direccion}) para ${pEmail}. El viaje ya está en curso/camino.`);
                        return; // 🛑 Salimos en seco sin modificar nada en MongoDB
                    }

                    // Si sigue buscando legítimamente y el ID coincide, guardamos de forma segura
                    if (validacionP && validacionP.pasajeroAsignado === currentRequestId) {
                        await Position.updateOne({ email: pEmail }, { $set: { pickupAddress: direccion } });
                        console.log(`✅ DIRECCIÓN GENERADA E INYECTADA: ${direccion} para ${pEmail}`);
                    }

                }).catch(err => console.error("❌ Error geocode silencioso:", err));
            }

            const pasajeroPayload = {
                email: pEmail,
                name: data.name || "Pasajero",
                lat: data.lat,
                lng: data.lng,
                pickupAddress: pickupAddress || "Calculando ubicación...",
                requestId: currentRequestId
            };

            console.log(`🤖 [Motor] Buscando la unidad más cercana...`);

            // 4. Despertamos al motor asegurando que la BD ya se actualizó
            dispatchWithRetry(io, pasajeroPayload, [], 1);

        } catch (error) {
            console.error("❌ Error crítico en request_taxi:", error);
        }
    });

    socket.on("taxi_response", async ({ requestEmail, accepted, excludedEmails = [] }) => {
        const tEmail = email; // El email del taxista dueño de este socket
        const pEmail = requestEmail?.toLowerCase().trim();
        if (!tEmail || !pEmail) return;

        // 🎯 MODIFICACIÓN 1: Limpieza preventiva por Pasajero
        // Si el taxista responde (ya sea aceptando o rechazando), limpiamos de inmediato 
        // el timeout de búsqueda activa indexado con el correo de este pasajero.
        if (pendingTimeouts.has(pEmail)) {
            clearTimeout(pendingTimeouts.get(pEmail));
            pendingTimeouts.delete(pEmail);
            console.log(`🛑 [Motor] Timeout de búsqueda cancelado para el pasajero: ${pEmail}`);
        }

        // 🚨 CASO: EL TAXISTA RECHAZA EL VIAJE
        if (!accepted) {
            await Position.updateOne({ email: tEmail }, { $set: { estado: "activo" } });
            const tPos = await Position.findOne({ email: tEmail });
            io.emit("panel_update", buildPayload(tPos, tPos, "activo"));
            io.to(pEmail).emit("taxi_rejected_request");

            const pData = await Position.findOne({ email: pEmail });

            // Al ejecutarse dispatchWithRetry, creará un NUEVO timeout guardado bajo la clave 'pEmail'
            if (pData) dispatchWithRetry(io, pData, [...excludedEmails, tEmail], 1);
            return;
        }

        // 🚖 CASO: EL TAXISTA ACEPTA EL VIAJE
        try {
            const pPosActualizado = await Position.findOneAndUpdate(
                { email: pEmail, estado: { $in: ["buscando", "preasignado", "activo"] } },
                { $set: { estado: "encamino", taxistaAsignado: tEmail } },
                { returnDocument: "after" }
            );

            if (!pPosActualizado) {
                return io.to(tEmail).emit("trip_already_taken", { message: "¡Lo sentimos! Solicitud expirada o tomada por otro compañero." });
            }

            // 🎯 MODIFICACIÓN 2: Por seguridad extrema ante asincronías drásticas,
            // si un timeout colgado intentó reaparecer justo en este milisegundo, lo volvemos a fulminar
            if (pendingTimeouts.has(pEmail)) {
                clearTimeout(pendingTimeouts.get(pEmail));
                pendingTimeouts.delete(pEmail);
            }

            await Position.updateOne({ email: tEmail }, { $set: { estado: "encamino", pasajeroAsignado: pEmail } });
            const tPos = await Position.findOne({ email: tEmail });

            io.to(pEmail).emit("response_from_taxi", {
                accepted: true,
                tEmail,
                name: tPos?.name || "Conductor",
                taxiNumber: tPos?.taxiNumber || "S/N",
                estado: "encamino",
                lat: tPos?.lat,
                lng: tPos?.lng,
                taxiData: buildPayload(tPos, tPos, "encamino")
            });

            io.to(tEmail).emit("assignment_confirmed", { success: true, pasajero: buildPayload(pPosActualizado, pPosActualizado, "encamino") });
            io.to(tEmail).emit("trip_status_update", { estado: "encamino" });
            io.to(pEmail).emit("trip_status_update", { estado: "encamino" });

            io.emit("panel_update", buildPayload(tPos, tPos, "encamino", { pasajeroAsignado: pEmail }));
            io.emit("panel_update", buildPayload(pPosActualizado, pPosActualizado, "encamino", { taxistaAsignado: tEmail }));
        } catch (error) {
            console.error(error);
        }
    });

    // En el backend:
    socket.on("send_message", ({ toEmail, message, fromName }) => {
        const destinatario = toEmail?.toLowerCase().trim();
        if (!destinatario) return;

        // Redirige el mensaje directo al canal del destinatario
        io.to(destinatario).emit("receive_message", {
            fromName: fromName || "Sistema",
            message: message,
            timestamp: new Date().toISOString()
        });
    });

    socket.on("passenger_on_board", async ({ taxistaEmail, pasajeroEmail }) => {
        if (!pasajeroEmail || !taxistaEmail) return;
        const pEmail = pasajeroEmail.toLowerCase().trim();
        const tEmail = taxistaEmail.toLowerCase().trim();

        try {
            console.log(`🚖 [Viaje] Pasajero ${pEmail} a bordo de la unidad de ${tEmail}. Iniciando viaje en curso.`);

            // 🎯 1. FULMINAMOS CUALQUIER HILO O TIMEOUT RESIDUAL DEL DISPATCHER
            if (pendingTimeouts.has(pEmail)) {
                clearTimeout(pendingTimeouts.get(pEmail));
                pendingTimeouts.delete(pEmail);
                console.log(`🧹 [Viaje] Limpiados hilos residuales del dispatcher para el pasajero: ${pEmail}`);
            }

            // 2. Actualizamos de forma segura los estados en la base de datos
            await Position.updateOne({ email: tEmail }, { $set: { estado: "encurso", updatedAt: new Date() } });
            await Position.updateOne({ email: pEmail }, { $set: { estado: "encurso", updatedAt: new Date() } });

            // Extraemos los documentos frescos y actualizados con sus variables intactas
            const pPos = await Position.findOne({ email: pEmail });
            const tPos = await Position.findOne({ email: tEmail });

            // 3. Notificaciones dirigidas y estructuradas a los canales privados de los usuarios
            io.to(pEmail).emit("trip_status_update", {
                estado: "encurso",
                pasajeroEmail: pEmail,
                taxiData: tPos ? buildPayload(tPos, tPos, "encurso") : null
            });
            io.to(tEmail).emit("trip_status_update", { estado: "encurso" });

            // 🎯 4. CORRECCIÓN CRÍTICA: Emetimos payloads completos e industriales a los paneles globales
            if (pPos) io.emit("panel_update", buildPayload(pPos, pPos, "encurso"));
            if (tPos) io.emit("panel_update", buildPayload(tPos, tPos, "encurso"));

        } catch (error) {
            console.error("❌ Error en passenger_on_board:", error);
        }
    });

    // src/socket/handlers/tripHandler.ts

    socket.on("passenger_cancel", async ({ pasajeroEmail, taxistaEmail }) => {
        const pEmail = pasajeroEmail.toLowerCase().trim();
        const tEmail = taxistaEmail ? taxistaEmail.toLowerCase().trim() : null;

        // 🛡️ REVISIÓN EN TIEMPO REAL: ¿El pasajero de verdad está buscando o asignado?
        const estadoActualDoc = await Position.findOne({ email: pEmail }).lean();

        // Si en la base de datos ya está pendiente, inactivo o cancelado, bloqueamos el evento
        if (!estadoActualDoc || ["pendiente", "inactivo", "cancelado"].includes(estadoActualDoc.estado)) {
            // console.log(`🚫 Cancelación bloqueada para ${pEmail}: Su estado ya es ${estadoActualDoc?.estado}`);
            return; // 🛑 Cerramos la puerta y no hacemos nada
        }

        console.log(`❌ Cancelación definitiva: El pasajero ${pEmail} abortó la solicitud.`);

        // 1. Matamos el temporizador de la cascada de inmediato si existía
        if (tEmail && pendingTimeouts.has(tEmail)) {
            clearTimeout(pendingTimeouts.get(tEmail)!);
            pendingTimeouts.delete(tEmail);
            console.log(`🗑️ Cascada cancelada por el pasajero para el taxista: ${tEmail}`);
        }

        // 2. IMPORTANTE: Marcamos al pasajero como "cancelado" o "inactivo" para romper su bucle en React
        await Position.updateOne(
            { email: pEmail },
            { $set: { estado: "cancelado", taxistaAsignado: null, pickupAddress: null } }
        );

        // 3. Liberamos al taxista para que vuelva a recibir viajes
        if (tEmail) {
            await Position.updateOne(
                { email: tEmail },
                { $set: { estado: "activo", pasajeroAsignado: null } }
            );
            // Avisamos a la app del taxista para que limpie el mapa y oculte alertas
            io.to(tEmail).emit("trip_cancelled_by_passenger", {
                message: "El pasajero ha cancelado la solicitud.",
                newStatus: "activo"
            });
            io.to(tEmail).emit("dispatch_timeout"); // Fuerza la limpieza del contador visual
        }

        // 4. Notificamos a los canales el cierre absoluto del viaje en estado "cancelado"
        const payloadCancel = { pasajeroEmail: pEmail, taxistaEmail: tEmail, estado: "cancelado" };
        io.to(pEmail).emit("trip_finished", payloadCancel);
        io.to(pEmail).emit("dispatch_timeout"); // Saca al pasajero de la pantalla de carga

        // 5. Actualizamos el panel de control del administrador
        io.emit("panel_update", { email: pEmail, estado: "cancelado" });
        if (tEmail) io.emit("panel_update", { email: tEmail, estado: "activo" });

        console.log(`❌ Cancelación definitiva: El pasajero ${pEmail} abortó la solicitud.`);
    });

    socket.on("end_trip", async ({ pasajeroEmail, taxistaEmail }) => {
        const pEmail = pasajeroEmail?.toLowerCase().trim();
        const tEmail = taxistaEmail?.toLowerCase().trim();
        if (!pEmail || !tEmail) return;

        try {
            const pPos = await Position.findOne({ email: pEmail });
            const tPos = await Position.findOne({ email: tEmail });

            const direccionDestino = tPos ? await reverseGeocode(tPos.lat, tPos.lng) : "Destino no detectado";
            const direccionOrigen = pPos?.pickupAddress || "Origen desconocido";

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

            await Position.updateOne({ email: tEmail }, { $set: { estado: "activo", pasajeroAsignado: null } });
            await Position.updateOne({ email: pEmail }, { $set: { estado: "finalizado", taxistaAsignado: null, pickupAddress: null } });

            const pUpdated = await Position.findOne({ email: pEmail });
            const tUpdated = await Position.findOne({ email: tEmail });

            const payloadFin = { pasajeroEmail: pEmail, taxistaEmail: tEmail, estado: "finalizado", pickupAddress: direccionOrigen, destinationAddress: direccionDestino };
            io.to(pEmail).emit("trip_finished", payloadFin);
            io.to(tEmail).emit("trip_finished", payloadFin);

            if (pUpdated) io.emit("panel_update", buildPayload(pUpdated, pUpdated, "finalizado"));
            if (tUpdated) io.emit("panel_update", buildPayload(tUpdated, tUpdated, "activo"));
        } catch (error) {
            console.error(error);
        }
    });
};