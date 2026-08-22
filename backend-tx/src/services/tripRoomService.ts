// src/services/tripRoomService.ts
import { Server, Socket } from "socket.io";
import { logMotor } from "../utils/logger";

// 🎯 Cada viaje tiene su propia sala: trip_{requestId}
export const getTripRoomId = (requestId: string): string => `trip_${requestId}`;

// 🎯 Unir un socket a la sala del viaje
export const joinTripRoom = (socket: Socket, requestId: string, email: string): void => {
    if (!requestId || !email) return;
    const roomId = getTripRoomId(requestId);

    socket.join(roomId);
    socket.data.tripRoom = roomId;
    socket.data.tripEmail = email;

    logMotor("trip_room", `✅ ${email} unido a la sala ${roomId}`, "INFO");
};

// 🎯 Sacar un socket de la sala del viaje
export const leaveTripRoom = (socket: Socket): void => {
    if (socket.data?.tripRoom) {
        const roomId = socket.data.tripRoom as string;
        const email = (socket.data.tripEmail as string) || "Usuario";

        socket.leave(roomId);
        logMotor("trip_room", `👋 ${email} salió de ${roomId}`, "INFO");

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
    if (!requestId) return;

    emitToTripRoom(io, requestId, "trip_peer_reconnected", {
        who,
        email,
        timestamp: Date.now()
    });
};

// 🎯 Contar cuántos participantes hay en la sala
export const getTripRoomMembers = async (io: Server, requestId: string): Promise<string[]> => {
    if (!requestId) return [];
    const roomId = getTripRoomId(requestId);
    const sockets = await io.in(roomId).fetchSockets();
    return sockets.map(s => s.data.tripEmail as string).filter(Boolean);
};