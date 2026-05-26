// src/controllers/pushController.ts
import { Request, Response } from "express";
import { Server } from "socket.io";
import { Position } from "../models/Position";
import { User } from "../models/User";
import { buildPayload } from "../utils/payloadBuilder";
import { pendingTimeouts } from "../services/dispatchService";

// 🚖 1. CONTROLADOR PARA ACEPTAR EL VIAJE VIA PUSH
export const handleAcceptTripPush = (io: Server) => async (req: Request, res: Response) => {
    const { taxistaEmail, pasajeroEmail } = req.body;

    try {
        const tEmail = taxistaEmail.toLowerCase().trim();
        const pEmail = pasajeroEmail.toLowerCase().trim();

        if (pendingTimeouts.has(tEmail)) {
            clearTimeout(pendingTimeouts.get(tEmail)!);
            pendingTimeouts.delete(tEmail);
        }

        const pPosActualizado = await Position.findOneAndUpdate(
            { email: pEmail, estado: { $in: ["buscando", "preasignado", "activo"] } },
            { $set: { estado: "encamino", taxistaAsignado: tEmail } },
            { returnDocument: "after" }
        );

        if (!pPosActualizado) {
            console.log(`🚫 PUSH LATE: El taxista ${tEmail} intentó aceptar pero el viaje ya fue tomado.`);
            return res.status(410).json({ error: "El viaje ya no está disponible." });
        }

        await Position.updateOne({ email: tEmail }, { $set: { estado: "encamino", pasajeroAsignado: pEmail } });
        const tPos = await Position.findOne({ email: tEmail });

        const pasajeroPayload = buildPayload(pPosActualizado, pPosActualizado, "encamino");

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

        io.to(tEmail).emit("assignment_confirmed", {
            success: true,
            pasajero: pasajeroPayload
        });

        io.to(tEmail).emit("trip_status_update", {
            estado: "encamino",
            pasajeroAsignado: pasajeroPayload
        });

        io.to(pEmail).emit("trip_status_update", { estado: "encamino" });

        io.emit("panel_update", buildPayload(tPos, tPos, "encamino", { pasajeroAsignado: pEmail }));
        io.emit("panel_update", buildPayload(pPosActualizado, pPosActualizado, "encamino", { taxistaAsignado: tEmail }));

        console.log(`✅ [Push Engine] Viaje vinculado de forma robusta: ${tEmail} -> ${pEmail}`);
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("❌ Error en handleAcceptTripPush:", error);
        return res.status(500).json({ error: "Error interno del servidor." });
    }
};

// 🔔 2. 🎯 EL MIGRANTE EXTRAVIADO: CONTROLADOR PARA GUARDAR SUSCRIPCIÓN PUSH
export const handleSaveSubscription = async (req: Request, res: Response) => {
    const { email, subscription } = req.body;

    if (!email || !subscription) {
        return res.status(400).json({ message: "Faltan datos obligatorios para registrar el Push" });
    }

    try {
        const cleanEmail = email.toLowerCase().trim();

        // Guardamos las llaves de suscripción en los perfiles de MongoDB
        await User.findOneAndUpdate({ email: cleanEmail }, { $set: { pushSubscription: subscription } });
        await Position.findOneAndUpdate({ email: cleanEmail }, { $set: { pushSubscription: subscription } }, { upsert: true });

        console.log(`✅ [Push Sync] Token Web-Push sincronizado en Atlas para: ${cleanEmail}`);
        return res.status(200).json({ message: "Suscripción guardada con éxito" });
    } catch (err) {
        console.error("❌ Error en handleSaveSubscription:", err);
        return res.status(500).json({ message: "Error interno del servidor al guardar token" });
    }
};