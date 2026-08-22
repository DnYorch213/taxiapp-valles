import { Server, Socket } from "socket.io";
import { logMotor } from "../utils/logger";

// 🎯 Construye la clave única de la sala del viaje
export const getTripRoomId = (requestId: string): string => `trip_${requestId.trim()}`;

// 🎯 Unir un socket a la sala del viaje (Maneja limpieza previa)
export const joinTripRoom = (socket: Socket, requestId: string, email: string): void => {
    if (!requestId || !email) return;

    const roomId = getTripRoomId(requestId);
    const normalizedEmail = email.toLowerCase().trim();

    // 🛡️ Si el socket ya está en otra sala de viaje previa, lo sacamos primero
    if (socket.data?.tripRoom && socket.data.tripRoom !== roomId) {
        leaveTripRoom(socket);
    }

    socket.join(roomId);
    socket.data.tripRoom = roomId;
    socket.data.tripEmail = normalizedEmail;

    logMotor("trip_room", `✅ ${normalizedEmail} unido a la sala ${roomId}`, "INFO");
};

// 🎯 Sacar un socket de la sala del viaje de forma segura
export const leaveTripRoom = (socket: Socket): void => {
    if (socket.data?.tripRoom) {
        const roomId = socket.data.tripRoom as string;
        const email = (socket.data.tripEmail as string) || "Usuario";

        socket.leave(roomId);
        logMotor("trip_room", `👋 ${email} salió de ${roomId}`, "INFO");

        // Limpiar únicamente las referencias del viaje
        delete socket.data.tripRoom;
        delete socket.data.tripEmail;
    }
};

// 🎯 Emitir un evento coordinado a AMBOS participantes del viaje
export const emitToTripRoom = (
    io: Server,
    requestId: string,
    event: string,
    payload: Record<string, any>
): void => {
    if (!requestId) return;
    const roomId = getTripRoomId(requestId);

    const enrichedPayload = {
        ...payload,
        _tripEvent: true,
        _timestamp: Date.now(),
        _requestId: requestId
    };

    io.to(roomId).emit(event, enrichedPayload);
    logMotor("trip_room", `📡 Evento '${event}' → sala ${roomId}`, "INFO");
};

// 🎯 Notificar a la sala que uno de los dos se reconectó
export const notifyPeerReconnection = (
    io: Server,
    requestId: string,
    who: "pasajero" | "taxista",
    email: string
): void => {
    if (!requestId || !email) return;

    emitToTripRoom(io, requestId, "trip_peer_reconnected", {
        who,
        email: email.toLowerCase().trim(),
        timestamp: Date.now()
    });
};

// 🎯 Obtener correos únicos de los participantes en la sala
export const getTripRoomMembers = async (io: Server, requestId: string): Promise<string[]> => {
    if (!requestId) return [];
    try {
        const roomId = getTripRoomId(requestId);
        const sockets = await io.in(roomId).fetchSockets();

        // Usar Set para eliminar duplicados si el usuario tiene sockets zombi durante reconexión
        const emails = new Set<string>();
        for (const s of sockets) {
            if (s.data?.tripEmail) {
                emails.add(s.data.tripEmail as string);
            }
        }
        return Array.from(emails);
    } catch (error) {
        logMotor("trip_room", `❌ Error al obtener miembros de ${requestId}`, "ERROR");
        return [];
    }
};