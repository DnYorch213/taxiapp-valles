// src/socket/handlers/tripHandler.ts
import { Server, Socket } from "socket.io";
import { Position } from "../../models/Position";
import { Trip } from "../../models/Trip";
import { buildPayload } from "../../utils/payloadBuilder";
import { reverseGeocode } from "../../services/geocodingService";
import { dispatchWithRetry, pendingTimeouts } from "../../services/dispatchService";

export const registerTripHandlers = (io: Server, socket: Socket, email: string) => {
    socket.on("taxi_response", async ({ requestEmail, accepted, excludedEmails = [] }) => {
        const tEmail = email;
        const pEmail = requestEmail?.toLowerCase().trim();
        if (!tEmail || !pEmail) return;

        if (pendingTimeouts.has(tEmail)) {
            clearTimeout(pendingTimeouts.get(tEmail)!);
            pendingTimeouts.delete(tEmail);
        }

        if (!accepted) {
            await Position.updateOne({ email: tEmail }, { $set: { estado: "activo" } });
            const tPos = await Position.findOne({ email: tEmail });
            io.emit("panel_update", buildPayload(tPos, tPos, "activo"));
            io.to(pEmail).emit("taxi_rejected_request");

            const pData = await Position.findOne({ email: pEmail });
            if (pData) dispatchWithRetry(io, pData, [...excludedEmails, tEmail], 1);
            return;
        }

        try {
            const pPosActualizado = await Position.findOneAndUpdate(
                { email: pEmail, estado: { $in: ["buscando", "preasignado", "activo"] } },
                { $set: { estado: "encamino", taxistaAsignado: tEmail } },
                { returnDocument: "after" }
            );

            if (!pPosActualizado) {
                return io.to(tEmail).emit("trip_already_taken", { message: "¡Lo sentimos! Solicitud expirada o tomada por otro compañero." });
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

    socket.on("passenger_on_board", async ({ taxistaEmail, pasajeroEmail }) => {
        if (!pasajeroEmail || !taxistaEmail) return;
        const pEmail = pasajeroEmail.toLowerCase().trim();
        const tEmail = taxistaEmail.toLowerCase().trim();

        await Position.updateOne({ email: tEmail }, { $set: { estado: "encurso" } });
        await Position.updateOne({ email: pEmail }, { $set: { estado: "encurso" } });

        io.to(pEmail).emit("trip_status_update", { estado: "encurso", pasajeroEmail: pEmail });
        io.to(tEmail).emit("trip_status_update", { estado: "encurso" });
        io.emit("panel_update", { email: pEmail, estado: "encurso" });
        io.emit("panel_update", { email: tEmail, estado: "encurso" });
    });

    socket.on("passenger_cancel", async ({ pasajeroEmail, taxistaEmail }) => {
        const pEmail = pasajeroEmail.toLowerCase().trim();
        const tEmail = taxistaEmail ? taxistaEmail.toLowerCase().trim() : null;

        if (tEmail && pendingTimeouts.has(tEmail)) {
            clearTimeout(pendingTimeouts.get(tEmail)!);
            pendingTimeouts.delete(tEmail);
        }

        await Position.updateOne({ email: pEmail }, { $set: { estado: "buscando", taxistaAsignado: null } });
        if (tEmail) {
            await Position.updateOne({ email: tEmail }, { $set: { estado: "activo", pasajeroAsignado: null } });
            io.to(tEmail).emit("trip_cancelled_by_passenger", { message: "El pasajero ha cancelado la solicitud.", newStatus: "activo" });
        }

        io.emit("trip_finished", { pasajeroEmail: pEmail, taxistaEmail: tEmail, estado: "buscando" });
        io.emit("panel_update", { email: pEmail, estado: "buscando" });
        if (tEmail) io.emit("panel_update", { email: tEmail, estado: "activo" });
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