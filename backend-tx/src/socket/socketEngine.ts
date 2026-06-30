// src/socket/socketEngine.ts
import { Server, Socket } from "socket.io";
import { Position } from "../models/Position";
import { User } from "../models/User";
import { buildPayload } from "../utils/payloadBuilder";
import { pendingTimeouts, isAutoMode } from "../services/dispatchService";
import { registerLocationHandlers } from "./handlers/locationHandler";
import { registerTripHandlers } from "./handlers/tripHandler";
import { logMotor } from "../utils/logger";
import { calculateDistance } from "../utils/distance";
import { POSITION_STATES, STATE_GROUPS, PositionState, isValidPositionState } from "../constants/states";

// 🆕 Configuración configurable
const MICRODROP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos para microcortes
const REHYDRATION_DELAY_MS = 300; // Delay para rehidratación
const MAX_CONNECTIONS_PER_EMAIL = 3; // Rate limiting

// 🆕 Mapa de conexiones activas por email (para rate limiting)
const activeConnections = new Map<string, Set<string>>();

// 🆕 Mapa de timers de microcortes
const microdropTimers = new Map<string, NodeJS.Timeout>();

export const initSocketEngine = (io: Server) => {
    io.on("connection", async (socket: Socket) => {
        const rawEmail = socket.handshake.auth?.email || socket.handshake.query?.email;
        const email = rawEmail ? rawEmail.toString().toLowerCase().trim() : null;
        const role = socket.handshake.auth?.role || socket.handshake.query?.role;
        const token = socket.handshake.auth?.token; // 🆕 Token de autenticación

        logMotor("socket_connect", `Intento de conexión: Email[${email}] | Role[${role}] | SocketID[${socket.id}]`, "INFO");

        // ============================================================
        // 🛡️ 1. VALIDACIÓN DE CREDENCIALES
        // ============================================================
        if (!email || email === "null" || email === "undefined" || !role) {
            logMotor("socket_connect", `Conexión rechazada: credenciales inválidas`, "WARN");
            socket.emit("auth_error", { message: "Credenciales inválidas" });
            socket.disconnect(true);
            return;
        }

        // 🆕 Rate limiting: verificar número de conexiones activas
        const userConnections = activeConnections.get(email) || new Set();
        if (userConnections.size >= MAX_CONNECTIONS_PER_EMAIL) {
            logMotor("socket_connect", `Conexión rechazada: límite de conexiones para ${email}`, "WARN");
            socket.emit("auth_error", { message: "Demasiadas conexiones activas" });
            socket.disconnect(true);
            return;
        }

        // 🆕 Validación de autenticación (opcional pero recomendado)
        try {
            const userMaster = await User.findOne({ email });

            if (!userMaster) {
                logMotor("socket_connect", `Conexión rechazada: usuario ${email} no encontrado`, "WARN");
                socket.emit("auth_error", { message: "Usuario no encontrado" });
                socket.disconnect(true);
                return;
            }

            // 🆕 Validación de token (si tu sistema lo usa)
            // if (token && userMaster.token !== token) {
            //     logMotor("socket_connect", `Token inválido para ${email}`, "WARN");
            //     socket.disconnect(true);
            //     return;
            // }

            // 🆕 Verificar que el rol coincida
            if (userMaster.role !== role) {
                logMotor("socket_connect", `Role mismatch para ${email}: esperado=${userMaster.role}, recibido=${role}`, "WARN");
                socket.emit("auth_error", { message: "Role no coincide" });
                socket.disconnect(true);
                return;
            }

        } catch (authError) {
            logMotor("socket_connect", `Error en autenticación para ${email}: ${authError}`, "ERROR");
            socket.disconnect(true);
            return;
        }

        // ============================================================
        // 🎯 2. UNIR A SALA Y REGISTRAR CONEXIÓN
        // ============================================================
        socket.join(email);
        userConnections.add(socket.id);
        activeConnections.set(email, userConnections);

        // 🆕 Notificar al socket anterior que fue reemplazado
        const previousDoc = await Position.findOne({ email }).lean();
        if (previousDoc?.socketId && previousDoc.socketId !== socket.id) {
            const previousSocket = io.sockets.sockets.get(previousDoc.socketId);
            if (previousSocket) {
                previousSocket.emit("session_replaced", {
                    message: "Tu sesión fue iniciada en otro dispositivo"
                });
                previousSocket.disconnect(true);
                logMotor("socket_connect", `Socket anterior ${previousDoc.socketId} desconectado para ${email}`, "INFO");
            }
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

            // 🆕 Buscar viaje activo filtrando por rol y relación real
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

            // Para taxista, SIEMPRE rehidratar con el documento del pasajero asignado.
            // Para pasajero, usar su propio documento.
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

            // 🆕 Estado por defecto CORRECTO
            let nuevoEstado: PositionState;

            if (viajeActivo) {
                // Si hay viaje activo, preservar estado
                if (role === "pasajero") {
                    const estadoPersistido = viajeActivo.estado;
                    nuevoEstado = isValidPositionState(estadoPersistido)
                        ? (estadoPersistido as PositionState)
                        : POSITION_STATES.PENDIENTE;
                    logMotor("socket_connect", `Pasajero ${email} recuperado en estado: ${nuevoEstado}`, "INFO");
                } else if (role === "taxista") {
                    const estadoBaseTaxista = miPosicion?.estado;
                    const estadoTaxistaValido = [POSITION_STATES.ENCURSO, POSITION_STATES.ENCAMINO, POSITION_STATES.ASIGNADO].includes(estadoBaseTaxista as any);
                    nuevoEstado = estadoTaxistaValido
                        ? estadoBaseTaxista as PositionState
                        : ([POSITION_STATES.ENCURSO, POSITION_STATES.ENCAMINO].includes(viajeActivo.estado as any)
                            ? viajeActivo.estado as PositionState
                            : POSITION_STATES.ENCAMINO);
                    logMotor("socket_connect", `Taxista ${email} recuperado en estado: ${nuevoEstado}`, "INFO");
                } else {
                    nuevoEstado = POSITION_STATES.ACTIVO;
                }
            } else {
                // 🆕 Sin viaje activo: estado correcto por rol
                nuevoEstado = role === "taxista"
                    ? POSITION_STATES.ACTIVO
                    : POSITION_STATES.PENDIENTE; // ← CORREGIDO: era BUSCANDO
            }

            // Cancelar timer de microcorte si existe
            const microdropTimer = microdropTimers.get(email);
            if (microdropTimer) {
                clearTimeout(microdropTimer);
                microdropTimers.delete(email);
                logMotor("socket_connect", `Timer de microcorte cancelado para ${email}`, "INFO");
            }

            // Actualizar estado en BD
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
            // 🎯 5. REGISTRAR HANDLERS ANTES DE REHIDRATACIÓN
            // ============================================================
            // 🆕 CRÍTICO: Registrar handlers ANTES de emitir eventos
            registerLocationHandlers(io, socket, email);
            registerTripHandlers(io, socket, email);

            // ============================================================
            // 🎯 6. EMITIR DATOS INICIALES (SANITIZADOS)
            // ============================================================

            // 🆕 Solo enviar posiciones a admin o panel de control
            if (role === "admin") {
                const allPositions = await Position.find({
                    lat: { $exists: true, $ne: null },
                    lng: { $exists: true, $ne: null }
                }).lean();

                // 🆕 Sanitizar datos sensibles
                const sanitizedPositions = allPositions.map(p => ({
                    email: p.email,
                    name: p.name,
                    role: p.role,
                    lat: p.lat,
                    lng: p.lng,
                    estado: p.estado,
                    taxiNumber: p.taxiNumber,
                    socketId: p.socketId
                    // 🚫 NO incluir: pushSubscription, taxistaAsignado, etc.
                }));

                socket.emit("positions", sanitizedPositions);
            }

            socket.emit("dispatch_mode_changed", { auto: isAutoMode });
            socket.emit("initial_state", { estado: nuevoEstado, role });

            // ============================================================
            // 🎯 7. REHIDRATACIÓN CONSOLIDADA (UN SOLO MECANISMO)
            // ============================================================
            if (viajeActivo && role === "taxista") {
                setTimeout(() => {
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
            }

            if (viajeActivo && role === "pasajero" && viajeActivo.taxistaAsignado) {
                setTimeout(async () => {
                    try {
                        const taxistaData = await Position.findOne({
                            email: viajeActivo.taxistaAsignado
                        }).lean();

                        logMotor("socket_rehydrate", `Rehidratando pasajero ${email} con taxista ${viajeActivo.taxistaAsignado}`, "INFO");

                        // 🆕 Emitir AMBOS eventos que el frontend espera
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

                        // 🆕 También emitir trip_status_update para consistencia
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

            // Actualizar panel de admin
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
            if (roomEmail) {
                socket.join(roomEmail.toLowerCase().trim());
            }
        });

        // 🆕 Listener de rehidratación manual (solo si el frontend lo solicita)
        socket.on("request_rehydrate", async () => {
            try {
                const miEstado = await Position.findOne({ email }).lean();

                if (!miEstado) {
                    socket.emit("trip_status_update", { estado: POSITION_STATES.PENDIENTE });
                    return;
                }

                if (role === "pasajero") {
                    if (miEstado.taxistaAsignado ||
                        [POSITION_STATES.ENCAMINO, POSITION_STATES.ENCURSO, POSITION_STATES.ASIGNADO, POSITION_STATES.PREASIGNADO].includes(miEstado.estado as any)) {

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
                        socket.emit("trip_status_update", { estado: POSITION_STATES.BUSCANDO });
                    } else {
                        socket.emit("trip_status_update", { estado: POSITION_STATES.PENDIENTE });
                    }
                } else if (role === "taxista") {
                    if (miEstado.pasajeroAsignado) {
                        const pasajeroData = await Position.findOne({ email: miEstado.pasajeroAsignado }).lean();
                        if (pasajeroData) {
                            socket.emit("assignment_confirmed", {
                                success: true,
                                pasajero: buildPayload(pasajeroData, pasajeroData, pasajeroData.estado as PositionState),
                                rehydrated: true
                            });
                        }
                    }
                }
            } catch (err) {
                logMotor("socket_rehydrate", `Error en rehidratación manual para ${email}: ${err}`, "ERROR");
            }
        });

        // 🆕 force_disconnect SOLO para admin
        socket.on("force_disconnect", async ({ email: targetEmail, adminEmail }) => {
            try {
                // 🛡️ Validación: solo admin puede desconectar
                const adminUser = await User.findOne({ email: adminEmail?.toLowerCase().trim() });

                if (!adminUser || adminUser.role !== "admin") {
                    logMotor("socket_security", `Intento no autorizado de force_disconnect por ${email}`, "WARN");
                    socket.emit("auth_error", { message: "No autorizado" });
                    return;
                }

                if (targetEmail) {
                    const cleanEmail = targetEmail.toLowerCase().trim();

                    // Limpiar timeout si existe
                    if (pendingTimeouts.has(cleanEmail)) {
                        clearTimeout(pendingTimeouts.get(cleanEmail)!);
                        pendingTimeouts.delete(cleanEmail);
                    }

                    // Actualizar estado
                    await Position.updateOne(
                        { email: cleanEmail },
                        { $set: { estado: "desconectado", socketId: null, updatedAt: new Date() } }
                    );

                    // Desconectar socket
                    const targetSockets = await io.in(cleanEmail).fetchSockets();
                    for (const targetSocket of targetSockets) {
                        targetSocket.emit("force_disconnected", {
                            message: "Desconectado por administrador",
                            adminEmail
                        });
                        targetSocket.disconnect(true);
                    }

                    io.emit("panel_update", {
                        email: cleanEmail,
                        estado: "desconectado",
                        force: true
                    });

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

            logMotor("socket_disconnect", `Socket cerrado para ${email} | Razón: ${reason}`, "INFO");

            // Remover de conexiones activas
            const userConnections = activeConnections.get(email);
            if (userConnections) {
                userConnections.delete(socket.id);
                if (userConnections.size === 0) {
                    activeConnections.delete(email);
                }
            }

            try {
                const checkActive = await Position.findOne({ email }).lean();

                if (!checkActive) return;

                // 🆕 Protección contra microcortes con timer
                if (["encamino", "encurso", "asignado", "preasignado"].includes(checkActive.estado)) {
                    logMotor("socket_microdrop", `Conservando estado '${checkActive.estado}' para ${email} (microcorte)`, "INFO");

                    // Solo limpiar socketId, mantener estado
                    await Position.updateOne(
                        { email },
                        { $set: { socketId: null, updatedAt: new Date() } }
                    );

                    // 🆕 Programar limpieza después de MICRODROP_TIMEOUT_MS
                    const timer = setTimeout(async () => {
                        try {
                            const stillDisconnected = await Position.findOne({ email }).lean();

                            if (stillDisconnected && !stillDisconnected.socketId) {
                                // Verificar si hay socket activo
                                const activeSockets = await io.in(email).fetchSockets();

                                if (activeSockets.length === 0) {
                                    logMotor("socket_microdrop", `Limpiando estado huérfano para ${email} después de ${MICRODROP_TIMEOUT_MS}ms`, "WARN");

                                    await Position.updateOne(
                                        { email },
                                        {
                                            $set: {
                                                estado: POSITION_STATES.CANCELADO,
                                                taxistaAsignado: null,
                                                pasajeroAsignado: null,
                                                socketId: null,
                                                updatedAt: new Date()
                                            }
                                        }
                                    );

                                    // Notificar a la otra parte si existe
                                    if (stillDisconnected.taxistaAsignado) {
                                        io.to(stillDisconnected.taxistaAsignado).emit("passenger_disconnected", {
                                            message: "El pasajero se ha desconectado permanentemente",
                                            pasajeroEmail: email
                                        });
                                    }
                                    if (stillDisconnected.pasajeroAsignado) {
                                        io.to(stillDisconnected.pasajeroAsignado).emit("taxi_disconnected", {
                                            message: "El taxista se ha desconectado permanentemente",
                                            taxistaEmail: email
                                        });
                                    }

                                    io.emit("panel_update", {
                                        email,
                                        estado: POSITION_STATES.CANCELADO,
                                        reason: "microdrop_timeout"
                                    });
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

                // Para otros estados, marcar como desconectado
                await Position.updateOne(
                    { email },
                    {
                        $set: {
                            estado: "desconectado",
                            socketId: null,
                            updatedAt: new Date()
                        }
                    }
                );

                io.emit("panel_update", {
                    email,
                    estado: "desconectado",
                    force: false
                });

            } catch (error) {
                logMotor("socket_disconnect", `Error en desconexión para ${email}: ${error}`, "ERROR");
            }
        });
    });
};

// 🆕 Función para limpiar recursos al cerrar el servidor
export const cleanupSocketEngine = () => {
    logMotor("socket_cleanup", "Limpiando recursos del motor de sockets", "INFO");

    // Limpiar todos los timers de microcortes
    microdropTimers.forEach((timer) => clearTimeout(timer));
    microdropTimers.clear();

    // Limpiar mapa de conexiones
    activeConnections.clear();
};

// 🆕 Función para obtener estadísticas
export const getSocketStats = () => {
    return {
        activeConnections: activeConnections.size,
        microdropTimers: microdropTimers.size,
        pendingTimeouts: pendingTimeouts.size,
        isAutoMode
    };
};