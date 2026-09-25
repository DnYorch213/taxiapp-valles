import { Server, Socket } from "socket.io";
import { Position } from "../../models/Position";
import { buildPayload } from "../../utils/payloadBuilder";
import { logMotor } from "../../utils/logger";
import { POSITION_STATES } from "../../constants/states";
import { emitToTripRoom } from "../../services/tripRoomService";

export const registerLocationHandlers = (io: Server, socket: Socket, email: string) => {

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
        if (data.pasajeroEmail) {
            io.to(data.pasajeroEmail.toLowerCase().trim()).emit("update_trip_path", { lat: data.lat, lng: data.lng });
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

            const pasajeroRelacionado = await Position.findOne({
                taxistaAsignado: email, // <--- Usar email confiable
                estado: { $in: [POSITION_STATES.ASIGNADO, POSITION_STATES.ENCURSO, POSITION_STATES.ENCAMINO] }
            });

            if (pasajeroRelacionado) {
                io.to(pasajeroRelacionado.email).emit("taxi_moved", {
                    lat: tPos.lat,
                    lng: tPos.lng,
                    tEmail: email, // <--- Usar email confiable
                    taxiNumber: tPos.taxiNumber || "S/N",
                    estado: pasajeroRelacionado.estado
                });
            }
        } catch (error) {
            logMotor("taxi_moved", `Error en taxi_moved para ${email}: ${error}`, "ERROR");
        }
    });
};
