// src/services/dispatchService.ts
import { Server } from "socket.io";
import { Position, IPosition } from "../models/Position";
import { calculateDistance } from "../utils/distance";
import { reverseGeocode } from "./geocodingService";
import { enviarNotificacionPush } from "./pushService";

// 🎯 CAMBIO CRÍTICO: Ahora guardamos los timeouts usando como clave el email del PASAJERO
export const pendingTimeouts = new Map<string, NodeJS.Timeout>();
const MAX_RETRIES = 5;
export let isAutoMode = true;

export const setAutoMode = (value: boolean) => {
    isAutoMode = value;
};

// src/services/dispatchService.ts

export const dispatchWithRetry = async (io: Server, pasajeroData: any, excludedEmails: string[] = [], attempt: number = 1) => {
    if (!isAutoMode || !pasajeroData || !pasajeroData.email) return;

    const pEmail = pasajeroData.email.toLowerCase().trim();
    const currentExcluidos = [...new Set(excludedEmails.map(e => e.toLowerCase().trim()))];
    const reqId = pasajeroData.requestId;

    // 🛡️ VALIDACIÓN DE CONTROL: Comprobamos si la solicitud sigue viva en MongoDB
    const pStatusCheck = await Position.findOne({ email: pEmail }).lean();

    // Si el estado ya cambió a otra fase, o el ID de la solicitud ya no coincide, abortamos el hilo fantasma
    if (!pStatusCheck || ["encamino", "encurso", "finalizado"].includes(pStatusCheck.estado) || pStatusCheck.taxistaAsignado !== `REQ_${reqId}`) {
        console.log(`🛑 [Motor] Cancelando intento ${attempt} para ${pEmail}. Solicitud obsoleta o cancelada.`);
        return;
    }

    if (attempt > MAX_RETRIES) {
        console.log(`❌ Límite de intentos alcanzado para ${pEmail}`);
        await Position.updateOne({ email: pEmail }, { $set: { estado: "cancelado", taxistaAsignado: null } });
        io.to(pEmail).emit("no_taxis_available", { message: "Sin unidades disponibles." });
        return;
    }

    // ... Tu lógica de buscar candidatos (taxistasCandidatos) ...
    const taxistasCandidatos = await Position.find({
        role: "taxista",
        estado: "activo",
        lat: { $exists: true, $ne: null, $gt: 0 },
        lng: { $exists: true, $nin: [null, 0] },
        email: { $nin: currentExcluidos }
    }).lean() as IPosition[];

    if (taxistasCandidatos.length === 0) {
        console.log(`📭 No hay más taxistas disponibles en este intento para ${pEmail}`);
        // Modificación para que el pasajero se entere pero no se rompa el estado
        io.to(pEmail).emit("no_taxis_available", { message: "Buscando más conductores a la redonda..." });

        // Opcional: Si quieres que limpie en lugar de quedarse buscando, descomenta abajo:
        // await Position.updateOne({ email: pEmail }, { $set: { estado: "cancelado", taxistaAsignado: null } });
        return;
    }

    const elMasCercano = taxistasCandidatos.reduce((prev, curr) => {
        const distPrev = calculateDistance(pasajeroData.lat, pasajeroData.lng, prev.lat, prev.lng);
        const distCurr = calculateDistance(pasajeroData.lat, pasajeroData.lng, curr.lat, curr.lng);
        return distPrev < distCurr ? prev : curr;
    });

    const tEmail = elMasCercano.email.toLowerCase().trim();

    // Actualizamos al taxista a asignado y al pasajero a preasignado
    await Position.updateOne({ email: tEmail }, { $set: { estado: "assigned" === "assigned" ? "asignado" : "asignado", pasajeroAsignado: pEmail } });
    await Position.updateOne({ email: pEmail }, { $set: { estado: "preasignado" } });

    const fullPayload = {
        ...pasajeroData,
        email: pEmail,
        excludedEmails: currentExcluidos,
        isNewOffer: true,
        attempt
    };

    io.to(tEmail).emit("pasajero_asignado", fullPayload);

    if (elMasCercano.pushSubscription) {
        enviarNotificacionPush(elMasCercano.pushSubscription, fullPayload, tEmail);
    }

    const timeout = setTimeout(async () => {
        const tCheck = await Position.findOne({ email: tEmail }).lean();
        const pRefresh = await Position.findOne({ email: pEmail }).lean();

        // 🛡️ Verificamos que el pasajero siga en la misma solicitud exacta antes de saltar al siguiente
        if (tCheck && tCheck.estado === "asignado" && pRefresh && pRefresh.taxistaAsignado === `REQ_${reqId}`) {
            console.log(`⏳ TIMEOUT: Taxista ${tEmail} no respondió. Saltando cascada.`);

            io.to(tEmail).emit("dispatch_timeout");
            await Position.updateOne({ email: tEmail }, { $set: { estado: "activo", pasajeroAsignado: null } });
            io.emit("panel_update", { email: tEmail, estado: "activo" });

            // Llamamos al siguiente intento heredando el ID de control
            dispatchWithRetry(io, pasajeroData, [...currentExcluidos, tEmail], attempt + 1);
        }
    }, 22000);

    pendingTimeouts.set(pEmail, timeout);
};