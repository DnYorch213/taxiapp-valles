// src/socket/handlers/locationHandler.ts
import { Server, Socket } from "socket.io";
import { Position } from "../../models/Position";
import { buildPayload } from "../../utils/payloadBuilder";
import { logMotor } from "../../utils/logger";
import { POSITION_STATES } from "../../constants/states";

export const registerLocationHandlers = (io: Server, socket: Socket, email: string) => {
    socket.on("update_driver_status", async (data: { estado?: string }, callback?: (response: { success: boolean; estado?: string; message?: string }) => void) => {
        try {
            const nextState = String(data?.estado || "").toLowerCase().trim();
            if (![POSITION_STATES.ACTIVO, POSITION_STATES.OCUPADO, POSITION_STATES.INACTIVO].includes(nextState as any)) {
                callback?.({ success: false, message: "Estado de taxista no válido" });
                return;
            }

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
                {
                    $set: {
                        estado: nextState,
                        updatedAt: new Date(),
                    }
                },
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
            const passengerEmail = String(data?.pasajeroEmail || data?.email || "").toLowerCase().trim();
            if (!passengerEmail) return;

            const destinationLat = data?.destinationLat;
            const destinationLng = data?.destinationLng;
            const destinationAddress = data?.destinationAddress;

            const passengerDoc = await Position.findOne({ email: passengerEmail, role: "pasajero" }).lean();
            if (!passengerDoc) return;

            const updatePayload: Record<string, any> = {
                updatedAt: new Date(),
            };

            if (destinationLat !== undefined && destinationLat !== null) updatePayload.destinationLat = Number(destinationLat);
            if (destinationLng !== undefined && destinationLng !== null) updatePayload.destinationLng = Number(destinationLng);
            if (destinationAddress !== undefined) updatePayload.destinationAddress = String(destinationAddress);

            const updatedPassenger = await Position.findOneAndUpdate(
                { email: passengerEmail, role: "pasajero" },
                { $set: updatePayload },
                { upsert: true, returnDocument: "after" }
            );

            if (!updatedPassenger) return;

            const payload = {
                pasajeroEmail: passengerEmail,
                destinationLat: updatedPassenger.destinationLat ?? null,
                destinationLng: updatedPassenger.destinationLng ?? null,
                destinationAddress: updatedPassenger.destinationAddress || "Destino no especificado",
                timestamp: new Date().toISOString(),
            };

            socket.emit("trip_destination_updated", payload);

            if (updatedPassenger.taxistaAsignado) {
                io.to(updatedPassenger.taxistaAsignado.toLowerCase().trim()).emit("trip_destination_updated", payload);
            }

            io.emit("panel_update", buildPayload(updatedPassenger, updatedPassenger, updatedPassenger.estado));
        } catch (error) {
            logMotor("trip_destination", `Error al actualizar destino para viaje activo: ${error}`, "ERROR");
        }
    });

    socket.on("position", async (data: any) => {
        if (!data.email) return;
        try {
            const currentDoc = await Position.findOne({ email: data.email });
            const finalName = (data.name && !data.name.includes('@')) ? data.name : (currentDoc?.name || data.name);
            const explicitState = typeof data.estado === "string" && data.estado.trim()
                ? data.estado.toLowerCase().trim()
                : null;
            const shouldPreserveState = Boolean(
                currentDoc?.estado &&
                ![POSITION_STATES.CANCELADO, POSITION_STATES.DESCONECTADO].includes(currentDoc.estado as any)
            );
            const resolvedEstado = explicitState && [POSITION_STATES.ACTIVO, POSITION_STATES.OCUPADO, POSITION_STATES.INACTIVO, POSITION_STATES.BUSCANDO, POSITION_STATES.PENDIENTE].includes(explicitState as any)
                ? explicitState
                : (shouldPreserveState
                    ? currentDoc!.estado
                    : (data.role === "taxista" ? POSITION_STATES.ACTIVO : POSITION_STATES.BUSCANDO));

            const updated = await Position.findOneAndUpdate(
                { email: data.email },
                {
                    $set: {
                        lat: data.lat,
                        lng: data.lng,
                        name: finalName,
                        estado: resolvedEstado,
                        updatedAt: new Date()
                    }
                },
                { upsert: true, returnDocument: "after" }
            );
            if (updated) io.emit("panel_update", buildPayload(updated, updated, updated.estado));
        } catch (error) {
            logMotor("Error en Update Position", `Error al actualizar la posición para ${data.email}: ${error}`, "ERROR");
        }
    });

    socket.on("taxi_moved", async (data) => {
        const { email } = data;
        const tPos = await Position.findOne({ email });
        if (!tPos) return;

        const pasajeroRelacionado = await Position.findOne({
            taxistaAsignado: email,
            estado: { $in: [POSITION_STATES.ASIGNADO, POSITION_STATES.ENCURSO, POSITION_STATES.ENCAMINO] }
        });

        if (pasajeroRelacionado) {
            io.to(pasajeroRelacionado.email).emit("taxi_moved", {
                lat: tPos.lat,
                lng: tPos.lng,
                tEmail: email,
                taxiNumber: tPos.taxiNumber || "S/N",
                estado: pasajeroRelacionado.estado
            });
        }
    });
};