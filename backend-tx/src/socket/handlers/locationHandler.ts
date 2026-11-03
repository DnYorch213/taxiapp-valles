import { Server, Socket } from "socket.io";
import { Position } from "../../models/Position";
import { buildPayload } from "../../utils/payloadBuilder";
import { logMotor } from "../../utils/logger";
import { POSITION_STATES } from "../../constants/states";
import { emitToTripRoom } from "../../services/tripRoomService";

export const registerLocationHandlers = (io: Server, socket: Socket, email: string) => {

    // 🔎 Antispam de diagnóstico: como mucho un log cada 5 s por socket.
    // El canal de coordenadas del viaje era invisible en los logs y por eso no
    // se podía saber si el marcador congelado era por datos o por render.
    let lastTripPathLogAt = 0;
    let lastTaxiMovedLogAt = 0;

    /**
     * 💾 Persistencia acotada de la telemetría del viaje.
     * El único camino que escribía la posición del taxista en BD durante un
     * viaje era el respaldo HTTP del cliente (`/positions/update-gps`), que
     * puede fallar en silencio y deja el documento congelado (afectando a
     * despacho, rehidratación y al respaldo `taxi_moved`). Ahora el propio
     * relay guarda la coordenada real como mucho cada 5 s.
     */
    let lastPositionPersistAt = 0;

    const persistirPosicionTaxista = (lat: number, lng: number) => {
        const ahora = Date.now();

        if (ahora - lastPositionPersistAt < 5000) return;

        lastPositionPersistAt = ahora;

        void Position.updateOne(
            { email },
            {
                $set: {
                    lat,
                    lng,
                    location: { type: "Point", coordinates: [lng, lat] },
                    updatedAt: new Date()
                }
            }
        ).catch((error) => {
            logMotor("position_persist", `No se pudo guardar la posición de ${email}: ${error}`, "WARN");
        });
    };

    socket.on("update_driver_status", async (data: { estado?: string }, callback?: (response: { success: boolean; estado?: string; message?: string }) => void) => {
        try {
            const nextState = String(data?.estado || "").toLowerCase().trim();
            if (![POSITION_STATES.ACTIVO, POSITION_STATES.OCUPADO, POSITION_STATES.INACTIVO].includes(nextState as any)) {
                callback?.({ success: false, message: "Estado de taxista no válido" });
                return;
            }

            // ✅ Usa el 'email' del cierre léxico (autenticado), no del payload
            const currentDoc = await Position.findOne({ email, role: "taxista" });
            if (!currentDoc) {
                callback?.({ success: false, message: "Taxista no encontrado" });
                return;
            }

            if ([POSITION_STATES.PREASIGNADO, POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO].includes(currentDoc.estado as any)) {
                callback?.({ success: false, message: "No puedes cambiar tu estado durante un viaje activo" });
                return;
            }

            const updatedDoc = await Position.findOneAndUpdate(
                { email, role: "taxista" },
                { $set: { estado: nextState, updatedAt: new Date() } },
                { returnDocument: "after" }
            );

            if (!updatedDoc) {
                callback?.({ success: false, message: "No se pudo actualizar el estado" });
                return;
            }

            socket.emit("trip_status_update", { estado: updatedDoc.estado, manualStatus: true });
            io.emit("panel_update", buildPayload(updatedDoc, updatedDoc, updatedDoc.estado));
            callback?.({ success: true, estado: updatedDoc.estado });
        } catch (error) {
            logMotor("driver_status", `Error al actualizar estado manual de ${email}: ${error}`, "ERROR");
            callback?.({ success: false, message: "No se pudo actualizar el estado" });
        }
    });

    socket.on("update_trip_path", async (data) => {
        try {
            const pasajeroEmail = String(data?.pasajeroEmail || "").toLowerCase().trim();
            const lat = Number(data?.lat);
            const lng = Number(data?.lng);

            if (!pasajeroEmail) return;
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

            // 🛡️ Coordenadas válidas (evita envenenar el mapa del pasajero).
            if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return;

            // 🛡️ AUTORIZACIÓN: el emisor debe ser el taxista asignado a ese
            // pasajero (`email` es el del socket autenticado, no el del payload).
            const pasajero = await Position.findOne({ email: pasajeroEmail }).lean();

            const taxistaAsignado = String(pasajero?.taxistaAsignado || "")
                .toLowerCase()
                .trim();

            if (!pasajero || !taxistaAsignado || taxistaAsignado !== email) {
                logMotor(
                    "socket_security",
                    `Intento no autorizado de update_trip_path: ${email} → ${pasajeroEmail}`,
                    "WARN"
                );
                return;
            }

            // 🛡️ Sólo se transmite durante un viaje activo.
            if (
                ![
                    POSITION_STATES.ASIGNADO,
                    POSITION_STATES.ENCAMINO,
                    POSITION_STATES.ENCURSO
                ].includes(pasajero.estado as any)
            ) {
                const ahoraIgnorado = Date.now();

                if (ahoraIgnorado - lastTripPathLogAt > 5000) {
                    lastTripPathLogAt = ahoraIgnorado;

                    logMotor(
                        "trip_path",
                        `Ignorado ${email} → ${pasajeroEmail}: el pasajero está en estado '${pasajero.estado}' (se esperaba asignado/encamino/encurso)`,
                        "WARN"
                    );
                }

                return;
            }

            // 📡 Relay directo (sin pasar por la BD) de la coordenada real.
            io.to(pasajeroEmail).emit("update_trip_path", { lat, lng });

            // 💾 Mantener la BD al día con la misma coordenada real.
            persistirPosicionTaxista(lat, lng);

            const ahoraPath = Date.now();

            if (ahoraPath - lastTripPathLogAt > 5000) {
                lastTripPathLogAt = ahoraPath;

                logMotor(
                    "trip_path",
                    `Relay ${email} → ${pasajeroEmail} (directo) lat=${lat} lng=${lng} estadoPasajero=${pasajero.estado}`,
                    "INFO"
                );
            }
        } catch (error) {
            logMotor(
                "location_update",
                `Error en update_trip_path de ${email} para ${data?.pasajeroEmail || "?"}: ${error}`,
                "ERROR"
            );
        }
    });

    socket.on("update_trip_destination", async (data: any) => {
        try {
            const callerRole = String(socket.handshake.auth?.role || socket.handshake.query?.role || "").toLowerCase().trim();
            const passengerEmail = String(data?.pasajeroEmail || data?.email || "").toLowerCase().trim();
            if (!passengerEmail) return;

            const destinationLat = data?.destinationLat;
            const destinationLng = data?.destinationLng;
            const destinationAddress = data?.destinationAddress;
            console.log("📥 BACKEND RECIBIÓ update_trip_destination:", {
                passengerEmail,
                destinationLat,
                destinationLng,
                destinationAddress,
                estimatedDistanceKm: data?.estimatedDistanceKm,
                estimatedFare: data?.estimatedFare,
            });

            const passengerDoc = await Position.findOne({ email: passengerEmail, role: "pasajero" }).lean();
            if (!passengerDoc) return;

            const isAdmin = callerRole === 'admin';
            const isPassengerOwner = email === passengerEmail; // ✅ Compara con el email autenticado
            const isAssignedTaxi = passengerDoc.taxistaAsignado === email;

            if (!isAdmin && !isPassengerOwner && !isAssignedTaxi) {
                logMotor("socket_security", `Intento no autorizado de actualizar destino para ${passengerEmail} por ${email}`, "WARN");
                return;
            }

            const updatePayload: Record<string, any> = {
                updatedAt: new Date()
            };

            if (destinationLat !== undefined && destinationLat !== null) {
                updatePayload.destinationLat = Number(destinationLat);
            }

            if (destinationLng !== undefined && destinationLng !== null) {
                updatePayload.destinationLng = Number(destinationLng);
            }

            if (destinationAddress !== undefined) {
                const nextAddress = String(destinationAddress).trim();
                updatePayload.destinationAddress =
                    nextAddress.length > 0 ? nextAddress : null;
            }

            // 🗺️ Los nuevos valores vienen calculados por Mapbox en el frontend.
            if (
                typeof data?.estimatedDistanceKm === "number" &&
                Number.isFinite(data.estimatedDistanceKm)
            ) {
                updatePayload.estimatedDistanceKm = data.estimatedDistanceKm;
            }

            if (
                typeof data?.estimatedFare === "number" &&
                Number.isFinite(data.estimatedFare)
            ) {
                updatePayload.estimatedFare = data.estimatedFare;
            }

            const updatedPassenger = await Position.findOneAndUpdate(
                { email: passengerEmail, role: "pasajero" },
                { $set: updatePayload },
                { upsert: true, returnDocument: "after" }
            );
            console.log("📦 BACKEND DESPUÉS DE GUARDAR:", {
                email: updatedPassenger?.email,
                destinationLat: updatedPassenger?.destinationLat,
                destinationLng: updatedPassenger?.destinationLng,
                destinationAddress: updatedPassenger?.destinationAddress,
                estimatedDistanceKm: updatedPassenger?.estimatedDistanceKm,
                estimatedFare: updatedPassenger?.estimatedFare,
            });

            if (!updatedPassenger) return;

            // 🗺️ No recalcular distancia/tarifa con Haversine.
            // Usamos los valores de Mapbox guardados en Position.
            const estimatedFare = updatedPassenger.estimatedFare ?? null;
            const estimatedDistanceKm = updatedPassenger.estimatedDistanceKm ?? null;

            const payload = {
                pasajeroEmail: passengerEmail,
                destinationLat: updatedPassenger.destinationLat ?? null,
                destinationLng: updatedPassenger.destinationLng ?? null,
                destinationAddress:
                    updatedPassenger.destinationAddress || "Destino no especificado",
                estimatedFare,
                estimatedDistanceKm,
                timestamp: new Date().toISOString(),
            };

            socket.emit("trip_destination_updated", payload);

            // 📡 Mantener envío por room del taxista
            if (updatedPassenger.taxistaAsignado) {
                io
                    .to(updatedPassenger.taxistaAsignado.toLowerCase().trim())
                    .emit("trip_destination_updated", payload);
            }

            // 📡 Enviar también por la sala específica del viaje
            if (updatedPassenger.requestId) {
                emitToTripRoom(
                    io,
                    String(updatedPassenger.requestId),
                    "trip_destination_updated",
                    payload
                );
            }

            io.emit(
                "panel_update",
                buildPayload(
                    updatedPassenger,
                    updatedPassenger,
                    updatedPassenger.estado
                )
            );
        } catch (error) {
            logMotor("trip_destination", `Error al actualizar destino para viaje activo: ${error}`, "ERROR");
        }
    });

    // ============================================================
    // 🎯 CORRECCIÓN DEFINITIVA: Evento "position" blindado por ROL
    // ============================================================
    socket.on("position", async (data: any) => {
        try {
            const { lat, lng, name, estado } = data;

            if (typeof lat !== "number" || typeof lng !== "number") {
                return;
            }

            const realRole = socket.data.role || "taxista";

            // Buscar por EMAIL porque email es único en Position
            const currentDoc = await Position.findOne({ email });

            const finalName =
                (name && !name.includes('@'))
                    ? name
                    : (currentDoc?.name || name || "Usuario");

            const explicitState =
                typeof estado === "string" && estado.trim()
                    ? estado.toLowerCase().trim()
                    : null;

            const shouldPreserveState = Boolean(
                currentDoc?.estado &&
                ![
                    POSITION_STATES.CANCELADO,
                    POSITION_STATES.DESCONECTADO
                ].includes(currentDoc.estado as any)
            );

            const defaultStateByRole =
                realRole === "taxista"
                    ? POSITION_STATES.ACTIVO
                    : POSITION_STATES.BUSCANDO;

            const resolvedEstado =
                explicitState &&
                    [
                        POSITION_STATES.ACTIVO,
                        POSITION_STATES.OCUPADO,
                        POSITION_STATES.INACTIVO,
                        POSITION_STATES.BUSCANDO,
                        POSITION_STATES.PENDIENTE
                    ].includes(explicitState as any)
                    ? explicitState
                    : (
                        shouldPreserveState
                            ? currentDoc!.estado
                            : defaultStateByRole
                    );

            const updated = await Position.findOneAndUpdate(
                { email }, // ✅ buscar SOLO por email
                {
                    $set: {
                        email,
                        role: realRole, // ✅ corrige/agrega el rol
                        lat,
                        lng,
                        name: finalName,
                        estado: resolvedEstado,
                        location: {
                            type: "Point",
                            coordinates: [lng, lat]
                        },
                        updatedAt: new Date()
                    }
                },
                {
                    upsert: true,
                    returnDocument: "after"
                }
            );

            if (updated) {
                io.emit(
                    "panel_update",
                    buildPayload(updated, updated, updated.estado)
                );
            }

        } catch (error) {
            logMotor(
                "position_update",
                `Error al actualizar la posición para ${email}: ${error}`,
                "ERROR"
            );
        }
    });

    // ============================================================
    // 🎯 CORRECCIÓN SECUNDARIA: Evento "taxi_moved" blindado
    // ============================================================
    socket.on("taxi_moved", async (data) => {
        try {
            // Ignorar data.email, usar el email autenticado del socket
            const tPos = await Position.findOne({ email });
            if (!tPos) return;

            /**
             * 🎯 COORDENADA A RETRANSMITIR.
             * Se prefiere la que envía el propio taxista en el payload (tiempo
             * real). Antes se usaba SIEMPRE la guardada en la BD, que sólo se
             * actualiza por el respaldo HTTP (`/positions/update-gps`) y por
             * tanto puede ir con retraso o quedarse congelada; eso era lo que
             * dejaba el marcador del taxi inmóvil en el mapa del pasajero.
             * La identidad ya está validada por el socket autenticado y por la
             * relación taxista→pasajero, no por el payload.
             */
            const latPayload = Number(data?.lat);
            const lngPayload = Number(data?.lng);

            const payloadValido =
                Number.isFinite(latPayload) &&
                Number.isFinite(lngPayload) &&
                latPayload >= -90 &&
                latPayload <= 90 &&
                lngPayload >= -180 &&
                lngPayload <= 180;

            const lat = payloadValido ? latPayload : Number(tPos.lat);
            const lng = payloadValido ? lngPayload : Number(tPos.lng);
            const origen = payloadValido ? "payload" : "BD";

            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

            // 💾 La BD se queda con la coordenada real, no con la vieja.
            if (payloadValido) {
                persistirPosicionTaxista(lat, lng);
            }

            const pasajeroRelacionado = await Position.findOne({
                taxistaAsignado: email, // <--- Usar email confiable
                estado: { $in: [POSITION_STATES.ASIGNADO, POSITION_STATES.ENCURSO, POSITION_STATES.ENCAMINO] }
            });

            // 🔎 Diagnóstico: `edadBD` delata si la posición guardada está
            // congelada (respaldo HTTP de GPS caído o con retraso).
            const ahoraMoved = Date.now();
            const puedeLoguearMoved = ahoraMoved - lastTaxiMovedLogAt > 5000;

            if (pasajeroRelacionado) {
                io.to(pasajeroRelacionado.email).emit("taxi_moved", {
                    lat,
                    lng,
                    tEmail: email, // <--- Usar email confiable
                    taxiNumber: tPos.taxiNumber || "S/N",
                    estado: pasajeroRelacionado.estado
                });

                if (puedeLoguearMoved) {
                    lastTaxiMovedLogAt = ahoraMoved;

                    const edadSegundos = tPos.updatedAt
                        ? Math.max(0, Math.round((ahoraMoved - new Date(tPos.updatedAt).getTime()) / 1000))
                        : -1;

                    logMotor(
                        "taxi_moved",
                        `Relay ${email} → ${pasajeroRelacionado.email} (${origen}) lat=${lat} lng=${lng} edadBD=${edadSegundos}s estadoPasajero=${pasajeroRelacionado.estado}`,
                        "INFO"
                    );
                }
            } else if (puedeLoguearMoved) {
                lastTaxiMovedLogAt = ahoraMoved;

                logMotor(
                    "taxi_moved",
                    `Sin pasajero con viaje activo para ${email}: no se retransmite`,
                    "WARN"
                );
            }
        } catch (error) {
            logMotor("taxi_moved", `Error en taxi_moved para ${email}: ${error}`, "ERROR");
        }
    });
};
