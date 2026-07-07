// src/controllers/pushController.ts
import { Request, Response } from "express";
import { Server } from "socket.io";
import { Position } from "../models/Position";
import { User } from "../models/User";
import { buildPayload } from "../utils/payloadBuilder";
import { clearDispatchCycle, dispatchWithRetry } from "../services/dispatchService";
import { POSITION_STATES } from "../constants/states";
import { enviarNotificacionPush } from "../services/pushService";

// 🚖 1. CONTROLADOR PARA ACEPTAR EL VIAJE VIA PUSH
export const handleAcceptTripPush = (io: Server) => async (req: Request, res: Response) => {
    const { taxistaEmail, pasajeroEmail, requestId } = req.body;

    if (!taxistaEmail || !pasajeroEmail || !requestId) {
        return res.status(400).json({ error: "Faltan taxistaEmail, pasajeroEmail o requestId" });
    }

    try {
        const tEmail = taxistaEmail.toLowerCase().trim();
        const pEmail = pasajeroEmail.toLowerCase().trim();

        // Matar el timeout del motor inmediatamente por requestId real
        clearDispatchCycle(requestId, "aceptación push legítima");

        // Transacción de seguridad en la base de datos
        const pPosActualizado = await Position.findOneAndUpdate(
            {
                email: pEmail,
                requestId: requestId,
                $or: [
                    {
                        estado: { $in: [POSITION_STATES.BUSCANDO, POSITION_STATES.ACTIVO] },
                        $or: [{ taxistaAsignado: null }, { taxistaAsignado: tEmail }]
                    },
                    {
                        estado: POSITION_STATES.PREASIGNADO,
                        taxistaAsignado: tEmail
                    }
                ]
            },
            {
                $set: {
                    estado: POSITION_STATES.ENCAMINO,
                    taxistaAsignado: tEmail,
                    updatedAt: new Date()
                }
            },
            { returnDocument: "after" }
        );

        if (!pPosActualizado) {
            console.log(`🚫 PUSH LATE: El taxista ${tEmail} intentó aceptar pero el viaje ya fue tomado o cancelado.`);
            return res.status(410).json({ error: "El viaje ya no está disponible o expiró." });
        }

        // Actualizar estado del conductor
        await Position.updateOne(
            { email: tEmail },
            {
                $set: {
                    estado: POSITION_STATES.ENCAMINO,
                    pasajeroAsignado: pEmail,
                    updatedAt: new Date()
                }
            }
        );

        const tPos = await Position.findOne({ email: tEmail });
        const pasajeroPayload = buildPayload(pPosActualizado, pPosActualizado, POSITION_STATES.ENCAMINO);

        // Notificaciones de sincronización de Sockets
        io.to(pEmail).emit("response_from_taxi", {
            accepted: true,
            tEmail,
            name: tPos?.name || "Conductor",
            taxiNumber: tPos?.taxiNumber || "S/N",
            estado: POSITION_STATES.ENCAMINO,
            lat: tPos?.lat,
            lng: tPos?.lng,
            taxiData: buildPayload(tPos, tPos, POSITION_STATES.ENCAMINO)
        });

        if (pPosActualizado.pushSubscription) {
            try {
                await enviarNotificacionPush(pPosActualizado.pushSubscription, {
                    type: "TRIP_ACCEPTED",
                    requestId,
                    taxistaEmail: tEmail,
                    name: tPos?.name || "Conductor",
                    taxiNumber: tPos?.taxiNumber || "S/N"
                }, pEmail);
            } catch (pushErr) {
                console.error("No se pudo reforzar la aceptación vía Push al pasajero");
            }
        }

        io.to(tEmail).emit("assignment_confirmed", { success: true, pasajero: pasajeroPayload });
        io.to(tEmail).emit("trip_status_update", { estado: POSITION_STATES.ENCAMINO, pasajeroAsignado: pasajeroPayload });
        io.to(pEmail).emit("trip_status_update", { estado: POSITION_STATES.ENCAMINO, pasajeroEmail: pEmail });

        io.emit("panel_update", buildPayload(tPos, tPos, POSITION_STATES.ENCAMINO, { pasajeroAsignado: pEmail }));
        io.emit("panel_update", buildPayload(pPosActualizado, pPosActualizado, POSITION_STATES.ENCAMINO, { taxistaAsignado: tEmail }));

        console.log(`✅ [Push Engine] Viaje vinculado de forma robusta vía HTTP: ${tEmail} -> ${pEmail}`);
        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("❌ Error en handleAcceptTripPush:", error);
        return res.status(500).json({ error: "Error interno del servidor." });
    }
};

// 🔔 2. 🎯 CONTROLADOR PARA GUARDAR SUSCRIPCIÓN PUSH
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

// 🚖 3. CONTROLADOR PARA IGNORAR VIAJE VIA PUSH
export const handleRejectTripPush = (io: Server) => async (req: Request, res: Response) => {
    const { taxistaEmail, pasajeroEmail, requestId } = req.body;

    if (!taxistaEmail || !pasajeroEmail || !requestId) {
        return res.status(400).json({ error: "Faltan taxistaEmail, pasajeroEmail o requestId" });
    }

    try {
        const tEmail = String(taxistaEmail).toLowerCase().trim();
        const pEmail = String(pasajeroEmail).toLowerCase().trim();

        // Limpieza por ID de ciclo directo
        clearDispatchCycle(requestId, "rechazo push manual");

        await Position.updateOne(
            { email: tEmail },
            { $set: { estado: POSITION_STATES.ACTIVO, pasajeroAsignado: null, updatedAt: new Date() } }
        );

        await Position.updateOne(
            {
                email: pEmail,
                requestId: requestId,
                estado: { $in: [POSITION_STATES.BUSCANDO, POSITION_STATES.PREASIGNADO, POSITION_STATES.ASIGNADO] }
            },
            {
                $set: {
                    estado: POSITION_STATES.BUSCANDO,
                    taxistaAsignado: null,
                    updatedAt: new Date()
                }
            }
        );

        io.to(pEmail).emit("taxi_rejected_request");

        const pData = await Position.findOne({ email: pEmail }).lean();
        if (pData && [POSITION_STATES.BUSCANDO, POSITION_STATES.PREASIGNADO].includes(pData.estado as any)) {
            dispatchWithRetry(io, pData, [tEmail], 1);
        }

        return res.status(200).json({ success: true });
    } catch (error) {
        console.error("❌ Error en handleRejectTripPush:", error);
        return res.status(500).json({ error: "Error interno del servidor." });
    }
};