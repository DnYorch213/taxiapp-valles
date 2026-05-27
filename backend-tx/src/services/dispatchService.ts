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

export const dispatchWithRetry = async (io: Server, pasajeroData: any, excludedEmails: string[] = [], attempt: number = 1) => {
    if (!isAutoMode || !pasajeroData || !pasajeroData.email) return;

    const pEmail = pasajeroData.email.toLowerCase().trim();
    const currentExcluidos = [...new Set(excludedEmails.map(e => e.toLowerCase().trim()))];

    // 🎯 CANDADO ATÓMICO: Si el pasajero ya fue tomado por un taxista,
    // abortamos de inmediato cualquier sub-proceso o solicitud duplicada que venga en camino.
    const pStatusCheck = await Position.findOne({ email: pEmail }).lean();
    if (pStatusCheck && ["encamino", "encurso", "asignado"].includes(pStatusCheck.estado)) {
        console.log(`🛡️ [Motor] Abortando solicitud duplicada para ${pEmail}. Ya se encuentra en estado: ${pStatusCheck.estado}`);
        return; // Detiene el proceso por completo
    }

    if (attempt > MAX_RETRIES) {
        console.log(`❌ Límite alcanzado para ${pEmail}`);
        await Position.updateOne({ email: pEmail }, { $set: { estado: "cancelado" } });
        io.to(pEmail).emit("no_taxis_available", { message: "Sin unidades disponibles." });
        return;
    }

    const taxistasCandidatos = await Position.find({
        role: "taxista",
        estado: "activo",
        lat: { $exists: true, $ne: null, $gt: 0 },
        lng: { $exists: true, $nin: [null, 0] },
        email: { $nin: currentExcluidos }
    }).lean() as IPosition[];

    if (taxistasCandidatos.length === 0) {
        console.log(`📭 No hay taxistas con Push activo para ${pEmail}`);
        io.to(pEmail).emit("no_taxis_available", { message: "Buscando conductores..." });
        return;
    }

    const elMasCercano = taxistasCandidatos.reduce((prev, curr) => {
        const distPrev = calculateDistance(pasajeroData.lat, pasajeroData.lng, prev.lat, prev.lng);
        const distCurr = calculateDistance(pasajeroData.lat, pasajeroData.lng, curr.lat, curr.lng);
        return distPrev < distCurr ? prev : curr;
    });

    const tEmail = elMasCercano.email.toLowerCase().trim();

    if (!pasajeroData.pickupAddress || pasajeroData.pickupAddress.includes("Ubicación:")) {
        pasajeroData.pickupAddress = await reverseGeocode(pasajeroData.lat, pasajeroData.lng);
    }

    await Position.updateOne({ email: tEmail }, { $set: { estado: "asignado", pasajeroAsignado: pEmail } });
    await Position.updateOne({ email: pEmail }, { $set: { estado: "preasignado" } });

    const fullPayload = {
        ...pasajeroData,
        email: pEmail,
        pickupAddress: pasajeroData.pickupAddress,
        excludedEmails: currentExcluidos,
        isNewOffer: true,
        attempt
    };

    io.to(tEmail).emit("pasajero_asignado", fullPayload);

    if (elMasCercano.pushSubscription) {
        enviarNotificacionPush(elMasCercano.pushSubscription, fullPayload, tEmail);
    }

    const startTime = Date.now();
    const timeout = setTimeout(async () => {
        const tCheck = await Position.findOne({ email: tEmail }).lean();

        if (tCheck && tCheck.estado === "asignado") {
            console.log(`⏳ TIMEOUT: Taxista ${tEmail} no respondió. Saltando cascada.`);
            const pRefresh = await Position.findOne({ email: pEmail }).lean();

            if (!pRefresh || ["cancelado", "inactivo", "encamino", "encurso"].includes(pRefresh.estado)) {
                await Position.updateOne({ email: tEmail }, { $set: { estado: "activo" } });
                return;
            }

            io.to(tEmail).emit("dispatch_timeout");
            await Position.updateOne({ email: tEmail }, { $set: { estado: "activo" } });
            io.emit("panel_update", { email: tEmail, estado: "activo" });

            dispatchWithRetry(io, { ...pasajeroData, pickupAddress: pRefresh.pickupAddress }, [...currentExcluidos, tEmail], attempt + 1);
        }
    }, 22000);

    // 🎯 Guardamos el timeout referenciado al PASAJERO para poder borrarlo de un plumazo
    pendingTimeouts.set(pEmail, timeout);
};