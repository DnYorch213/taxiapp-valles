// src/services/dispatchService.ts
import { Server } from "socket.io";
import { Position, IPosition } from "../models/Position";
import { calculateDistance } from "../utils/distance";
import { reverseGeocode } from "./geocodingService";
import { enviarNotificacionPush } from "./pushService";
import { logMotor } from "../utils/logger";
import { POSITION_STATES, STATE_GROUPS } from "../constants/states";

// 🎯 Mapa de timeouts pendientes (clave: email del pasajero)
export const pendingTimeouts = new Map<string, NodeJS.Timeout>();

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

// 🆕 Función auxiliar para limpiar timeout de forma segura
const clearPendingTimeout = (pEmail: string, reason: string) => {
    const oldTimeout = pendingTimeouts.get(pEmail);
    if (oldTimeout) {
        clearTimeout(oldTimeout);
        pendingTimeouts.delete(pEmail);
        logMotor("dispatch_cleanup", `Pasajero=${pEmail} -> Timeout limpiado: ${reason}`, "INFO");
    }
};

// 🆕 Calcular timeout dinámico basado en distancia
const calculateDynamicTimeout = (distanciaKm: number): number => {
    const timeout = BASE_TIMEOUT_MS + (distanciaKm * TIMEOUT_PER_KM_MS);
    return Math.min(timeout, MAX_TIMEOUT_MS);
};

export const dispatchWithRetry = async (
    io: Server,
    pasajeroData: any,
    excludedEmails: string[] = [],
    attempt: number = 1
) => {
    if (!isAutoMode || !pasajeroData || !pasajeroData.email) return;

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
            return;
        }

        // 🛡️ Candado: Si el viaje ya avanzó más allá de búsqueda, abortar
        // Nota: PREASIGNADO debe permitir reintento cuando un taxista ignora/timeout.
        if (
            [POSITION_STATES.ASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO].includes(pStatusCheck.estado as any) ||
            pStatusCheck.estado === POSITION_STATES.FINALIZADO ||
            pStatusCheck.estado === POSITION_STATES.CANCELADO
        ) {
            logMotor(
                "dispatch_retry",
                `Pasajero=${pEmail} Estado=${pStatusCheck.estado} Intento=${attempt} -> Viaje ya en curso/finalizado`,
                "WARN"
            );
            clearPendingTimeout(pEmail, "viaje ya activo/finalizado");
            return;
        }

        // 🛡️ Candado: Si el requestId cambió, este hilo es obsoleto
        if (
            pStatusCheck.estado === POSITION_STATES.BUSCANDO &&
            pStatusCheck.requestId &&
            pStatusCheck.requestId !== reqId
        ) {
            logMotor(
                "dispatch_retry",
                `Pasajero=${pEmail} Intento=${attempt} -> RequestId obsoleto (Actual: ${pStatusCheck.requestId}, Esperado: ${reqId})`,
                "WARN"
            );
            clearPendingTimeout(pEmail, "requestId obsoleto");
            return;
        }

        // 🛡️ Candado: Límite de reintentos
        if (attempt > MAX_RETRIES) {
            logMotor(
                "dispatch_retry",
                `Pasajero=${pEmail} Intento=${attempt} -> Límite de intentos alcanzado`,
                "ERROR"
            );

            await Position.updateOne(
                { email: pEmail },
                {
                    $set: {
                        estado: POSITION_STATES.CANCELADO,
                        pasajeroAsignado: null,
                        updatedAt: new Date()
                    }
                }
            );

            io.to(pEmail).emit("no_taxis_available", {
                message: "Sin unidades disponibles después de varios intentos."
            });

            clearPendingTimeout(pEmail, "límite de reintentos");
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
            logMotor(
                "dispatch_retry",
                `Pasajero=${pEmail} Intento=${attempt} -> No hay taxistas activos disponibles (excluidos=${currentExcluidos.join(",") || "ninguno"})`,
                "WARN"
            );
            io.to(pEmail).emit("no_taxis_available", {
                message: "Buscando más conductores..."
            });
            return;
        }

        // 🎯 3. ENCONTRAR EL MÁS CERCANO (OPTIMIZADO)
        const taxistasConDistancia = taxistasCandidatos
            .map(taxista => ({
                taxista,
                distancia: (taxista.lat && taxista.lng && pasajeroData.lat && pasajeroData.lng)
                    ? calculateDistance(pasajeroData.lat, pasajeroData.lng, taxista.lat, taxista.lng)
                    : Infinity // Si no tiene coordenadas, descartar
            }))
            .filter(({ distancia }) => distancia <= MAX_DISPATCH_DISTANCE_KM && distancia !== Infinity)
            .sort((a, b) => a.distancia - b.distancia);

        if (taxistasConDistancia.length === 0) {
            logMotor(
                "dispatch_retry",
                `Pasajero=${pEmail} Intento=${attempt} -> No hay taxistas dentro de ${MAX_DISPATCH_DISTANCE_KM}km (excluidos=${currentExcluidos.join(",") || "ninguno"})`,
                "WARN"
            );
            io.to(pEmail).emit("no_taxis_available", {
                message: `No hay unidades disponibles en un radio de ${MAX_DISPATCH_DISTANCE_KM}km.`
            });
            return;
        }

        const { taxista: elMasCercano, distancia } = taxistasConDistancia[0];
        const tEmail = elMasCercano.email.toLowerCase().trim();

        logMotor(
            "dispatch_retry",
            `Pasajero=${pEmail} Intento=${attempt} -> Taxista más cercano: ${tEmail} a ${distancia.toFixed(2)}km`,
            "INFO"
        );

        // 🆕 VALIDACIÓN ADICIONAL antes de usar coordenadas
        if (!elMasCercano.lat || !elMasCercano.lng || !pasajeroData.lat || !pasajeroData.lng) {
            logMotor(
                "dispatch_retry",
                `Pasajero=${pEmail} Taxista=${tEmail} -> Coordenadas faltantes, reintentando`,
                "WARN"
            );
            dispatchWithRetry(io, pasajeroData, [...currentExcluidos, tEmail], attempt);
            return;
        }

        // Ahora TypeScript sabe que todos los valores son number
        const distanciaFinal = calculateDistance(
            pasajeroData.lat,
            pasajeroData.lng,
            elMasCercano.lat,
            elMasCercano.lng
        );

        // 🎯 4. ASIGNACIÓN ATÓMICA DEL TAXISTA (evita condiciones de carrera)
        const session = await Position.startSession();
        session.startTransaction();

        try {
            // Intentar asignar el taxista solo si sigue ACTIVO
            const taxistaActualizado = await Position.findOneAndUpdate(
                {
                    email: tEmail,
                    estado: POSITION_STATES.ACTIVO // 🆕 Candado: solo si sigue activo
                },
                {
                    $set: {
                        estado: POSITION_STATES.ASIGNADO,
                        pasajeroAsignado: pEmail,
                        updatedAt: new Date()
                    }
                },
                { session, returnDocument: "after" }
            );

            // Si no se pudo actualizar (otro despacho lo tomó), abortar
            if (!taxistaActualizado) {
                await session.abortTransaction();
                session.endSession();

                logMotor(
                    "dispatch_retry",
                    `Pasajero=${pEmail} Taxista=${tEmail} -> Ya no está activo, reintentando`,
                    "WARN"
                );

                // Reintentar con el siguiente taxista
                dispatchWithRetry(io, pasajeroData, [...currentExcluidos, tEmail], attempt);
                return;
            }

            // Actualizar pasajero a PREASIGNADO
            await Position.updateOne(
                { email: pEmail },
                {
                    $set: {
                        estado: POSITION_STATES.PREASIGNADO,
                        requestId: reqId,
                        taxistaAsignado: tEmail,
                        updatedAt: new Date()
                    }
                },
                { session }
            );

            await session.commitTransaction();
            session.endSession();

        } catch (txError) {
            await session.abortTransaction();
            session.endSession();
            throw txError;
        }

        // 🎯 5. GEOCODIFICACIÓN (con caché para evitar llamadas repetidas)
        let direccion = pasajeroData.pickupAddress;

        if (!direccion || direccion.includes("Calculando")) {
            try {
                direccion = await getCachedGeocoding(pasajeroData.lat, pasajeroData.lng);

                await Position.updateOne(
                    { email: pEmail },
                    { $set: { pickupAddress: direccion } }
                );

                logMotor("geocoding", `Dirección generada: ${direccion} para ${pEmail}`, "INFO");
            } catch (geoError) {
                logMotor("geocoding", `Error en geocoding para ${pEmail}: ${geoError}`, "ERROR");
                direccion = "Ubicación no disponible";
            }
        }

        // 🎯 6. CONSTRUIR PAYLOAD COMPLETO
        const fullPayload = {
            ...pasajeroData,
            email: pEmail,
            pasajeroEmail: pEmail,
            taxistaEmail: tEmail,
            pasajeroLat: pasajeroData.lat,
            pasajeroLng: pasajeroData.lng,
            taxistaLat: elMasCercano.lat,
            taxistaLng: elMasCercano.lng,
            pickupAddress: direccion,
            excludedEmails: currentExcluidos,
            isNewOffer: true,
            attempt,
            distancia,
            timeoutMs: calculateDynamicTimeout(distancia) // 🆕 Timeout dinámico
        };

        // 🎯 7. EMITIR EVENTOS (verificando sockets por sala/email)
        // Nota: io.sockets.sockets se indexa por socketId, no por email.
        const taxiSockets = await io.in(tEmail).fetchSockets();

        const shouldSendPush = taxiSockets.length === 0;

        if (!shouldSendPush) {
            io.to(tEmail).emit("pasajero_asignado", fullPayload);
            logMotor("dispatch_retry", `Emitido pasajero_asignado a ${tEmail} (${taxiSockets.length} socket/s en sala)`, "INFO");
        } else {
            logMotor(
                "dispatch_retry",
                `Pasajero=${pEmail} Taxista=${tEmail} -> Socket no conectado, enviando push`,
                "WARN"
            );
        }

        // Enviar push también con app abierta para reforzar entrega en segundo plano.
        if (elMasCercano.pushSubscription) {
            try {
                await enviarNotificacionPush(elMasCercano.pushSubscription, fullPayload, tEmail);
            } catch (pushError) {
                logMotor(
                    "dispatch_push",
                    `Error enviando push a ${tEmail}: ${pushError}`,
                    "ERROR"
                );
            }
        }

        // 🆕 Actualizar panel de admin con pre-asignación
        io.emit("panel_update", {
            email: tEmail,
            estado: POSITION_STATES.ASIGNADO,
            pasajeroAsignado: pEmail,
            distancia
        });

        io.emit("panel_update", {
            email: pEmail,
            estado: POSITION_STATES.PREASIGNADO,
            taxistaAsignado: tEmail
        });

        // 🎯 8. PROGRAMAR TIMEOUT DINÁMICO
        // 🆕 Limpiar timeout anterior si existe
        clearPendingTimeout(pEmail, "nuevo intento de despacho");

        const timeoutMs = calculateDynamicTimeout(distancia);

        const timeout = setTimeout(async () => {
            try {
                const tCheck = await Position.findOne({ email: tEmail }).lean();
                const pRefresh = await Position.findOne({ email: pEmail }).lean();

                // 🛡️ Candado: Ignorar timeout solo si el viaje ya avanzó realmente.
                // PREASIGNADO debe seguir permitiendo fallback a otra unidad.
                if (
                    pRefresh &&
                    [
                        POSITION_STATES.ASIGNADO,
                        POSITION_STATES.ENCAMINO,
                        POSITION_STATES.ENCURSO,
                    ].includes(pRefresh.estado as any)
                ) {
                    logMotor(
                        "dispatch_timeout",
                        `Pasajero=${pEmail} Estado=${pRefresh.estado} -> Timeout ignorado, viaje activo`,
                        "INFO"
                    );
                    clearPendingTimeout(pEmail, "viaje activo");
                    return;
                }

                // 🛡️ Candado: Si el requestId cambió, este timeout es obsoleto
                if (pRefresh && pRefresh.requestId !== reqId) {
                    logMotor(
                        "dispatch_timeout",
                        `Pasajero=${pEmail} RequestIdActual=${pRefresh.requestId} RequestIdEsperado=${reqId} -> Timeout obsoleto`,
                        "WARN"
                    );
                    clearPendingTimeout(pEmail, "requestId obsoleto");
                    return;
                }

                // 🛡️ Candado: Si el taxista ya no está asignado, ignorar
                if (!tCheck || tCheck.estado !== POSITION_STATES.ASIGNADO) {
                    logMotor(
                        "dispatch_timeout",
                        `Taxista=${tEmail} Estado=${tCheck?.estado} -> Ya no está asignado`,
                        "INFO"
                    );
                    clearPendingTimeout(pEmail, "taxista ya no asignado");
                    return;
                }

                // 👉 Si todo coincide, relanzar cascada
                logMotor(
                    "dispatch_timeout",
                    `Pasajero=${pEmail} Taxista=${tEmail} Intento=${attempt} -> Taxista no respondió, relanzando cascada`,
                    "INFO"
                );

                io.to(tEmail).emit("dispatch_timeout");

                await Position.updateOne(
                    { email: tEmail },
                    {
                        $set: {
                            estado: POSITION_STATES.ACTIVO,
                            pasajeroAsignado: null,
                            updatedAt: new Date()
                        }
                    }
                );

                io.emit("panel_update", {
                    email: tEmail,
                    estado: POSITION_STATES.ACTIVO
                });

                // Limpiar timeout antes de reintentar
                clearPendingTimeout(pEmail, "relanzando cascada");

                logMotor(
                    "dispatch_timeout",
                    `Fallback activado -> Pasajero=${pEmail} excluyendo=${tEmail} próximoIntento=${attempt + 1}`,
                    "INFO"
                );

                // Reintentar con el siguiente taxista
                dispatchWithRetry(io, pasajeroData, [...currentExcluidos, tEmail], attempt + 1);

            } catch (timeoutError) {
                logMotor(
                    "dispatch_timeout",
                    `Error en timeout para Pasajero=${pEmail} Taxista=${tEmail}: ${timeoutError}`,
                    "ERROR"
                );
            }
        }, timeoutMs);

        pendingTimeouts.set(pEmail, timeout);

        logMotor(
            "dispatch_retry",
            `Pasajero=${pEmail} Intento=${attempt} -> Taxista=${tEmail} asignado. Timeout programado: ${timeoutMs}ms`,
            "INFO"
        );

    } catch (error) {
        logMotor(
            "dispatch_retry",
            `Error crítico en dispatch para Pasajero=${pEmail} Intento=${attempt}: ${error}`,
            "ERROR"
        );

        // 🆕 Notificar al pasajero del error
        io.to(pEmail).emit("dispatch_error", {
            message: "Error al buscar taxi. Reintentando..."
        });

        // Reintentar después de 2 segundos
        setTimeout(() => {
            dispatchWithRetry(io, pasajeroData, currentExcluidos, attempt);
        }, 2000);
    }
};

// 🆕 Función para limpiar todos los timeouts (útil en shutdown)
export const clearAllTimeouts = () => {
    pendingTimeouts.forEach((timeout, key) => {
        clearTimeout(timeout);
        logMotor("dispatch_cleanup", `Timeout limpiado para ${key}`, "INFO");
    });
    pendingTimeouts.clear();
};

// 🆕 Función para obtener estadísticas de despacho
export const getDispatchStats = () => {
    return {
        pendingTimeouts: pendingTimeouts.size,
        isAutoMode,
        maxRetries: MAX_RETRIES,
        maxDistance: MAX_DISPATCH_DISTANCE_KM
    };
};