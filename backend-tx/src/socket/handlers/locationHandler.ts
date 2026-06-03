// src/socket/handlers/locationHandler.ts
import { Server, Socket } from "socket.io";
import { Position } from "../../models/Position";
import { buildPayload } from "../../utils/payloadBuilder";
import { logMotor } from "../../utils/logger";

export const registerLocationHandlers = (io: Server, socket: Socket, email: string) => {
    socket.on("update_trip_path", async (data) => {
        if (data.pasajeroEmail) {
            io.to(data.pasajeroEmail.toLowerCase().trim()).emit("update_trip_path", { lat: data.lat, lng: data.lng });
        }
    });

    socket.on("position", async (data: any) => {
        if (!data.email) return;
        try {
            const currentDoc = await Position.findOne({ email: data.email });
            const finalName = (data.name && !data.name.includes('@')) ? data.name : (currentDoc?.name || data.name);

            const updated = await Position.findOneAndUpdate(
                { email: data.email },
                {
                    $set: {
                        lat: data.lat,
                        lng: data.lng,
                        name: finalName,
                        estado: currentDoc?.estado || data.estado || (data.role === "taxista" ? "activo" : "buscando"),
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
            estado: { $in: ["encurso", "encamino"] }
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