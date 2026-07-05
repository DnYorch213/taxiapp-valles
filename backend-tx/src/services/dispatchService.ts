// src/services/dispatchService.ts
import { Server } from "socket.io";
import { Position, IPosition } from "../models/Position";
import { calculateDistance } from "../utils/distance";
import { reverseGeocode } from "./geocodingService";
import { enviarNotificacionPush } from "./pushService";
import { logMotor } from "../utils/logger";
import { POSITION_STATES, STATE_GROUPS } from "../constants/states";

// 🎯 Mapa de timeouts pendientes (clave: requestId)
export const activeTimeouts = new Map<string, Set<NodeJS.Timeout>>();
export const pendingTimeouts = activeTimeouts;

// 🎯 Candado por requestId para evitar cascadas concurrentes
const activeDispatches = new Set<string>();

// 🎯 Índice auxiliar para ubicar el requestId activo de cada pasajero
const passengerActiveRequestIds = new Map<string, string>();

// 🎯 Configuración configurable
const MAX_RETRIES = 5;
const MAX_DISPATCH_DISTANCE_KM = 15; // 🆕 Distancia máxima para despachar
const BASE_TIMEOUT_MS = 15000; // 🆕 Timeout base: 15s
const TIMEOUT_PER_KM_MS = 1000; // 🆕 1s adicional por km de distancia
const MAX_TIMEOUT_MS = 45000; // 🆕 Timeout máximo: 45s

export let isAutoMode = true;

export const setAutoMode = (value: boolean) => {
    isAutoMode = value;
};

// 🆕 Caché simple para geocodificación (evita llamadas repetidas)
const geocodingCache = new Map<string, { address: string; timestamp: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

const getCachedGeocoding = async (lat: number, lng: number): Promise<string> => {
    const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
    const cached = geocodingCache.get(key);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return cached.address;
    }

    const address = await reverseGeocode(lat, lng);
    geocodingCache.set(key, { address, timestamp: Date.now() });
    return address;
};

const normalizeEmail = (email: string) => email.toLowerCase().trim();

const getTimeoutBucket = (requestId: string) => {
    let bucket = activeTimeouts.get(requestId);
    if (!bucket) {
        bucket = new Set<NodeJS.Timeout>();
        activeTimeouts.set(requestId, bucket);
    }
    return bucket;
};

export const bindPassengerRequestId = (pEmail: string, requestId: string) => {
    passengerActiveRequestIds.set(normalizeEmail(pEmail), requestId);
};

export const getActiveRequestIdForPassenger = (pEmail: string) => {
    return passengerActiveRequestIds.get(normalizeEmail(pEmail)) || null;
};

// 🆕 Función auxiliar para registrar timeouts por request
export const registerPendingTimeout = (requestId: string, timeout: NodeJS.Timeout) => {
    const bucket = getTimeoutBucket(requestId);
    bucket.add(timeout);
    return timeout;
};

// 🆕 Función auxiliar para limpiar todos los timeouts del request activo de un pasajero
export const clearPendingTimeouts = (pEmail: string, reason: string) => {
    const key = normalizeEmail(pEmail);
    const requestId = passengerActiveRequestIds.get(key);

    if (!requestId) return;

    clearDispatchCycle(requestId, reason);
    passengerActiveRequestIds.delete(key);
};

export const clearRequestTimeouts = (requestId: string, reason: string) => {
    const bucket = activeTimeouts.get(requestId);

    if (!bucket || bucket.size === 0) {
        activeTimeouts.delete(requestId);
        return;
    }

    bucket.forEach((timeout) => clearTimeout(timeout));
    activeTimeouts.delete(requestId);
    logMotor("dispatch_cleanup", `RequestId=${requestId} -> ${bucket.size} timeout(s) limpiado(s): ${reason}`, "INFO");
};

export const clearPassengerRequestBinding = (pEmail: string) => {
    passengerActiveRequestIds.delete(normalizeEmail(pEmail));
};

export const lockDispatchCycle = (requestId: string) => {
    if (activeDispatches.has(requestId)) return false;
    activeDispatches.add(requestId);
    return true;
};

export const unlockDispatchCycle = (requestId: string) => {
    activeDispatches.delete(requestId);
};

export const clearDispatchCycle = (requestId: string, reason: string) => {
    clearRequestTimeouts(requestId, reason);
    unlockDispatchCycle(requestId); // 🔓 Aquí es donde se debe liberar el candado de forma segura
};

// 🆕 Calcular timeout dinámico basado en distancia
const calculateDynamicTimeout = (distanciaKm: number): number => {
    const timeout = BASE_TIMEOUT_MS + (distanciaKm * TIMEOUT_PER_KM_MS);
    return Math.min(timeout, MAX_TIMEOUT_MS);
};

// ... (Tus imports y variables superiores se mantienen igual)

const runDispatchWithRetry = async (
    io: Server,
    pasajeroData: any,
    excludedEmails: string[] = [],
    attempt: number = 1
) => {
    if (!isAutoMode || !pasajeroData || !pasajeroData.email) {
        unlockDispatchCycle(pasajeroData?.requestId);
        return;
    }

    const pEmail = pasajeroData.email.toLowerCase().trim();
    const currentExcluidos = [...new Set(excludedEmails.map(e => e.toLowerCase().trim()))];
    const reqId = pasajeroData.requestId;

    if (!reqId) {
        logMotor("dispatch_retry", `Pasajero=${pEmail} -> requestId no proporcionado`, "ERROR");
        return;
    }

    try {
        // 🎯 1. VALIDACIÓN INICIAL DEL ESTADO DEL PASAJERO
        const pStatusCheck = await Position.findOne({ email: pEmail }).lean();

        if (!pStatusCheck) {
            logMotor("dispatch_retry", `Pasajero=${pEmail} -> No encontrado en BD`, "WARN");
            unlockDispatchCycle(reqId);
            return;
        }

        if (
            [POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO].includes(pStatusCheck.estado as any) ||
            pStatusCheck.estado === POSITION_STATES.FINALIZADO ||
            pStatusCheck.estado === POSITION_STATES.CANCELADO
        ) {
            logMotor("dispatch_retry", `Pasajero=${pEmail} Estado=${pStatusCheck.estado} Intento=${attempt} -> Viaje activo/finalizado`, "WARN");
            unlockDispatchCycle(reqId);
            return;
        }

        if (
            [POSITION_STATES.BUSCANDO, POSITION_STATES.PREASIGNADO].includes(pStatusCheck.estado as any) &&
            pStatusCheck.requestId !== reqId
        ) {
            logMotor("dispatch_retry", `Pasajero=${pEmail} Intento=${attempt} -> RequestId obsoleto (Actual: ${pStatusCheck.requestId}, Esperado: ${reqId})`, "WARN");
            unlockDispatchCycle(reqId);
            return;
        }

        if (attempt > MAX_RETRIES) {
            logMotor("dispatch_retry", `Pasajero=${pEmail} Intento=${attempt} -> Límite de intentos alcanzado`, "ERROR");
            await Position.updateOne(
                { email: pEmail },
                { $set: { estado: POSITION_STATES.CANCELADO, pasajeroAsignado: null, updatedAt: new Date() } }
            );
            io.to(pEmail).emit("no_taxis_available", { message: "Sin unidades disponibles." });
            clearDispatchCycle(reqId, "límite de reintentos");
            return;
        }

        // 🎯 2. BÚSQUEDA DE TAXISTAS CANDIDATOS
        const taxistasCandidatos = await Position.find({
            role: "taxista",
            estado: POSITION_STATES.ACTIVO,
            lat: { $exists: true, $ne: null, $gt: 0 },
            lng: { $exists: true, $ne: null, $nin: [null, 0] },
            email: { $nin: currentExcluidos }
        }).lean() as IPosition[];

        if (taxistasCandidatos.length === 0) {
            logMotor("dispatch_retry", `Pasajero=${pEmail} Intento=${attempt} -> No hay taxistas activos disponibles`, "WARN");
            io.to(pEmail).emit("no_taxis_available", { message: "Buscando más conductores..." });
            clearDispatchCycle(reqId, "sin taxistas activos disponibles");
            return;
        }

        // 🎯 3. ENCONTRAR EL MÁS CERCANO
        const taxistasConDistancia = taxistasCandidatos
            .map(taxista => ({
                taxista,
                distancia: (taxista.lat && taxista.lng && pasajeroData.lat && pasajeroData.lng)
                    ? calculateDistance(pasajeroData.lat, pasajeroData.lng, taxista.lat, taxista.lng)
                    : Infinity
            }))
            .filter(({ distancia }) => distancia <= MAX_DISPATCH_DISTANCE_KM && distancia !== Infinity)
            .sort((a, b) => a.distancia - b.distancia);

        if (taxistasConDistancia.length === 0) {
            logMotor("dispatch_retry", `Pasajero=${pEmail} Intento=${attempt} -> No hay taxistas en radio`, "WARN");
            io.to(pEmail).emit("no_taxis_available", { message: "Sin unidades en el radio permitido." });
            clearDispatchCycle(reqId, "sin taxistas en radio");
            return;
        }

        const { taxista: elMasCercano, distancia } = taxistasConDistancia[0];
        const tEmail = elMasCercano.email.toLowerCase().trim();

        logMotor("dispatch_retry", `Pasajero=${pEmail} Intento=${attempt} -> Taxista más cercano: ${tEmail} a ${distancia.toFixed(2)}km`, "INFO");

        // 🎯 4. ASIGNACIÓN ATÓMICA CON TRANSACCIÓN
        const session = await Position.startSession();
        session.startTransaction();

        try {
            const taxistaActualizado = await Position.findOneAndUpdate(
                { email: tEmail, estado: POSITION_STATES.ACTIVO },
                { $set: { estado: POSITION_STATES.ASIGNADO, pasajeroAsignado: pEmail, updatedAt: new Date() } },
                { session, returnDocument: "after" }
            );

            if (!taxistaActualizado) {
                await session.abortTransaction();
                session.endSession();
                logMotor("dispatch_retry", `Pasajero=${pEmail} Taxista=${tEmail} -> Ya no está activo, saltando...`, "WARN");
                // Recursión controlada: pasamos directo sin cerrar candado porque seguimos buscando en este hilo
                await runDispatchWithRetry(io, pasajeroData, [...currentExcluidos, tEmail], attempt);
                return;
            }

            const pasajeroPreasignado = await Position.updateOne(
                {
                    email: pEmail,
                    requestId: reqId,
                    $or: [
                        { estado: POSITION_STATES.BUSCANDO, taxistaAsignado: null },
                        { estado: POSITION_STATES.PREASIGNADO, taxistaAsignado: tEmail }
                    ]
                },
                { $set: { estado: POSITION_STATES.PREASIGNADO, taxistaAsignado: tEmail, updatedAt: new Date() } },
                { session }
            );

            if (!pasajeroPreasignado.modifiedCount) {
                // Rollback manual del taxista
                await Position.updateOne(
                    { email: tEmail, estado: POSITION_STATES.ASIGNADO, pasajeroAsignado: pEmail },
                    { $set: { estado: POSITION_STATES.ACTIVO, pasajeroAsignado: null, updatedAt: new Date() } },
                    { session }
                );
                await session.abortTransaction();
                session.endSession();
                logMotor("dispatch_retry", `Pasajero=${pEmail} Taxista=${tEmail} -> Conflicto de estado en pasajero, saltando...`, "WARN");
                await runDispatchWithRetry(io, pasajeroData, [...currentExcluidos, tEmail], attempt);
                return;
            }

            await session.commitTransaction();
            session.endSession();
        } catch (txError) {
            await session.abortTransaction();
            session.endSession();
            throw txError;
        }

        // 🎯 5. GEOCODIFICACIÓN & PAYLOAD
        let direccion = pasajeroData.pickupAddress;
        if (!direccion || direccion.includes("Calculando")) {
            try {
                direccion = await getCachedGeocoding(pasajeroData.lat, pasajeroData.lng);
                await Position.updateOne({ email: pEmail }, { $set: { pickupAddress: direccion } });
            } catch (e) { direccion = "Ubicación no disponible"; }
        }

        const fullPayload = {
            ...pasajeroData,
            email: pEmail,
            pasajeroEmail: pEmail,
            taxistaEmail: tEmail,
            pickupAddress: direccion,
            attempt,
            distancia,
            timeoutMs: calculateDynamicTimeout(distancia)
        };

        // 🎯 6. NOTIFICAR EMISIÓN
        const taxiSockets = await io.in(tEmail).fetchSockets();
        if (taxiSockets.length > 0) {
            io.to(tEmail).emit("pasajero_asignado", fullPayload);
        }
        if (elMasCercano.pushSubscription) {
            try { await enviarNotificacionPush(elMasCercano.pushSubscription, fullPayload, tEmail); } catch (pErr) { }
        }

        io.emit("panel_update", { email: tEmail, estado: POSITION_STATES.ASIGNADO, pasajeroAsignado: pEmail });
        io.emit("panel_update", { email: pEmail, estado: POSITION_STATES.PREASIGNADO, taxistaAsignado: tEmail });

        // 🎯 7. PROGRAMAR TIMEOUT
        clearRequestTimeouts(reqId, "nuevo intento de despacho");
        const timeoutMs = calculateDynamicTimeout(distancia);

        const timeout = setTimeout(async () => {
            try {
                const bucket = activeTimeouts.get(reqId);
                if (bucket) bucket.delete(timeout);

                const tCheck = await Position.findOne({ email: tEmail }).lean();
                const pRefresh = await Position.findOne({ email: pEmail }).lean();

                // Si el viaje ya avanzó por aceptación legítima, abortar el timeout sin romper nada
                if (pRefresh && [POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO].includes(pRefresh.estado as any)) {
                    logMotor("dispatch_timeout", `Pasajero=${pEmail} Estado=${pRefresh.estado} -> Solicitud aceptada, cerrando hilo.`, "INFO");
                    clearDispatchCycle(reqId, "viaje activo");
                    return;
                }

                if (pRefresh && pRefresh.requestId !== reqId) {
                    clearDispatchCycle(reqId, "requestId obsoleto en timeout");
                    return;
                }

                // 🚨 CORRECCIÓN AQUÍ: Si ya no está asignado (ej. interactuó de otra forma), salimos pacíficamente
                // SIN limpiar todo el mapa de dispatches globales.
                if (!tCheck || tCheck.estado !== POSITION_STATES.ASIGNADO) {
                    logMotor("dispatch_timeout", `Taxista=${tEmail} Estado=${tCheck?.estado} -> Ya cambió de estado, cerrando timeout antiguo.`, "INFO");
                    clearDispatchCycle(reqId, "taxista cambió de estado");
                    return;
                }

                logMotor("dispatch_timeout", `Pasajero=${pEmail} Taxista=${tEmail} -> Expiró tiempo de respuesta. Liberando unidad...`, "INFO");

                // Liberar taxista que no respondió
                const taxistaLiberado = await Position.updateOne(
                    { email: tEmail, estado: POSITION_STATES.ASIGNADO, pasajeroAsignado: pEmail },
                    { $set: { estado: POSITION_STATES.ACTIVO, pasajeroAsignado: null, updatedAt: new Date() } }
                );

                if (!taxistaLiberado.modifiedCount) {
                    clearDispatchCycle(reqId, "liberación de taxista no aplicada");
                    return;
                }

                io.to(tEmail).emit("dispatch_timeout");

                await Position.updateOne(
                    { email: pEmail, estado: POSITION_STATES.PREASIGNADO, taxistaAsignado: tEmail },
                    { $set: { estado: POSITION_STATES.BUSCANDO, taxistaAsignado: null, updatedAt: new Date() } }
                );

                io.emit("panel_update", { email: tEmail, estado: POSITION_STATES.ACTIVO });

                // Limpiamos timers del intento actual, pero mantenemos el ciclo en este hilo secuencial.
                clearRequestTimeouts(reqId, "relanzando cascada");
                await runDispatchWithRetry(io, pasajeroData, [...currentExcluidos, tEmail], attempt + 1);

            } catch (tErr) {
                clearDispatchCycle(reqId, "error en timeout");
            }
        }, timeoutMs);

        registerPendingTimeout(reqId, timeout);

        logMotor(
            "dispatch_retry",
            `Pasajero=${pEmail} Intento=${attempt} -> Taxista=${tEmail} asignado. Timeout programado: ${timeoutMs}ms`,
            "INFO"
        );

    } catch (error) {
        logMotor("dispatch_retry", `Error crítico en dispatch: ${error}`, "ERROR");
        clearDispatchCycle(reqId, "error crítico en dispatch");
    }
};

export const dispatchWithRetry = async (
    io: Server,
    pasajeroData: any,
    excludedEmails: string[] = [],
    attempt: number = 1
) => {
    const reqId = pasajeroData?.requestId;
    if (!reqId) return;

    if (!lockDispatchCycle(reqId)) {
        logMotor("dispatch_retry", `RequestId=${reqId} -> Bloqueado: Operación en curso.`, "WARN");
        return;
    }

    await runDispatchWithRetry(io, pasajeroData, excludedEmails, attempt);
};

// 🆕 Función para limpiar todos los timeouts (útil en shutdown)
export const clearAllTimeouts = () => {
    pendingTimeouts.forEach((timeouts, key) => {
        timeouts.forEach((timeout) => clearTimeout(timeout));
        logMotor("dispatch_cleanup", `Timeout(s) limpiado(s) para ${key}`, "INFO");
    });
    pendingTimeouts.clear();
};

// 🆕 Función para obtener estadísticas de despacho
export const getDispatchStats = () => {
    return {
        pendingTimeouts: Array.from(pendingTimeouts.values()).reduce((total, bucket) => total + bucket.size, 0),
        isAutoMode,
        maxRetries: MAX_RETRIES,
        maxDistance: MAX_DISPATCH_DISTANCE_KM
    };
};