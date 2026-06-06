// src/services/dispatchService.ts
import { Server } from "socket.io";
import { Position, IPosition } from "../models/Position";
import { calculateDistance } from "../utils/distance";
import { reverseGeocode } from "./geocodingService";
import { enviarNotificacionPush } from "./pushService";
import { logMotor } from "../utils/logger";

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
    const reqId = pasajeroData.requestId;

    // Guardar requestId al inicio
    await Position.updateOne(
        { email: pEmail },
        { $set: { requestId: reqId } }
    );

    // 🛡️ REVISIÓN DEL CANDADO:
    const pStatusCheck = await Position.findOne({ email: pEmail }).lean();

    // Si el viaje ya se consolidó con un taxista (cambió de estado), dejamos que siga.
    // Pero si sigue en "buscando" o "preasignado" y el requestId cambió, abortamos el hilo viejo.
    if (!pStatusCheck) return;

    if (["encamino", "encurso", "finalizado"].includes(pStatusCheck.estado)) {
        logMotor("dispatch_retry", `Pasajero=${pEmail} Estado=${pStatusCheck.estado} Intento=${attempt} -> Viaje ya en curso`, "WARN");
        // 🚩 Aquí sí existe pEmail y puedes limpiar
        const oldTimeout = pendingTimeouts.get(pEmail);
        if (oldTimeout) {
            clearTimeout(oldTimeout);
            pendingTimeouts.delete(pEmail);
            logMotor("dispatch_retry", `Pasajero=${pEmail} -> Timeout limpiado, viaje ya en curso.`, "INFO");
        }
        return;
    }


    if (pStatusCheck.estado === "buscando" && pStatusCheck.requestId && pStatusCheck.requestId !== reqId) {
        logMotor("dispatch_retry", `Pasajero=${pEmail} Intento=${attempt} -> RequestId obsoleto`, "WARN"); return;
    }



    if (attempt > MAX_RETRIES) {
        logMotor("dispatch_retry", `Pasajero=${pEmail} Intento=${attempt} -> Límite de intentos alcanzado`, "ERROR");
        await Position.updateOne({ email: pEmail }, { $set: { estado: "cancelado", pasajeroAsignado: null } });
        io.to(pEmail).emit("no_taxis_available", { message: "Sin unidades disponibles." });
        return;
    }


    // 🚖 BUSQUEDA DE CANDIDATOS ACTIVOS
    const taxistasCandidatos = await Position.find({
        role: "taxista",
        estado: "activo",
        lat: { $exists: true, $ne: null, $gt: 0 },
        lng: { $exists: true, $nin: [null, 0] },
        email: { $nin: currentExcluidos }
    }).lean() as IPosition[];

    if (taxistasCandidatos.length === 0) {
        logMotor("dispatch_retry", `Pasajero=${pEmail} Intento=${attempt} -> No hay taxistas disponibles`, "WARN");
        io.to(pEmail).emit("no_taxis_available", { message: "Buscando más conductores..." });
        return;
    }

    const elMasCercano = taxistasCandidatos.reduce((prev, curr) => {
        const distPrev = calculateDistance(pasajeroData.lat, pasajeroData.lng, prev.lat, prev.lng);
        const distCurr = calculateDistance(pasajeroData.lat, pasajeroData.lng, curr.lat, curr.lng);
        return distPrev < distCurr ? prev : curr;
    });

    const tEmail = elMasCercano.email.toLowerCase().trim();
    // Generar dirección de recogida con reverseGeocode
    const direccion = await reverseGeocode(pasajeroData.lat, pasajeroData.lng);

    // Asignamos temporalmente al taxista
    await Position.updateOne({ email: tEmail }, { $set: { estado: "asignado", pasajeroAsignado: pEmail } });
    await Position.updateOne(
        { email: pEmail },
        { $set: { estado: "preasignado", pickupAddress: direccion, requestId: reqId } }
    );
    logMotor("geocoding", `Dirección generada e inyectada: ${direccion} para ${pEmail}`, "INFO");

    const distancia = calculateDistance(
        pasajeroData.lat,
        pasajeroData.lng,
        elMasCercano.lat,
        elMasCercano.lng
    );

    const fullPayload = {
        ...pasajeroData,
        email: pEmail,
        pasajeroEmail: pEmail,
        taxistaEmail: tEmail,
        pasajeroLat: pasajeroData.lat,
        pasajeroLng: pasajeroData.lng,
        pickupAddress: direccion,
        excludedEmails: currentExcluidos,
        isNewOffer: true,
        attempt,
        distancia
    };


    io.to(tEmail).emit("pasajero_asignado", fullPayload);

    if (elMasCercano.pushSubscription) {
        enviarNotificacionPush(elMasCercano.pushSubscription, fullPayload, tEmail);
    }

    const timeout = setTimeout(async () => {
        const tCheck = await Position.findOne({ email: tEmail }).lean();
        const pRefresh = await Position.findOne({ email: pEmail }).lean();

        // 🚦 Candado crítico: si el pasajero ya está en viaje, ignoramos el timeout
        if (pRefresh && ["encamino", "encurso", "finalizado"].includes(pRefresh.estado)) {
            logMotor("dispatch_timeout", `Pasajero=${pEmail} Estado=${pRefresh.estado} -> Timeout ignorado, viaje activo`, "INFO"); pendingTimeouts.delete(pEmail); // limpiamos el registro para no dejar hilos colgados
            return;
        }

        // 🚦 Candado extra: si el requestId cambió, este timeout es obsoleto
        if (pRefresh && pRefresh.requestId !== reqId) {
            logMotor("dispatch_timeout", `Pasajero=${pEmail} RequestIdActual=${pRefresh.requestId} RequestIdEsperado=${reqId} -> Timeout obsoleto ignorado`, "WARN"); pendingTimeouts.delete(pEmail);
            return;
        }

        // 👉 Si el taxista sigue asignado y el requestId coincide, relanzamos cascada
        if (tCheck && tCheck.estado === "asignado" && pRefresh && pRefresh.requestId === reqId) {
            logMotor("dispatch_timeout", `Pasajero=${pEmail} Taxista=${tEmail} Intento=${attempt} -> Taxista no respondió, relanzando cascada`, "INFO");
            io.to(tEmail).emit("dispatch_timeout");
            await Position.updateOne({ email: tEmail }, { $set: { estado: "activo", pasajeroAsignado: null } });
            io.emit("panel_update", { email: tEmail, estado: "activo" });

            dispatchWithRetry(io, pasajeroData, [...currentExcluidos, tEmail], attempt + 1);
        }
    }, 22000);

    pendingTimeouts.set(pEmail, timeout);

    logMotor("dispatch_retry", `Pasajero=${pEmail} Intento=${attempt} -> Taxista=${tEmail} asignado. Timeout programado`, "INFO");
}