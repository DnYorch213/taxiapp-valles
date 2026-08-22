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
import {
    POSITION_STATES,
    STATE_GROUPS,
    PositionState,
    isOccupied
} from "../constants/states";
import {
    joinTripRoom,
    leaveTripRoom,
    notifyPeerReconnection
} from "../services/tripRoomService";

// ============================================================
// 📦 1. ESTADO DEL MÓDULO & HELPER FUNCTIONS
// ============================================================
const MICRODROP_TIMEOUT_MS = 15000; // 15 segundos de tolerancia
const activeConnections = new Map<string, Set<string>>();
const microdropTimers = new Map<string, NodeJS.Timeout>();
const rehydrationTimers = new Map<string, NodeJS.Timeout>();
const handshakingUsers = new Set<string>();

/**
 * Determina si una desconexión transitoria debe preservar el estado operativo del usuario.
 */
const shouldPreserveStateOnDisconnect = (estado: string, reason: string): boolean => {
    const isTransientDisconnect = ["ping timeout", "transport close", "transport error"].includes(reason);
    const isOperationalState = isOccupied(estado as PositionState) ||
        STATE_GROUPS.AVAILABLE.includes(estado as any);

    return isTransientDisconnect && isOperationalState;
};

/**
 * Cancela y elimina todos los timers locales pendientes para un email dado.
 */
const clearLocalSocketTimeouts = (email: string) => {
    const microTimer = microdropTimers.get(email);
    if (microTimer) {
        clearTimeout(microTimer);
        microdropTimers.delete(email);
    }
    const rehydTimer = rehydrationTimers.get(email);
    if (rehydTimer) {
        clearTimeout(rehydTimer);
        rehydrationTimers.delete(email);
    }
};

/**
 * Helper para gestionar la reconexión y notificación dentro de la sala de viaje.
 */
const handleTripReconnection = async (socket: Socket, io: Server, currentPos: any, email: string) => {
    const requestId = currentPos.requestId || currentPos.activeRequestId;

    if (requestId) {
        // 1. Unir socket a la sala del viaje
        joinTripRoom(socket, requestId, email);

        // 2. Notificar al compañero de viaje
        const who: "pasajero" | "taxista" = currentPos.role === "taxista" ? "taxista" : "pasajero";
        notifyPeerReconnection(io, requestId, who, email);
    }
};

// ============================================================
// 🚀 2. INICIALIZADOR DEL MOTOR DE SOCKETS
// ============================================================
export const initSocketEngine = (io: Server) => {

    // 🛡️ Middleware global de autenticación de Socket.io
    io.use(async (socket, next) => {
        try {
            const token = socket.handshake.auth?.token || socket.handshake.headers?.authorization?.split(" ")[1];
            if (!token) return next(new Error("Authentication error: Token no provisto"));

            const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret") as { email: string; role: string };
            socket.data.email = decoded.email.toLowerCase().trim();
            socket.data.role = decoded.role;
            next();
        } catch (err) {
            logMotor("socket_auth", `Error de autenticación: ${err}`, "WARN");
            next(new Error("Authentication error: Token inválido"));
        }
    });

    // 🔌 Conexión principal de cliente
    io.on("connection", async (socket: Socket) => {
        const email = socket.data.email as string;
        const role = socket.data.role as string;

        if (!email) {
            socket.disconnect(true);
            return;
        }

        logMotor("socket_connect", `Cliente conectado | Email: ${email} | Socket: ${socket.id}`, "INFO");

        if (handshakingUsers.has(email)) {
            logMotor("socket_connect", `Handshake omitido (en proceso) para ${email}`, "WARN");
            return;
        }
        handshakingUsers.add(email);

        try {
            clearLocalSocketTimeouts(email);
            clearPendingTimeouts(email, "reconnect");

            if (!activeConnections.has(email)) activeConnections.set(email, new Set());
            activeConnections.get(email)!.add(socket.id);

            socket.join(email);

            let currentPos = await Position.findOne({ email }).lean();

            if (currentPos) {
                if (currentPos.pasajeroAsignado || currentPos.taxistaAsignado) {
                    await handleTripReconnection(socket, io, currentPos, email);
                }

                await Position.updateOne(
                    { email },
                    { $set: { socketId: socket.id, updatedAt: new Date(), lastSeenAt: new Date() } }
                );
            }

            registerLocationHandlers(io, socket, email);
            registerTripHandlers(io, socket, email);

        } catch (error) {
            logMotor("socket_connect", `Error en inicialización de cliente ${email}: ${error}`, "ERROR");
        } finally {
            handshakingUsers.delete(email);
        }

        // ============================================================
        // 🎯 3. SALAS Y CANALES
        // ============================================================

        socket.on("join_room", (roomEmail: string) => {
            if (!roomEmail) return;
            const cleanRoom = roomEmail.toLowerCase().trim();
            socket.join(cleanRoom);
            logMotor("socket_room", `Socket ${socket.id} (${email}) se unió a la sala: ${cleanRoom}`, "INFO");
        });

        // ============================================================
        // 🎯 4. EVENTOS DE CONTROL Y MODO AUTOMÁTICO
        // ============================================================

        socket.on("toggle_auto_mode", async ({ enabled }: { enabled: boolean }) => {
            try {
                const user = await User.findOne({ email }).lean();
                if (!user || user.role !== "admin") {
                    socket.emit("auth_error", { message: "No tienes permisos de administrador" });
                    return;
                }

                setAutoMode(enabled);
                io.emit("auto_mode_changed", { enabled, updatedBy: email });
                logMotor("socket_admin", `Modo automático cambiado a '${enabled}' por Admin ${email}`, "INFO");
            } catch (error) {
                logMotor("socket_admin", `Error en toggle_auto_mode: ${error}`, "ERROR");
            }
        });

        // ============================================================
        // 🎯 5. RECONEXIÓN EXPLICITA Y REHIDRATACIÓN
        // ============================================================

        socket.on("manual_reconnect", async () => {
            try {
                logMotor("socket_reconnect", `Solicitud de reconexión manual recibida de: ${email}`, "INFO");

                clearLocalSocketTimeouts(email);
                clearPendingTimeouts(email, "manual_reconnect");

                const currentPos = await Position.findOne({ email }).lean();
                if (!currentPos) {
                    socket.emit("reconnect_failed", { message: "Registro de posición no encontrado" });
                    return;
                }

                await Position.updateOne(
                    { email },
                    { $set: { socketId: socket.id, updatedAt: new Date(), lastSeenAt: new Date() } }
                );

                if (currentPos.pasajeroAsignado || currentPos.taxistaAsignado) {
                    await handleTripReconnection(socket, io, currentPos, email);
                }
                // Extraemos el ID activo soportando cualquier estructura de la posición
                const activeRequestId = (currentPos as any).solicitudActiva || currentPos.requestId || (currentPos as any).activeRequestId;

                const payload = buildPayload(
                    currentPos.estado,
                    currentPos,
                    currentPos.role,
                    activeRequestId
                );

                socket.emit("reconnect_success", payload);
                io.emit("panel_update", { email, estado: currentPos.estado, socketId: socket.id });

                logMotor("socket_reconnect", `Reconexión manual exitosa para ${email}`, "INFO");
            } catch (error) {
                logMotor("socket_reconnect", `Error en manual_reconnect para ${email}: ${error}`, "ERROR");
                socket.emit("reconnect_failed", { message: "Error interno en reconexión" });
            }
        });

        // ============================================================
        // 🎯 6. FORCE DISCONNECT HANDLER (ADMIN)
        // ============================================================

        socket.on("force_disconnect", async ({ email: targetEmail, adminEmail }) => {
            try {
                const cleanAdminEmail = (adminEmail || email)?.toLowerCase().trim();
                const adminUser = cleanAdminEmail
                    ? await User.findOne({ email: cleanAdminEmail }).lean()
                    : null;

                if (!adminUser || adminUser.role !== "admin") {
                    logMotor(
                        "socket_security",
                        `Intento no autorizado de force_disconnect por ${email || "Sesión Desconocida"}`,
                        "WARN"
                    );
                    socket.emit("auth_error", { message: "No autorizado" });
                    return;
                }

                if (targetEmail) {
                    const cleanTargetEmail = targetEmail.toLowerCase().trim();

                    clearLocalSocketTimeouts(cleanTargetEmail);
                    clearPendingTimeouts(cleanTargetEmail, "force_disconnect");

                    await Position.updateOne(
                        { email: cleanTargetEmail },
                        { $set: { estado: POSITION_STATES.DESCONECTADO, socketId: null, updatedAt: new Date() } }
                    );

                    const targetSockets = await io.in(cleanTargetEmail).fetchSockets();
                    for (const targetSocket of targetSockets) {
                        targetSocket.emit("force_disconnected", {
                            message: "Desconectado por administrador",
                            adminEmail: cleanAdminEmail
                        });
                        targetSocket.disconnect(true);
                    }

                    io.emit("panel_update", { email: cleanTargetEmail, estado: POSITION_STATES.DESCONECTADO, force: true });
                    logMotor("socket_admin", `Admin ${cleanAdminEmail} desconectó a ${cleanTargetEmail}`, "INFO");
                }
            } catch (error) {
                logMotor("socket_admin", `Error en force_disconnect: ${error}`, "ERROR");
            }
        });

        // ============================================================
        // 🎯 7. DISCONNECT HANDLER CENTRALIZADO
        // ============================================================

        socket.on("disconnect", async (reason) => {
            if (!email) return;

            const rehydrationTimer = rehydrationTimers.get(email);
            if (rehydrationTimer) {
                clearTimeout(rehydrationTimer);
                rehydrationTimers.delete(email);
            }

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
                    logMotor(
                        "socket_disconnect",
                        `Ignorando disconnect obsoleto para ${email} | Socket=${socket.id} | Vigente=${checkActive.socketId}`,
                        "INFO"
                    );
                    return;
                }

                if (shouldPreserveStateOnDisconnect(checkActive.estado, reason)) {
                    logMotor("socket_microdrop", `Conservando estado '${checkActive.estado}' para ${email} (${reason})`, "INFO");

                    const previousMicroTimer = microdropTimers.get(email);
                    if (previousMicroTimer) {
                        clearTimeout(previousMicroTimer);
                    }

                    await Position.updateOne(
                        { email },
                        { $set: { socketId: null, updatedAt: new Date(), estado: checkActive.estado, lastSeenAt: new Date() } }
                    );

                    const timer = setTimeout(async () => {
                        try {
                            const stillDisconnected = await Position.findOne({ email }).lean();

                            if (stillDisconnected && !stillDisconnected.socketId) {
                                const activeSockets = await io.in(email).fetchSockets();

                                if (activeSockets.length === 0) {
                                    const hasActiveTripRelation = Boolean(
                                        stillDisconnected.pasajeroAsignado || stillDisconnected.taxistaAsignado
                                    );

                                    const fallbackState = hasActiveTripRelation
                                        ? stillDisconnected.estado
                                        : POSITION_STATES.ACTIVO;

                                    logMotor(
                                        "socket_microdrop",
                                        `Limpiando estado huérfano para ${email} -> ${fallbackState} después de ${MICRODROP_TIMEOUT_MS}ms`,
                                        "WARN"
                                    );

                                    await Position.updateOne(
                                        { email },
                                        { $set: { estado: fallbackState, socketId: null, updatedAt: new Date(), lastSeenAt: new Date() } }
                                    );

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

                                    io.emit("panel_update", { email, estado: fallbackState, reason: "microdrop_timeout" });
                                }
                            }
                        } catch (timerError) {
                            logMotor("socket_microdrop", `Error en timer de microcorte para ${email}: ${timerError}`, "ERROR");
                        } finally {
                            microdropTimers.delete(email);
                        }
                    }, MICRODROP_TIMEOUT_MS);

                    microdropTimers.set(email, timer);
                    return;
                }

                await Position.updateOne(
                    { email },
                    { $set: { estado: POSITION_STATES.DESCONECTADO, socketId: null, updatedAt: new Date() } }
                );
                io.emit("panel_update", { email, estado: POSITION_STATES.DESCONECTADO, force: false });

            } catch (error) {
                logMotor("socket_disconnect", `Error en desconexión para ${email}: ${error}`, "ERROR");
            }
        });
    });
};

// ============================================================
// 🧹 8. CLEANUP Y MÉTRICAS CENTRALIZADAS
// ============================================================

export const cleanupSocketEngine = () => {
    logMotor("socket_cleanup", "Limpiando recursos del motor de sockets", "INFO");
    microdropTimers.forEach((timer) => clearTimeout(timer));
    microdropTimers.clear();
    rehydrationTimers.forEach((timer) => clearTimeout(timer));
    rehydrationTimers.clear();
    activeConnections.clear();
    handshakingUsers.clear();
};

export const getSocketStats = () => {
    return {
        activeConnections: activeConnections.size,
        microdropTimers: microdropTimers.size,
        rehydrationTimers: rehydrationTimers.size,
        handshakingUsers: handshakingUsers.size,
        isAutoMode: isAutoMode
    };
};