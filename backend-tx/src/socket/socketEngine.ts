// src/socket/socketEngine.ts
import { Server, Socket } from "socket.io";
import jwt from "jsonwebtoken";
import { Position } from "../models/Position";
import { User } from "../models/User";
import { buildPayload } from "../utils/payloadBuilder";
import { clearPendingTimeouts, isAutoMode, setAutoMode } from "../services/dispatchService";
import { registerLocationHandlers } from "./handlers/locationHandler";
import { registerTripHandlers } from "./handlers/tripHandler";
import { logMotor } from "../utils/logger";
import { calculateDistance } from "../utils/distance";
import { POSITION_STATES, STATE_GROUPS, PositionState } from "../constants/states";
import {
    joinTripRoom,
    leaveTripRoom,
    notifyPeerReconnection,
    getTripRoomId
} from "../services/tripRoomService";

// 🆕 Configuración configurable
const MICRODROP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos para microcortes
const REHYDRATION_DELAY_MS = 300; // Delay para rehidratación
const MAX_CONNECTIONS_PER_EMAIL = 3; // Rate limiting
const TRANSIENT_DISCONNECT_REASONS = new Set(["transport close", "transport error", "server namespace disconnect", "client namespace disconnect"]);
const PRESERVED_ON_DISCONNECT_STATES = new Set<string>([
    POSITION_STATES.ACTIVO,
    POSITION_STATES.OCUPADO,
    POSITION_STATES.INACTIVO,
    POSITION_STATES.PENDIENTE,
    POSITION_STATES.BUSCANDO,
    POSITION_STATES.PREASIGNADO,
    POSITION_STATES.ASIGNADO,
    POSITION_STATES.ENCAMINO,
    POSITION_STATES.ENCURSO
]);

const shouldPreserveStateOnDisconnect = (state: string | undefined, reason: string) => {
    const normalizedReason = reason?.toLowerCase() || "";
    if (TRANSIENT_DISCONNECT_REASONS.has(normalizedReason)) {
        return true;
    }
    return Boolean(state && PRESERVED_ON_DISCONNECT_STATES.has(state));
};

const ACTIVE_TRIP_STATES = new Set<string>([
    POSITION_STATES.PREASIGNADO,
    POSITION_STATES.ASIGNADO,
    POSITION_STATES.ENCAMINO,
    POSITION_STATES.ENCURSO
]);

const repairTripRelationForConnection = async (email: string, role: string) => {
    const normalizedEmail = email?.toLowerCase().trim();
    if (!normalizedEmail) return;

    const accountDoc = await Position.findOne({ email: normalizedEmail, role }).lean();
    if (!accountDoc) return;

    if (role === "pasajero") {
        const passengerDoc = await Position.findOne({ email: normalizedEmail, role: "pasajero" }).lean();
        const assignedTaxi = passengerDoc?.taxistaAsignado?.toLowerCase().trim();

        if (!assignedTaxi) return;

        // 🛡️ Solo limpiamos si el viaje ya fue CANCELADO o FINALIZADO oficialmente.
        if (passengerDoc && [POSITION_STATES.CANCELADO, POSITION_STATES.FINALIZADO].includes(passengerDoc.estado as any)) {
            logMotor("socket_repair", `Pasajero ${normalizedEmail} en estado final (${passengerDoc.estado}). Limpiando relación.`, "INFO");
            await Position.updateOne(
                { email: normalizedEmail, role: "pasajero" },
                { $set: { taxistaAsignado: null, updatedAt: new Date() } }
            );
            await Position.updateOne(
                { email: assignedTaxi, role: "taxista" },
                { $set: { pasajeroAsignado: null, estado: POSITION_STATES.ACTIVO, updatedAt: new Date() } }
            );
            return;
        }

        // Si no está cancelado/finalizado, preservamos la relación. No intervenimos.
        return;
    }

    if (role === "taxista") {
        const taxiDoc = await Position.findOne({ email: normalizedEmail, role: "taxista" }).lean();
        const assignedPassenger = taxiDoc?.pasajeroAsignado?.toLowerCase().trim();

        // 🛡️ BLINDAJE TOTAL: Si el taxista tiene un pasajero asignado, NO HACEMOS NADA.
        // Dejamos que el flujo normal del viaje o la cancelación explícita del pasajero manejen la limpieza.
        // Esto evita que una reconexión rápida "rompa" un viaje que está en progreso o recién asignado.
        if (assignedPassenger) {
            logMotor("socket_repair", `Taxista ${normalizedEmail} tiene pasajero asignado (${assignedPassenger}). Preservando relación sin verificar.`, "INFO");
            return;
        }
    }
};

// 🆕 Mapa de conexiones activas por email (para rate limiting)
const activeConnections = new Map<string, Set<string>>();

// 🆕 Identificador de dispositivo/pestaña por email, para distinguir una reconexión propia de una sesión nueva
const deviceIdByEmail = new Map<string, string>();

// 🆕 Mapa de timers de microcortes
const microdropTimers = new Map<string, NodeJS.Timeout>();

// 🆕 Mapa de timers de rehidratación por email
const rehydrationTimers = new Map<string, NodeJS.Timeout>();

export const initSocketEngine = (io: Server) => {
    io.on("connection", async (socket: Socket) => {
        const rawEmail = socket.handshake.auth?.email || socket.handshake.query?.email;
        const email = rawEmail ? rawEmail.toString().toLowerCase().trim() : null;
        const role = socket.handshake.auth?.role || socket.handshake.query?.role;
        const token = socket.handshake.auth?.token;
        const deviceId = socket.handshake.auth?.deviceId || socket.handshake.query?.deviceId;

        logMotor("socket_connect", `Intento: Email[${email}] Role[${role}] SocketID[${socket.id}] TokenPresent=${Boolean(token)}`, "INFO");

        // ============================================================
        // 🛡️ 1. VALIDACIÓN DE CREDENCIALES
        // ============================================================
        if (!email || email === "null" || email === "undefined" || !role) {
            logMotor("socket_connect", `Rechazado: credenciales inválidas`, "WARN");
            socket.emit("auth_error", { message: "Credenciales inválidas" });
            socket.disconnect(true);
            return;
        }

        // ============================================================
        // 🛡️ 1b. VALIDACIÓN DEL TOKEN JWT
        // ============================================================
        if (!token) {
            logMotor("socket_connect", `Rechazado: token ausente para ${email}`, "WARN");
            socket.emit("auth_error", { message: "Token no proporcionado" });
            socket.disconnect(true);
            return;
        }

        if (!process.env.JWT_SECRET) {
            logMotor("socket_connect", "Rechazado: JWT_SECRET no configurado", "ERROR");
            socket.emit("auth_error", { message: "Error de configuración del servidor" });
            socket.disconnect(true);
            return;
        }

        let decoded: { email?: string; role?: string } | null = null;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET) as { email?: string; role?: string };
            logMotor("socket_connect", `JWT válido para ${email}: decodedEmail=${decoded.email} decodedRole=${decoded.role}`, "INFO");
        } catch (tokenError) {
            logMotor("socket_connect", `Rechazado: token inválido/expirado para ${email}: ${tokenError}`, "WARN");
            socket.emit("auth_error", { message: "Token inválido o expirado" });
            socket.disconnect(true);
            return;
        }

        const decodedEmail = decoded?.email?.toLowerCase().trim();

        if (decodedEmail !== email || decoded?.role !== role) {
            logMotor("socket_connect", `Rechazado: token no coincide (${email} vs ${decodedEmail}, ${role} vs ${decoded?.role})`, "WARN");
            socket.emit("auth_error", { message: "Token no coincide con las credenciales" });
            socket.disconnect(true);
            return;
        }

        const userConnections = activeConnections.get(email) || new Set();
        if (userConnections.size >= MAX_CONNECTIONS_PER_EMAIL) {
            logMotor("socket_connect", `Rechazado: límite de conexiones para ${email} (${userConnections.size})`, "WARN");
            socket.emit("auth_error", { message: "Demasiadas conexiones activas" });
            socket.disconnect(true);
            return;
        }

        try {
            const userMaster = await User.findOne({ email }).lean();
            if (!userMaster) {
                logMotor("socket_connect", `Rechazado: usuario ${email} no encontrado en BD`, "WARN");
                socket.emit("auth_error", { message: "Usuario no encontrado" });
                socket.disconnect(true);
                return;
            }

            if (userMaster.role !== role) {
                logMotor("socket_connect", `Rechazado: role mismatch ${email} esperado=${userMaster.role} recibido=${role}`, "WARN");
                socket.emit("auth_error", { message: "Role no coincide" });
                socket.disconnect(true);
                return;
            }
            logMotor("socket_connect", `Usuario ${email} validado en BD con rol ${userMaster.role}`, "INFO");
        } catch (authError) {
            logMotor("socket_connect", `Error validando usuario ${email}: ${authError}`, "ERROR");
            socket.disconnect(true);
            return;
        }

        // ============================================================
        // 🎯 2. UNIR A SALA Y REGISTRAR CONEXIÓN
        // ============================================================
        socket.join(email);
        userConnections.add(socket.id);
        activeConnections.set(email, userConnections);

        const previousDoc = await Position.findOne({ email, role }).lean();
        if (previousDoc?.socketId && previousDoc.socketId !== socket.id) {
            const previousSocket = io.sockets.sockets.get(previousDoc.socketId);
            if (previousSocket) {
                // Si el deviceId coincide con el de la conexión anterior, es la misma pestaña
                // reconectando por una red inestable, no una sesión nueva: no alarmamos al usuario.
                const isSameDevice = Boolean(deviceId) && deviceIdByEmail.get(email) === deviceId;

                if (!isSameDevice) {
                    previousSocket.emit("session_replaced", {
                        message: "Se abrió otra sesión para esta cuenta. Esta sesión fue cerrada para evitar desincronización."
                    });
                }

                previousSocket.disconnect(true);

                const previousConnections = activeConnections.get(email);
                if (previousConnections) {
                    previousConnections.delete(previousSocket.id);
                    if (previousConnections.size === 0) {
                        activeConnections.delete(email);
                    }
                }

                logMotor("socket_connect", `Se cerró la sesión anterior ${previousDoc.socketId} para ${email} y se mantuvo la nueva conexión`, "WARN");
            }
        }

        if (deviceId) {
            deviceIdByEmail.set(email, deviceId);
        }

        // ============================================================
        // 🎯 3. ACTUALIZAR POSICIÓN EN BD CON DATOS DEL USUARIO
        // ============================================================
        try {
            const userMaster = await User.findOne({ email }).lean();
            if (userMaster) {
                await Position.findOneAndUpdate(
                    { email },
                    {
                        $set: {
                            pushSubscription: userMaster.pushSubscription,
                            name: userMaster.name,
                            taxiNumber: userMaster.taxiNumber,
                            role: userMaster.role,
                            socketId: socket.id,
                            updatedAt: new Date()
                        }
                    },
                    { upsert: true }
                );
            }

            // ============================================================
            // 🎯 4. CALCULAR ESTADO INICIAL CORRECTO
            // ============================================================
            await repairTripRelationForConnection(email, role);
            logMotor("socket_connect", `Reparación de relaciones completada para ${email} (${role})`, "INFO");

            const activeStates = {
                $in: [
                    POSITION_STATES.ASIGNADO,
                    POSITION_STATES.ENCURSO,
                    POSITION_STATES.ENCAMINO,
                    POSITION_STATES.PREASIGNADO,
                    POSITION_STATES.BUSCANDO
                ]
            };

            const miPosicion = await Position.findOne({ email, role }).lean();
            logMotor("socket_connect", `miPosicion para ${email}: estado=${miPosicion?.estado} socketId=${miPosicion?.socketId}`, "INFO");

            const viajeActivo = role === "taxista"
                ? await Position.findOne({
                    role: "pasajero",
                    taxistaAsignado: email,
                    estado: activeStates
                }).lean()
                : await Position.findOne({
                    email,
                    role: "pasajero",
                    estado: activeStates
                }).lean();

            logMotor("socket_connect", `viajeActivo para ${email} (${role}): ${viajeActivo ? `estado=${viajeActivo.estado} taxistaAsignado=${viajeActivo.taxistaAsignado}` : "null"}`, "INFO");

            const esEstadoValido = (estado: any): estado is PositionState => {
                return Object.values(POSITION_STATES).includes(estado);
            };

            let nuevoEstado: PositionState;

            if (viajeActivo) {
                if (role === "pasajero") {
                    const estadoPersistido = viajeActivo.estado;
                    nuevoEstado = esEstadoValido(estadoPersistido)
                        ? estadoPersistido
                        : "pendiente" as PositionState;
                    logMotor("socket_connect", `Pasajero ${email} recuperado en estado: ${nuevoEstado}`, "INFO");
                } else if (role === "taxista") {
                    const estadoBaseTaxista = miPosicion?.estado;
                    const estadosDeViajeActivo: PositionState[] = [
                        POSITION_STATES.ENCURSO,
                        POSITION_STATES.ENCAMINO,
                        POSITION_STATES.ASIGNADO
                    ];
                    const estadosEnRuta: PositionState[] = [
                        POSITION_STATES.ENCURSO,
                        POSITION_STATES.ENCAMINO
                    ];

                    const esTaxistaEnViaje = esEstadoValido(estadoBaseTaxista) && estadosDeViajeActivo.includes(estadoBaseTaxista);

                    nuevoEstado = esTaxistaEnViaje
                        ? estadoBaseTaxista
                        : (esEstadoValido(viajeActivo.estado) && estadosEnRuta.includes(viajeActivo.estado)
                            ? viajeActivo.estado
                            : POSITION_STATES.ENCAMINO);

                    logMotor("socket_connect", `Taxista ${email} recuperado en estado: ${nuevoEstado}`, "INFO");
                } else {
                    nuevoEstado = POSITION_STATES.ACTIVO;
                }
            } else {
                // 🛡️ BLINDAJE CRÍTICO: Sin viaje activo en la consulta del pasajero, 
                // pero verificamos si el propio documento del usuario indica que está en viaje.
                if (role === "taxista") {
                    const estadosDeViaje: PositionState[] = [
                        POSITION_STATES.ASIGNADO,
                        POSITION_STATES.ENCAMINO,
                        POSITION_STATES.ENCURSO,
                        POSITION_STATES.OCUPADO
                    ];

                    if (esEstadoValido(miPosicion?.estado) && estadosDeViaje.includes(miPosicion.estado)) {
                        nuevoEstado = miPosicion.estado;
                        logMotor("socket_connect", `Taxista ${email} preservado en estado: ${nuevoEstado} (fallback de seguridad)`, "INFO");
                    } else {
                        nuevoEstado = POSITION_STATES.ACTIVO;
                    }
                } else {
                    nuevoEstado = "pendiente" as PositionState;
                }
            }

            const microdropTimer = microdropTimers.get(email);
            if (microdropTimer) {
                clearTimeout(microdropTimer);
                microdropTimers.delete(email);
                logMotor("socket_connect", `Timer de microcorte cancelado para ${email}`, "INFO");
            }

            const updatedPos = await Position.findOneAndUpdate(
                { email },
                {
                    $set: {
                        estado: nuevoEstado,
                        socketId: socket.id,
                        updatedAt: new Date()
                    }
                },
                { upsert: true, returnDocument: "after" }
            );

            // ============================================================
            // 🎯 UNIR A LA SALA DEL VIAJE Y REHIDRATAR SI ES NECESARIO
            // ============================================================
            try {
                if (role === "taxista") {
                    const taxiDoc = await Position.findOne({ email, role: "taxista" }).lean();

                    if (taxiDoc?.pasajeroAsignado) {
                        const pasajeroDoc = await Position.findOne({
                            email: taxiDoc.pasajeroAsignado,
                            role: "pasajero"
                        }).lean();

                        if (pasajeroDoc?.requestId) {
                            // 1. Unir a la sala y notificar al pasajero
                            joinTripRoom(socket, pasajeroDoc.requestId, email);
                            notifyPeerReconnection(io, pasajeroDoc.requestId, "taxista", email);

                            // 🚨 2. EL ESLABÓN PERDIDO: Enviar los datos al frontend del taxista para que dibuje la UI
                            const passengerPayload = buildPayload(pasajeroDoc, pasajeroDoc, taxiDoc.estado as PositionState);

                            socket.emit("assignment_confirmed", {
                                success: true,
                                pasajero: passengerPayload,
                                rehydrated: true // 🛡️ Esto le dice al frontend que confíe ciegamente en este estado
                            });

                            socket.emit("trip_status_update", {
                                estado: taxiDoc.estado,
                                pasajeroAsignado: passengerPayload,
                                rehydrated: true
                            });

                            logMotor("socket_rehydrate", `Datos de viaje enviados a taxista ${email} al reconectar`, "INFO");
                        }
                    }
                } else if (role === "pasajero" && viajeActivo?.requestId) {
                    joinTripRoom(socket, viajeActivo.requestId, email);
                    notifyPeerReconnection(io, viajeActivo.requestId, "pasajero", email);

                    // También rehidratamos al pasajero por si acaso
                    socket.emit("trip_status_update", {
                        estado: viajeActivo.estado,
                        taxistaAsignado: viajeActivo.taxistaAsignado,
                        rehydrated: true
                    });
                }
            } catch (tripRoomErr) {
                logMotor("trip_room", `Error al unir a sala de viaje: ${tripRoomErr}`, "WARN");
            }
            // ============================================================
            // 🎯 5. REGISTRAR HANDLERS ANTES DE REHIDRATACIÓN
            // ============================================================
            registerLocationHandlers(io, socket, email);
            registerTripHandlers(io, socket, email);

            // ============================================================
            // 🎯 6. EMITIR DATOS INICIALES (SANITIZADOS)
            // ============================================================
            if (role === "admin") {
                const allPositions = await Position.find({
                    lat: { $exists: true, $ne: null },
                    lng: { $exists: true, $ne: null }
                }).limit(500).lean();

                const sanitizedPositions = allPositions.map(p => ({
                    email: p.email,
                    name: p.name,
                    role: p.role,
                    lat: p.lat,
                    lng: p.lng,
                    estado: p.estado,
                    taxiNumber: p.taxiNumber,
                    socketId: p.socketId
                }));

                socket.emit("positions", sanitizedPositions);
            }

            socket.emit("dispatch_mode_changed", { auto: isAutoMode });
            socket.emit("initial_state", { estado: nuevoEstado, role });

            // ============================================================
            // 🎯 7. REHIDRATACIÓN CONSOLIDADA
            // ============================================================
            if (viajeActivo && role === "taxista") {
                const rehydrationTimer = setTimeout(() => {
                    rehydrationTimers.delete(email);
                    logMotor("socket_rehydrate", `Rehidratando taxista ${email} en viaje activo`, "INFO");
                    socket.emit("pasajero_asignado", {
                        ...buildPayload(viajeActivo, viajeActivo, nuevoEstado),
                        pasajeroEmail: viajeActivo.email,
                        pasajeroLat: viajeActivo.lat,
                        pasajeroLng: viajeActivo.lng,
                        isNewOffer: false,
                        rehydrated: true
                    });
                }, REHYDRATION_DELAY_MS);
                rehydrationTimers.set(email, rehydrationTimer);
            }

            if (viajeActivo && role === "pasajero" && viajeActivo.taxistaAsignado) {
                const rehydrationTimer = setTimeout(async () => {
                    rehydrationTimers.delete(email);
                    try {
                        const taxistaData = await Position.findOne({
                            email: viajeActivo.taxistaAsignado
                        }).lean();

                        logMotor("socket_rehydrate", `Rehidratando pasajero ${email} con taxista ${viajeActivo.taxistaAsignado}`, "INFO");

                        socket.emit("response_from_taxi", {
                            accepted: true,
                            tEmail: taxistaData?.email || viajeActivo.taxistaAsignado,
                            name: taxistaData?.name || "Taxista",
                            taxiNumber: taxistaData?.taxiNumber || "ECO",
                            lat: taxistaData?.lat || null,
                            lng: taxistaData?.lng || null,
                            estado: nuevoEstado,
                            rehydrated: true,
                            taxiData: taxistaData ? buildPayload(taxistaData, taxistaData, nuevoEstado) : null,
                            pasajeroEmail: viajeActivo.email,
                            pasajeroLat: viajeActivo.lat,
                            pasajeroLng: viajeActivo.lng,
                            distancia: (taxistaData?.lat && taxistaData?.lng && viajeActivo.lat && viajeActivo.lng)
                                ? calculateDistance(viajeActivo.lat, viajeActivo.lng, taxistaData.lat, taxistaData.lng)
                                : null
                        });

                        socket.emit("trip_status_update", {
                            estado: nuevoEstado,
                            pasajeroEmail: email,
                            rehydrated: true
                        });
                    } catch (rehydrateError) {
                        logMotor("socket_rehydrate", `Error en rehidratación para ${email}: ${rehydrateError}`, "ERROR");
                    }
                }, REHYDRATION_DELAY_MS);
            }

            if (updatedPos) {
                io.emit("panel_update", buildPayload(updatedPos, updatedPos, nuevoEstado));
            }

        } catch (error) {
            logMotor("socket_connect", `Error en conexión para ${email}: ${error}`, "ERROR");
            socket.emit("connection_error", { message: "Error al inicializar conexión" });
        }

        // ============================================================
        // 🎯 8. LISTENERS ADICIONALES
        // ============================================================
        socket.on("join_room", (roomEmail: string) => {
            if (roomEmail) socket.join(roomEmail.toLowerCase().trim());
        });

        socket.on("request_dispatch_mode", async () => {
            try {
                const adminUser = await User.findOne({ email }).lean();
                if (!adminUser || adminUser.role !== "admin") {
                    socket.emit("auth_error", { message: "No autorizado" });
                    return;
                }
                socket.emit("dispatch_mode_changed", { auto: isAutoMode });
            } catch (error) {
                logMotor("socket_admin", `Error en request_dispatch_mode para ${email}: ${error}`, "ERROR");
            }
        });

        socket.on("toggle_dispatch_mode", async ({ auto }) => {
            try {
                const adminUser = await User.findOne({ email }).lean();
                if (!adminUser || adminUser.role !== "admin") {
                    socket.emit("auth_error", { message: "No autorizado" });
                    return;
                }
                const nextMode = Boolean(auto);
                setAutoMode(nextMode);
                io.emit("dispatch_mode_changed", { auto: nextMode });
                logMotor("socket_admin", `Modo de despacho actualizado por ${email}: ${nextMode ? "AUTO" : "MANUAL"}`, "INFO");
            } catch (error) {
                logMotor("socket_admin", `Error en toggle_dispatch_mode para ${email}: ${error}`, "ERROR");
            }
        });

        socket.on("reproducir_estado_viaje", async () => {
            try {
                const miEstado = await Position.findOne({ email }).lean();
                if (!miEstado) {
                    socket.emit("trip_status_update", { estado: POSITION_STATES.PENDIENTE });
                    return;
                }

                if (role === "pasajero") {
                    if (miEstado.taxistaAsignado || [POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO, POSITION_STATES.ASIGNADO, POSITION_STATES.PREASIGNADO].includes(miEstado.estado as any)) {
                        const taxistaData = miEstado.taxistaAsignado ? await Position.findOne({ email: miEstado.taxistaAsignado }).lean() : null;
                        socket.emit("response_from_taxi", {
                            accepted: true,
                            tEmail: taxistaData?.email || miEstado.taxistaAsignado || "",
                            name: taxistaData?.name || "Conductor",
                            taxiNumber: taxistaData?.taxiNumber || "ECO",
                            lat: taxistaData?.lat || null,
                            lng: taxistaData?.lng || null,
                            estado: miEstado.estado,
                            rehydrated: true,
                            taxiData: taxistaData ? buildPayload(taxistaData, taxistaData, miEstado.estado as PositionState) : null
                        });
                    } else if (miEstado.estado === POSITION_STATES.BUSCANDO) {
                        socket.emit("trip_status_update", { estado: POSITION_STATES.BUSCANDO, rehydrated: true });
                    } else {
                        socket.emit("trip_status_update", { estado: POSITION_STATES.PENDIENTE, rehydrated: true });
                    }
                } else if (role === "taxista") {
                    const pasajeroData = await Position.findOne({
                        role: "pasajero",
                        taxistaAsignado: email,
                        estado: { $in: [POSITION_STATES.ASIGNADO, POSITION_STATES.PREASIGNADO, POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO] }
                    }).lean();

                    if (pasajeroData) {
                        const passengerPayload = buildPayload(pasajeroData, pasajeroData, pasajeroData.estado as PositionState);
                        socket.emit("pasajero_asignado", {
                            ...passengerPayload,
                            pasajeroEmail: pasajeroData.email,
                            pasajeroLat: pasajeroData.lat,
                            pasajeroLng: pasajeroData.lng,
                            isNewOffer: false,
                            rehydrated: true
                        });
                        socket.emit("trip_status_update", {
                            estado: pasajeroData.estado,
                            pasajeroEmail: pasajeroData.email,
                            pasajeroAsignado: passengerPayload,
                            rehydrated: true
                        });
                    } else {
                        socket.emit("trip_status_update", { estado: miEstado.estado || POSITION_STATES.ACTIVO, rehydrated: true });
                    }
                }
            } catch (err) {
                logMotor("socket_rehydrate", `Error en rehidratación explícita para ${email}: ${err}`, "ERROR");
            }
        });

        socket.on("request_rehydrate", async (payload?: { requestId?: string }) => {
            try {
                const requestId = payload?.requestId?.toString().trim();

                // Obtenemos el estado real del usuario que se está reconectando
                const miEstado = role === "taxista"
                    ? await Position.findOne({ email }).lean()
                    : (requestId
                        ? await Position.findOne({ email, requestId }).lean()
                        : await Position.findOne({ email }).lean());

                if (!miEstado) {
                    socket.emit("trip_status_update", { estado: POSITION_STATES.PENDIENTE });
                    return;
                }

                if (role === "pasajero") {
                    if (miEstado.taxistaAsignado || [POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO, POSITION_STATES.ASIGNADO, POSITION_STATES.PREASIGNADO].includes(miEstado.estado as any)) {
                        const taxistaData = miEstado.taxistaAsignado
                            ? await Position.findOne({ email: miEstado.taxistaAsignado }).lean()
                            : null;

                        socket.emit("response_from_taxi", {
                            accepted: true,
                            tEmail: taxistaData?.email || miEstado.taxistaAsignado || "",
                            name: taxistaData?.name || "Conductor",
                            taxiNumber: taxistaData?.taxiNumber || "ECO",
                            lat: taxistaData?.lat || null,
                            lng: taxistaData?.lng || null,
                            estado: miEstado.estado,
                            rehydrated: true,
                            taxiData: taxistaData ? buildPayload(taxistaData, taxistaData, miEstado.estado as PositionState) : null
                        });
                    } else if (miEstado.estado === POSITION_STATES.BUSCANDO) {
                        socket.emit("trip_status_update", { estado: POSITION_STATES.BUSCANDO, rehydrated: true });
                    } else {
                        socket.emit("trip_status_update", { estado: POSITION_STATES.PENDIENTE, rehydrated: true });
                    }
                } else if (role === "taxista") {
                    // 🚨 CLAVE: Confiamos ciegamente en el estado del propio documento del taxista
                    const estadoRealDelTaxista = (miEstado.estado as PositionState) || POSITION_STATES.ACTIVO;

                    // Buscamos al pasajero SOLO para obtener sus datos de la UI, no para decidir el estado
                    const pasajeroData = miEstado.pasajeroAsignado
                        ? await Position.findOne({ email: miEstado.pasajeroAsignado, role: "pasajero" }).lean()
                        : await Position.findOne({ role: "pasajero", taxistaAsignado: email }).lean();

                    if (pasajeroData) {
                        const passengerPayload = buildPayload(pasajeroData, pasajeroData, estadoRealDelTaxista);

                        socket.emit("assignment_confirmed", {
                            success: true,
                            pasajero: passengerPayload,
                            rehydrated: true
                        });

                        socket.emit("trip_status_update", {
                            estado: estadoRealDelTaxista, // 🚨 Aquí enviamos el estado correcto del taxista
                            pasajeroAsignado: passengerPayload,
                            rehydrated: true
                        });
                    } else {
                        socket.emit("trip_status_update", {
                            estado: estadoRealDelTaxista,
                            rehydrated: true
                        });
                    }
                }
            } catch (err) {
                logMotor("socket_rehydrate", `Error en rehidratación manual para ${email}: ${err}`, "ERROR");
            }
        });

        socket.on("force_disconnect", async ({ email: targetEmail, adminEmail }) => {
            try {
                const adminUser = await User.findOne({ email: adminEmail?.toLowerCase().trim() });
                if (!adminUser || adminUser.role !== "admin") {
                    logMotor("socket_security", `Intento no autorizado de force_disconnect por ${email}`, "WARN");
                    socket.emit("auth_error", { message: "No autorizado" });
                    return;
                }

                if (targetEmail) {
                    const cleanEmail = targetEmail.toLowerCase().trim();
                    clearPendingTimeouts(cleanEmail, "force_disconnect");

                    await Position.updateOne({ email: cleanEmail }, { $set: { estado: "desconectado", socketId: null, updatedAt: new Date() } });

                    const targetSockets = await io.in(cleanEmail).fetchSockets();
                    for (const targetSocket of targetSockets) {
                        targetSocket.emit("force_disconnected", { message: "Desconectado por administrador", adminEmail });
                        targetSocket.disconnect(true);
                    }

                    io.emit("panel_update", { email: cleanEmail, estado: "desconectado", force: true });
                    logMotor("socket_admin", `Admin ${adminEmail} desconectó a ${cleanEmail}`, "INFO");
                }
            } catch (error) {
                logMotor("socket_admin", `Error en force_disconnect: ${error}`, "ERROR");
            }
        });

        // ============================================================
        // 🎯 9. DISCONNECT HANDLER CENTRALIZADO
        // ============================================================
        socket.on("disconnect", async (reason) => {
            if (!email) return;

            const rehydrationTimer = rehydrationTimers.get(email);
            if (rehydrationTimer) {
                clearTimeout(rehydrationTimer);
                rehydrationTimers.delete(email);
            }

            // 🎯 NUEVO: Salir de la sala del viaje antes de cualquier otra limpieza
            leaveTripRoom(socket);

            logMotor("socket_disconnect", `Socket cerrado para ${email} | Razón: ${reason}`, "INFO");

            const userConnections = activeConnections.get(email);
            if (userConnections) {
                userConnections.delete(socket.id);
                if (userConnections.size === 0) activeConnections.delete(email);
            }

            try {
                const checkActive = await Position.findOne({ email, role }).lean();
                if (!checkActive) return;

                if (checkActive.socketId && checkActive.socketId !== socket.id) {
                    logMotor("socket_disconnect", `Ignorando disconnect obsoleto para ${email} | Socket=${socket.id} | Vigente=${checkActive.socketId}`, "INFO");
                    return;
                }

                if (shouldPreserveStateOnDisconnect(checkActive.estado, reason)) {
                    logMotor("socket_microdrop", `Conservando estado '${checkActive.estado}' para ${email} (${reason})`, "INFO");

                    await Position.updateOne({ email }, { $set: { socketId: null, updatedAt: new Date(), estado: checkActive.estado, lastSeenAt: new Date() } });

                    const timer = setTimeout(async () => {
                        try {
                            const stillDisconnected = await Position.findOne({ email }).lean();
                            if (stillDisconnected && !stillDisconnected.socketId) {
                                const activeSockets = await io.in(email).fetchSockets();
                                if (activeSockets.length === 0) {
                                    const isTaxista = stillDisconnected.role === "taxista";
                                    const hasActiveTripRelation = Boolean(stillDisconnected.pasajeroAsignado || stillDisconnected.taxistaAsignado);
                                    const fallbackState = isTaxista
                                        ? (hasActiveTripRelation ? stillDisconnected.estado : POSITION_STATES.ACTIVO)
                                        : (hasActiveTripRelation ? stillDisconnected.estado : POSITION_STATES.ACTIVO);

                                    logMotor("socket_microdrop", `Limpiando estado huérfano para ${email} -> ${fallbackState} después de ${MICRODROP_TIMEOUT_MS}ms`, "WARN");

                                    await Position.updateOne({ email }, { $set: { estado: fallbackState, socketId: null, updatedAt: new Date(), lastSeenAt: new Date() } });

                                    if (stillDisconnected.taxistaAsignado) {
                                        io.to(stillDisconnected.taxistaAsignado).emit("passenger_disconnected", { message: "El pasajero se ha desconectado permanentemente", pasajeroEmail: email });
                                    }
                                    if (stillDisconnected.pasajeroAsignado) {
                                        io.to(stillDisconnected.pasajeroAsignado).emit("taxi_disconnected", { message: "El taxista se ha desconectado permanentemente", taxistaEmail: email });
                                    }

                                    io.emit("panel_update", { email, estado: fallbackState, reason: "microdrop_timeout" });
                                }
                            }
                            microdropTimers.delete(email);
                        } catch (timerError) {
                            logMotor("socket_microdrop", `Error en timer de microcorte para ${email}: ${timerError}`, "ERROR");
                        }
                    }, MICRODROP_TIMEOUT_MS);

                    microdropTimers.set(email, timer);
                    return;
                }

                await Position.updateOne({ email }, { $set: { estado: "desconectado", socketId: null, updatedAt: new Date() } });
                io.emit("panel_update", { email, estado: "desconectado", force: false });
            } catch (error) {
                logMotor("socket_disconnect", `Error en desconexión para ${email}: ${error}`, "ERROR");
            }
        });
    });
};

export const cleanupSocketEngine = () => {
    logMotor("socket_cleanup", "Limpiando recursos del motor de sockets", "INFO");
    microdropTimers.forEach((timer) => clearTimeout(timer));
    microdropTimers.clear();
    rehydrationTimers.forEach((timer) => clearTimeout(timer));
    rehydrationTimers.clear();
    activeConnections.clear();
};

export const getSocketStats = () => {
    return {
        activeConnections: activeConnections.size,
        microdropTimers: microdropTimers.size,
        pendingTimeouts: 0,
        isAutoMode
    };
};