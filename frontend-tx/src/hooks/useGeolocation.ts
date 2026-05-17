import { useEffect, useRef } from "react";
import { socket } from "../lib/socket";
import { EstadoUsuario, Position } from "../types/Positions";

interface UserData {
    email: string;
    name: string;
    role: "pasajero" | "taxista" | "admin";
    taxiNumber?: string;
    estado?: string;
}

export const useGeolocation = (user: UserData, onRegistered?: (pos: Position) => void) => {
    const onRegisteredRef = useRef(onRegistered);
    onRegisteredRef.current = onRegistered;

    // 🚨 Ref para mantener los datos del usuario actualizados sin reiniciar el efecto
    const userRef = useRef(user);
    userRef.current = user;

    useEffect(() => {
        if (!user.email) return;

        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                if (latitude === 0 || longitude === 0) return;

                let lat = latitude;
                let lng = longitude;

                // OFFSET (Solo para visualización)
                if (userRef.current.role === "pasajero") {
                    lat += 0.00015;
                    lng += 0.00015;
                }

                const newPos: Position & { estado: string } = {
                    email: userRef.current.email,
                    name: userRef.current.name,
                    role: userRef.current.role,
                    taxiNumber: userRef.current.role === "taxista" ? userRef.current.taxiNumber : undefined,
                    lat,
                    lng,
                    estado: userRef.current.estado as EstadoUsuario || "activo",
                };

                // Emitir solo si el socket está conectado
                if (socket.connected) {
                    socket.emit("position", newPos);
                }

                if (onRegisteredRef.current) {
                    onRegisteredRef.current(newPos);
                }
            },
            (error) => {
                // Si el error es por timeout (3), no matamos el proceso, solo avisamos
                if (error.code !== 3) {
                    console.error("❌ Error GPS:", error.message);
                }
            },
            {
                enableHighAccuracy: true,
                timeout: 10000, // Subimos a 10s para dar margen en segundo plano
                maximumAge: 0
            }
        );

        return () => {
            navigator.geolocation.clearWatch(watchId);
        };
        // 💡 Quitamos user.role de las dependencias. 
        // Solo reiniciamos el GPS si el email cambia (un login diferente).
    }, [user.email]);
};