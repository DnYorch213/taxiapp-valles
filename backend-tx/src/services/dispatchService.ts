// src/services/dispatchService.ts
import { Server } from "socket.io";
import { Position, IPosition } from "../models/Position";
import { calculateDistance } from "../utils/distance";
import { reverseGeocode } from "./geocodingService";
import { enviarNotificacionPush } from "./pushService";
import { logMotor } from "../utils/logger";
import { POSITION_STATES, STATE_GROUPS } from "../constants/states";
import { emitToTripRoom } from "./tripRoomService";

// 🎯 Mapa de timeouts pendientes (clave: requestId)
export const activeTimeouts = new Map<string, Set<NodeJS.Timeout>>();

const requestAttemptTokens = new Map<string, string>();
const respondedTaxistasByRequest = new Map<string, Set<string>>();

// 🎯 Candado por requestId para evitar cascadas concurrentes
const activeDispatches = new Set<string>();

// 🎯 Índice auxiliar para ubicar el requestId activo de cada pasajero
const passengerActiveRequestIds = new Map<string, string>();

// 🎯 Configuración configurable
const MAX_RETRIES = 5;
const MAX_DISPATCH_DISTANCE_KM = 15;
const BASE_TIMEOUT_MS = 30000;
const TIMEOUT_PER_KM_MS = 1000;
const MAX_TIMEOUT_MS = 60000;
const RETRY_BACKOFF_MS = 1500;

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

export const registerPendingTimeout = (requestId: string, timeout: NodeJS.Timeout) => {
    const bucket = getTimeoutBucket(requestId);
    bucket.add(timeout);
    return timeout;
};

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

export const registerTaxiResponseForRequest = (requestId: string | null | undefined, tEmail: string | null | undefined) => {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedEmail = normalizeEmail(String(tEmail || ""));
    if (!normalizedRequestId || !normalizedEmail) return;

    let bucket = respondedTaxistasByRequest.get(normalizedRequestId);
    if (!bucket) {
        bucket = new Set<string>();
        respondedTaxistasByRequest.set(normalizedRequestId, bucket);
    }
    bucket.add(normalizedEmail);
};

export const clearTaxiResponseRegistry = (requestId: string | null | undefined) => {
    const normalizedRequestId = String(requestId || "").trim();
    if (!normalizedRequestId) return;
    respondedTaxistasByRequest.delete(normalizedRequestId);
};

const isTaxiAlreadyRespondedForRequest = (requestId: string | null | undefined, tEmail: string | null | undefined) => {
    const normalizedRequestId = String(requestId || "").trim();
    const normalizedEmail = normalizeEmail(String(tEmail || ""));
    if (!normalizedRequestId || !normalizedEmail) return false;

    const bucket = respondedTaxistasByRequest.get(normalizedRequestId);
    return Boolean(bucket?.has(normalizedEmail));
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
    requestAttemptTokens.delete(requestId);
    unlockDispatchCycle(requestId);
};

const calculateDynamicTimeout = (distanciaKm: number): number => {
    const timeout = BASE_TIMEOUT_MS + (distanciaKm * TIMEOUT_PER_KM_MS);
    return Math.min(timeout, MAX_TIMEOUT_MS);
};

// 🚨 CORRECCIÓN 3: Optimización de consulta y eliminación del bucle N+1 de sockets
const getDispatchCandidates = async (
    io: Server,
    pasajeroData: { email: string; requestId?: string; lat?: number; lng?: number; name?: string; pickupAddress?: string },
    currentExcluidos: string[]
): Promise<{ candidates: IPosition[]; source: "db" | "none" }> => {
    const excluded = new Set(currentExcluidos.map(normalizeEmail));

    if (pasajeroData.lat != null && pasajeroData.lng != null) {
        try {
            const geoCandidates = await Position.find({
                role: "taxista",
                estado: POSITION_STATES.ACTIVO,
                email: { $nin: Array.from(excluded) },
                location: {
                    $near: {
                        $geometry: { type: "Point", coordinates: [pasajeroData.lng, pasajeroData.lat] },
                        $maxDistance: MAX_DISPATCH_DISTANCE_KM * 1000
                    }
                }
            }).limit(20).lean() as IPosition[];

            if (geoCandidates.length > 0) {
                return { candidates: geoCandidates, source: "db" };
            }
        } catch (geoError) {
            logMotor("dispatch_geo", `Fallo en query geoespacial, usando fallback: ${geoError}`, "WARN");
        }
    }

    const dbCandidates = await Position.find({
        role: "taxista",
        estado: POSITION_STATES.ACTIVO,
        email: { $nin: Array.from(excluded) },
        lat: { $exists: true, $ne: null, $gt: 0 },
        lng: { $exists: true, $ne: null, $nin: [null, 0] },
    }).limit(20).lean() as IPosition[];

    if (dbCandidates.length > 0) {
        return { candidates: dbCandidates, source: "db" };
    }

    return { candidates: [], source: "none" };
};

const runDispatchWithRetry = async (
    io: Server,
    pasajeroData: { email: string; requestId?: string; lat?: number; lng?: number; name?: string; pickupAddress?: string },
    excludedEmails: string[] = [],
    attempt: number = 1,
    transactionAttempt: number = 1
) => {
    if (!isAutoMode || !pasajeroData || !pasajeroData.email) {
        unlockDispatchCycle(pasajeroData.requestId || "");
        return;
    }

    const pEmail = pasajeroData.email.toLowerCase().trim();
    const currentExcluidos = [...new Set(excludedEmails.map(e => e.toLowerCase().trim()))];
    const reqId = pasajeroData.requestId;

    if (!reqId) {
        logMotor("dispatch_retry", `Pasajero=${pEmail} -> requestId no proporcionado`, "ERROR");
        return;
    }

    const currentAttemptToken = `${reqId}_v${attempt}_${Date.now()}`;
    requestAttemptTokens.set(reqId, currentAttemptToken);

    try {
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
            clearDispatchCycle(reqId, "hilo secundario detectó viaje activo");
            return;
        }

        if (pStatusCheck.requestId !== reqId) {
            logMotor("dispatch_retry", `Pasajero=${pEmail} -> RequestId obsoleto`, "WARN");
            clearDispatchCycle(reqId, "requestId antiguo");
            return;
        }

        if ([POSITION_STATES.CANCELADO, POSITION_STATES.FINALIZADO].includes(pStatusCheck.estado as any)) {
            await Position.updateMany(
                { role: "taxista", estado: POSITION_STATES.ASIGNADO, pasajeroAsignado: pEmail },
                { $set: { estado: POSITION_STATES.ACTIVO, pasajeroAsignado: null, updatedAt: new Date() } }
            );
        }

        if (attempt > MAX_RETRIES) {
            logMotor("dispatch_retry", `Pasajero=${pEmail} -> Límite alcanzado`, "ERROR");
            await Position.updateOne(
                { email: pEmail },
                { $set: { estado: POSITION_STATES.CANCELADO, taxistaAsignado: null, pasajeroAsignado: null, requestId: null, updatedAt: new Date() } }
            );
            io.to(pEmail).emit("no_taxis_available", { message: "Sin unidades disponibles." });
            clearPassengerRequestBinding(pEmail);
            clearTaxiResponseRegistry(reqId);
            clearDispatchCycle(reqId, "límite de reintentos");
            return;
        }

        const { candidates: taxistasCandidatos, source } = await getDispatchCandidates(io, pasajeroData, currentExcluidos);

        if (taxistasCandidatos.length === 0) {
            logMotor("dispatch_retry", `Pasajero=${pEmail} Intento=${attempt} -> No hay taxistas activos disponibles`, "WARN");
            clearDispatchCycle(reqId, "sin taxistas activos");

            if (attempt >= MAX_RETRIES) {
                await Position.updateOne(
                    { email: pEmail },
                    { $set: { estado: POSITION_STATES.CANCELADO, taxistaAsignado: null, pasajeroAsignado: null, requestId: null, updatedAt: new Date() } }
                );
                io.to(pEmail).emit("no_taxis_available", { message: "Sin unidades disponibles." });
                clearPassengerRequestBinding(pEmail);
                clearTaxiResponseRegistry(reqId);
                return;
            }

            setTimeout(() => {
                void runDispatchWithRetry(io, pasajeroData, currentExcluidos, attempt + 1);
            }, RETRY_BACKOFF_MS);
            return;
        }

        const taxistasConDistancia = taxistasCandidatos
            .map(taxista => ({
                taxista,
                distancia: (taxista.lat && taxista.lng && pasajeroData.lat && pasajeroData.lng)
                    ? calculateDistance(pasajeroData.lat, pasajeroData.lng, taxista.lat, taxista.lng)
                    : Infinity // ← CORREGIDO: Ya no existe socket-fallback, por defecto es Infinity
            }))
            .filter(({ distancia }) => {
                if (distancia === Infinity) return false;
                return distancia <= MAX_DISPATCH_DISTANCE_KM;
            })
            .sort((a, b) => a.distancia - b.distancia);

        if (taxistasConDistancia.length === 0) {
            logMotor("dispatch_retry", `Pasajero=${pEmail} -> Fuera de radio`, "WARN");
            clearDispatchCycle(reqId, "sin taxistas en radio");

            if (attempt >= MAX_RETRIES) {
                await Position.updateOne(
                    { email: pEmail },
                    { $set: { estado: POSITION_STATES.CANCELADO, taxistaAsignado: null, pasajeroAsignado: null, requestId: null, updatedAt: new Date() } }
                );
                io.to(pEmail).emit("no_taxis_available", { message: "Sin unidades disponibles." });
                clearPassengerRequestBinding(pEmail);
                clearTaxiResponseRegistry(reqId);
                return;
            }

            setTimeout(() => {
                void runDispatchWithRetry(io, pasajeroData, currentExcluidos, attempt + 1);
            }, RETRY_BACKOFF_MS);
            return;
        }

        const elegibles = taxistasConDistancia.filter(({ taxista }) => !isTaxiAlreadyRespondedForRequest(reqId, taxista.email));

        if (elegibles.length === 0) {
            logMotor("dispatch_retry", `Pasajero=${pEmail} Intento=${attempt} -> Todos los taxistas elegibles ya respondieron para esta solicitud`, "WARN");
            clearDispatchCycle(reqId, "sin taxistas elegibles restantes");
            return;
        }

        const { taxista: elMasCercano, distancia } = elegibles[0];
        const tEmail = elMasCercano.email.toLowerCase().trim();

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
                logMotor("dispatch_retry", `Pasajero=${pEmail} Taxista=${tEmail} -> Ya no está activo, reintentando de inmediato...`, "WARN");

                if (requestAttemptTokens.get(reqId) !== currentAttemptToken) return;

                await runDispatchWithRetry(io, pasajeroData, [...currentExcluidos, tEmail], attempt, transactionAttempt + 1);
                return;
            }

            const pasajeroPreasignado = await Position.updateOne(
                {
                    email: pEmail,
                    requestId: reqId,
                    estado: POSITION_STATES.BUSCANDO
                },
                { $set: { estado: POSITION_STATES.PREASIGNADO, taxistaAsignado: tEmail, updatedAt: new Date() } },
                { session }
            );

            if (!pasajeroPreasignado.modifiedCount) {
                await Position.updateOne(
                    { email: tEmail, estado: POSITION_STATES.ASIGNADO, pasajeroAsignado: pEmail },
                    { $set: { estado: POSITION_STATES.ACTIVO, pasajeroAsignado: null, updatedAt: new Date() } },
                    { session }
                );
                await session.abortTransaction();
                session.endSession();
                logMotor("dispatch_retry", `Pasajero=${pEmail} -> Conflicto de estado, cancelando hilo`, "WARN");
                unlockDispatchCycle(reqId);
                return;
            }

            await session.commitTransaction();
            session.endSession();
        } catch (txError) {
            await session.abortTransaction();
            session.endSession();

            const isRetryableConflict = String((txError as any)?.message || "").toLowerCase().includes("write conflict") ||
                String((txError as any)?.message || "").toLowerCase().includes("yielding is disabled");

            if (isRetryableConflict && transactionAttempt <= 3) {
                logMotor("dispatch_retry", `Pasajero=${pEmail} -> Reintentando asignación por conflicto de escritura (${transactionAttempt}/3)`, "WARN");
                await new Promise((resolve) => setTimeout(resolve, 250));
                return runDispatchWithRetry(io, pasajeroData, currentExcluidos, attempt, transactionAttempt + 1);
            }

            throw txError;
        }

        // 🎯 5. GEOCODIFICACIÓN & PAYLOAD
        let direccion = pasajeroData.pickupAddress;
        if (!direccion || direccion.includes("Calculando")) {
            try { if (pasajeroData.lat != null && pasajeroData.lng != null) { direccion = await getCachedGeocoding(pasajeroData.lat, pasajeroData.lng); } } catch (e) { direccion = "Ubicación no disponible"; }
        }

        // 🚨 RESCATE DE NOMBRE: Si el frontend no envió el nombre, lo recuperamos de la BD
        let nombrePasajero = pasajeroData.name;
        if (!nombrePasajero || nombrePasajero.trim() === "") {
            const userData = await Position.findOne({ email: pEmail }).lean();
            nombrePasajero = userData?.name || "Pasajero";
        }

        const fullPayload = {
            ...pasajeroData,
            name: nombrePasajero, // 🎯 Forzamos que el nombre siempre esté presente y correcto
            email: pEmail,
            pasajeroEmail: pEmail,
            taxistaEmail: tEmail,
            pickupAddress: direccion,
            attempt,
            distancia,
            timeoutMs: calculateDynamicTimeout(distancia)
        };

        // 🎯 6. EMISIÓN DE EVENTOS
        const taxiSockets = await io.in(tEmail).fetchSockets();
        if (taxiSockets.length > 0) {
            io.to(tEmail).emit("pasajero_asignado", fullPayload);
            logMotor("dispatch_retry", `Emitido pasajero_asignado a ${tEmail}`, "INFO");
        }

        // 🎯 NUEVO: Notificar a la sala del viaje para que ambos se coordinen
        try {
            // 🚨 AQUÍ SÍ USAMOS LA FUNCIÓN IMPORTADA
            // Esto envía el evento UNA SOLA VEZ a la sala compartida del viaje
            emitToTripRoom(io, reqId, "trip_created", {
                pasajeroEmail: pEmail,
                taxistaEmail: tEmail,
                pickupAddress: direccion,
                distancia,
                timestamp: Date.now()
            });

            logMotor("dispatch_retry", `Notificación de trip_created enviada a la sala del viaje ${reqId}`, "INFO");
        } catch (tripRoomErr) {
            logMotor("dispatch_retry", `Error al notificar creación de sala: ${tripRoomErr}`, "WARN");
        }
        if (elMasCercano.pushSubscription) {
            try { await enviarNotificacionPush(elMasCercano.pushSubscription, fullPayload, tEmail); } catch (pErr) {
                logMotor("push", `Error enviando push a ${tEmail}: ${pErr}`, "ERROR");
            }
        }

        io.emit("panel_update", { email: tEmail, estado: POSITION_STATES.ASIGNADO, pasajeroAsignado: pEmail });
        io.emit("panel_update", { email: pEmail, estado: POSITION_STATES.PREASIGNADO, taxistaAsignado: tEmail });

        const timeoutMs = calculateDynamicTimeout(distancia);

        const timeout = setTimeout(async () => {
            try {
                if (requestAttemptTokens.get(reqId) !== currentAttemptToken) {
                    logMotor("dispatch_timeout", `Fuga evitada: Ignorando timeout antiguo para ${tEmail}. Hilo obsoleto.`, "INFO");
                    return;
                }

                const bucket = activeTimeouts.get(reqId);
                if (bucket) bucket.delete(timeout);

                const tCheck = await Position.findOne({ email: tEmail }).lean();
                const pRefresh = await Position.findOne({ email: pEmail }).lean();

                // 🚨 CORRECCIÓN 1: Abortar si el pasajero ya canceló o finalizó
                if (pRefresh && [
                    POSITION_STATES.ASIGNADO,
                    POSITION_STATES.ENCAMINO,
                    POSITION_STATES.ENCURSO,
                    POSITION_STATES.CANCELADO,    // ← AGREGADO
                    POSITION_STATES.FINALIZADO    // ← AGREGADO
                ].includes(pRefresh.estado as any)) {
                    logMotor("dispatch_timeout", `Pasajero=${pEmail} -> Estado final o ya aceptado. Abortando reintento.`, "INFO");
                    clearDispatchCycle(reqId, "viaje finalizado o cancelado");
                    return;
                }

                // 🚨 CORRECCIÓN 2: Si el taxista ya no está asignado, liberar al pasajero y reintentar (no solo retornar)
                if (!tCheck || tCheck.estado !== POSITION_STATES.ASIGNADO) {
                    logMotor("dispatch_timeout", `Taxista=${tEmail} ya no está asignado. Liberando pasajero y reintentando...`, "WARN");

                    await Position.updateOne(
                        { email: pEmail, estado: POSITION_STATES.PREASIGNADO },
                        { $set: { estado: POSITION_STATES.BUSCANDO, taxistaAsignado: null, updatedAt: new Date() } }
                    );

                    io.emit("panel_update", { email: tEmail, estado: POSITION_STATES.ACTIVO, pasajeroAsignado: null });

                    clearDispatchCycle(reqId, "taxista ya no asignado, reintentando con otro");

                    // Disparar el siguiente intento inmediatamente
                    await runDispatchWithRetry(io, pasajeroData, [...currentExcluidos, tEmail], attempt + 1);
                    return;
                }

                logMotor("dispatch_timeout", `Pasajero=${pEmail} Taxista=${tEmail} Intento=${attempt} -> No respondió, aplicando fallback...`, "INFO");

                await Position.updateOne(
                    { email: tEmail, estado: POSITION_STATES.ASIGNADO, pasajeroAsignado: pEmail },
                    { $set: { estado: POSITION_STATES.ACTIVO, pasajeroAsignado: null, updatedAt: new Date() } }
                );

                io.to(tEmail).emit("dispatch_timeout", {
                    message: "El tiempo para responder la solicitud ha expirado",
                    requestId: reqId,
                    estado: POSITION_STATES.ACTIVO
                });

                await Position.updateOne(
                    { email: pEmail, estado: POSITION_STATES.PREASIGNADO, taxistaAsignado: tEmail },
                    { $set: { estado: POSITION_STATES.BUSCANDO, taxistaAsignado: null, updatedAt: new Date() } }
                );

                io.emit("panel_update", { email: tEmail, estado: POSITION_STATES.ACTIVO, pasajeroAsignado: null });

                clearDispatchCycle(reqId, "Relanzando siguiente conductor por inactividad");
                await runDispatchWithRetry(io, pasajeroData, [...currentExcluidos, tEmail], attempt + 1);

            } catch (tErr) {
                clearDispatchCycle(reqId, "error en timeout execution");
            }
        }, timeoutMs);

        registerPendingTimeout(reqId, timeout);

    } catch (error) {
        logMotor("dispatch_retry", `Error crítico en dispatch: ${error}`, "ERROR");
        clearDispatchCycle(reqId, "error crítico");
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
        logMotor("dispatch_retry", `RequestId=${reqId} -> Bloqueado de ráfaga concurrente activa.`, "WARN");
        return;
    }

    await runDispatchWithRetry(io, pasajeroData, excludedEmails, attempt);
};

export const clearAllTimeouts = () => {
    activeTimeouts.forEach((timeouts, key) => {
        timeouts.forEach((timeout) => clearTimeout(timeout));
        logMotor("dispatch_cleanup", `Timeout(s) limpiado(s) para ${key}`, "INFO");
    });
    activeTimeouts.clear();
};

export const getDispatchStats = () => {
    return {
        pendingTimeouts: Array.from(activeTimeouts.values()).reduce((total, bucket) => total + bucket.size, 0),
        isAutoMode,
        maxRetries: MAX_RETRIES,
        maxDistance: MAX_DISPATCH_DISTANCE_KM
    };
};