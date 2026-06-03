// src/socket/handlers/tripHandler.ts
import { Server, Socket } from "socket.io";
import { Position } from "../../models/Position";
import { Trip } from "../../models/Trip";
import { buildPayload } from "../../utils/payloadBuilder";
import { reverseGeocode } from "../../services/geocodingService";
import { dispatchWithRetry, pendingTimeouts } from "../../services/dispatchService";
import { logMotor } from "../../utils/logger";

export const registerTripHandlers = (io: Server, socket: Socket, email: string) => {

    socket.on("request_taxi", async (data: any) => {
        const pEmail = data.email?.toLowerCase().trim();
        if (!pEmail) return;

        try {
            // 🎯 ESCUDO ABSOLUTO EN MONGO: Buscamos si el pasajero ya está en viaje, en camino,
            // o si de forma cruzada ya tiene un taxista asignado en la colección.
            const viajeExistente = await Position.findOne({
                $or: [
                    { email: pEmail, estado: { $in: ["encamino", "encurso", "asignado", "preasignado"] } },
                    { email: pEmail, role: "pasajero", taxistaAsignado: { $ne: null } }
                ]
            }).lean();

            // 🔥 Si el escudo detecta que ya tiene un viaje amarrado, ABORTAMOS la petición espuria en el acto
            if (viajeExistente) {
                logMotor("request_taxi", `Pasajero=${pEmail} Estado=${viajeExistente.estado} Taxista=${viajeExistente.taxistaAsignado || "N/A"} -> Solicitud ignorada`, "WARN");

                const taxistaData = viajeExistente.taxistaAsignado
                    ? await Position.findOne({ email: viajeExistente.taxistaAsignado }).lean()
                    : null;

                return socket.emit("response_from_taxi", {
                    accepted: true,
                    tEmail: viajeExistente.taxistaAsignado || "",
                    name: taxistaData ? taxistaData.name : "Conductor",
                    taxiNumber: taxistaData ? taxistaData.taxiNumber : "ECO",
                    lat: taxistaData ? taxistaData.lat : null,
                    lng: taxistaData ? taxistaData.lng : null,
                    estado: viajeExistente.estado
                });
            }


            // 🟢 SI ESTÁ COMPLETA Y LEGÍTIMAMENTE LIBRE, CONTINÚA TU FLUJO NORMAL:
            const currentRequestId = new Date().getTime().toString();
            logMotor("request_taxi", `Solicitud legítima de: ${pEmail} (ID: ${currentRequestId})`, "INFO");
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

            // 🚀 3. Geocodificación silenciosa en segundo plano (ULTRA-BLINDADA)
            let pickupAddress = data.pickupAddress || null;
            if (!pickupAddress || pickupAddress.includes("Ubicación:")) {
                reverseGeocode(data.lat, data.lng).then(async (direccion) => {

                    // 🎯 CANDADO DE ESTADO CRÍTICO
                    const validacionP = await Position.findOne({ email: pEmail }).lean();

                    if (validacionP && ["encamino", "encurso", "asignado", "preasignado"].includes(validacionP.estado)) {
                        logMotor("geocoding", `Ignorando dirección tardía (${direccion}) para ${pEmail}. Estado=${validacionP.estado}`, "WARN"); return;
                    }

                    if (validacionP && validacionP.pasajeroAsignado === currentRequestId) {
                        await Position.updateOne({ email: pEmail }, { $set: { pickupAddress: direccion } });
                        logMotor("geocoding", `Dirección generada e inyectada: ${direccion} para ${pEmail}`, "INFO");
                    }

                }).catch(err => logMotor("geocoding", `Error en geocoding para ${pEmail}: ${err}`, "ERROR"));
            }

            const pasajeroPayload = {
                email: pEmail,
                name: data.name || "Pasajero",
                lat: data.lat,
                lng: data.lng,
                pickupAddress: pickupAddress || "Calculando ubicación...",
                requestId: currentRequestId
            };

            logMotor("request_taxi", `Buscando la unidad más cercana para ${pEmail}`, "INFO");
            // 4. Despertamos al motor asegurando que la BD ya se actualizó
            dispatchWithRetry(io, pasajeroPayload, [], 1);

        } catch (error) {
            logMotor("error", `Error en request_taxi para ${pEmail}: ${error}`, "ERROR");
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
            logMotor("taxi_response", `Pasajero=${pEmail} -> Timeout cancelado`, "INFO");
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
            logMotor("taxi_response", `Error al asignar viaje a ${pEmail}: ${error}`, "ERROR");
            io.to(tEmail).emit("assignment_confirmed", { success: false, message: "Error al asignar el viaje. Intenta nuevamente." });
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
            logMotor("passenger_on_board", `Pasajero=${pEmail} Taxista=${tEmail} -> Estado=EN_CURSO`, "INFO");
            // 🎯 1. FULMINAMOS CUALQUIER HILO O TIMEOUT RESIDUAL DEL DISPATCHER
            if (pendingTimeouts.has(pEmail)) {
                clearTimeout(pendingTimeouts.get(pEmail));
                pendingTimeouts.delete(pEmail);
                logMotor("passenger_on_board", `Pasajero=${pEmail} -> Timeout limpiado`, "INFO");
            }

            // 🚩 Limpieza crítica: invalidamos cualquier requestId viejo
            await Position.updateOne({ email: pEmail }, { $set: { requestId: null } });
            logMotor("passenger_on_board", `Pasajero=${pEmail} -> RequestId limpiado al subir a bordo`, "INFO");

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
            // 🚩 Refuerzo UI: emitimos explícitamente encurso al pasajero
            io.to(pEmail).emit("trip_status_update", { estado: "encurso" });
            io.to(tEmail).emit("trip_status_update", { estado: "encurso" });

            // 🎯 4. CORRECCIÓN CRÍTICA: Emetimos payloads completos e industriales a los paneles globales
            if (pPos) io.emit("panel_update", buildPayload(pPos, pPos, "encurso"));
            if (tPos) io.emit("panel_update", buildPayload(tPos, tPos, "encurso"));

        } catch (error) {
            logMotor("error", `Error en passenger_on_board para ${pEmail}: ${error}`, "ERROR");
        }
    });


    socket.on("passenger_cancel", async ({ pasajeroEmail, taxistaEmail }) => {
        const pEmail = pasajeroEmail.toLowerCase().trim();
        const tEmail = taxistaEmail ? taxistaEmail.toLowerCase().trim() : null;

        // 🛡️ REVISIÓN EN TIEMPO REAL: ¿El pasajero de verdad está buscando o asignado?
        const estadoActualDoc = await Position.findOne({ email: pEmail }).lean();

        // Si en la base de datos ya está pendiente, inactivo o cancelado, bloqueamos el evento
        if (!estadoActualDoc || ["pendiente", "inactivo", "cancelado"].includes(estadoActualDoc.estado)) {
            logMotor("passenger_cancel", `Pasajero=${pEmail} -> Cancelación bloqueada. Estado=${estadoActualDoc?.estado}`, "WARN"); return; // 🛑 Cerramos la puerta y no hacemos nada
        }

        logMotor("passenger_cancel", `Pasajero=${pEmail} -> Cancelación definitiva`, "WARN");
        // 1. Matamos el temporizador de la cascada de inmediato si existía
        if (tEmail && pendingTimeouts.has(tEmail)) {
            clearTimeout(pendingTimeouts.get(tEmail)!);
            pendingTimeouts.delete(tEmail);
            logMotor("passenger_cancel", `Pasajero=${pEmail} Taxista=${tEmail} -> Cascada cancelada`, "INFO");
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

        logMotor("passenger_cancel", `Pasajero=${pEmail} -> Cancelación finalizada`, "WARN");
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
            logMotor("end_trip", `Error al finalizar viaje para Pasajero=${pEmail} Taxista=${tEmail}: ${error}`, "ERROR");
        }
    });
};