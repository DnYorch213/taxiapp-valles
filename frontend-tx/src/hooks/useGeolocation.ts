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
    // Usamos un ref para la función onRegistered y evitar reinicios innecesarios del efecto
    const onRegisteredRef = useRef(onRegistered);
    onRegisteredRef.current = onRegistered;

    useEffect(() => {
        if (!user.email) return;

        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;

                // 🛡️ FILTRO ANTI-CEROS: Si la lat/lng es exactamente 0, ignoramos.
                if (latitude === 0 || longitude === 0) return;

                let lat = latitude;
                let lng = longitude;

                // 📏 OFFSET CORREGIDO (~15-20 metros aprox)
                // 0.0002 es mucho más cercano a lo que buscabas que 0.0020
                if (user.role === "pasajero") {
                    lat += 0.00015;
                    lng += 0.00015;
                }

                const newPos: Position & { estado: string } = {
                    email: user.email,
                    name: user.name,
                    role: user.role,
                    taxiNumber: user.role === "taxista" ? user.taxiNumber : undefined,
                    lat,
                    lng,
                    estado: user.estado as EstadoUsuario || "activo", // Puedes ajustar esto según tu lógica de negocio
                };

                // Solo emitimos si los datos son válidos
                socket.emit("position", newPos);

                if (onRegisteredRef.current) {
                    onRegisteredRef.current(newPos);
                }
            },
            (error) => console.error("❌ Error GPS:", error.message),
            {
                enableHighAccuracy: true, // Fuerza el uso de GPS real
                timeout: 10000,           // Espera máximo 10s
                maximumAge: 0             // No usar posiciones cacheadas viejas
            }
        );

        return () => {
            navigator.geolocation.clearWatch(watchId);
        };
        // 💡 IMPORTANTE: Solo dependemos del email para no reiniciar el GPS 
        // cada vez que cambie una propiedad menor del objeto user.
    }, [user.email, user.role]);
};