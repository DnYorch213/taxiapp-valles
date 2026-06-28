// src/hooks/useGeolocation.ts
import { useEffect, useRef } from "react";
import { socket } from "../lib/socket";
import { EstadoUsuario, Position } from "../types/Positions";

interface UserData {
    email: string;
    name: string;
    role: "pasajero" | "taxista" | "admin";
    taxiNumber?: string;
    estado?: EstadoUsuario;
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

                const currentRole = userRef.current.role;
                const currentEstado = userRef.current.estado || "activo";

                // 🎯 TIPADO CORREGIDO: Usamos EstadoUsuario en lugar de string genérico
                const newPos: Position & { estado: EstadoUsuario } = {
                    email: userRef.current.email,
                    name: userRef.current.name,
                    role: currentRole,
                    taxiNumber: currentRole === "taxista" ? userRef.current.taxiNumber : undefined,
                    lat,
                    lng,
                    estado: currentEstado,
                };

                // 🎯 EL CANDADO: Si es taxista y está en viaje/aproximación, NO emitimos en este canal genérico.
                // Dejamos que los sockets de TaxistaView.tsx (taxi_moved / update_trip_path) controlen el flujo.
                const esTaxistaOcupado = currentRole === "taxista" && ["asignado", "encamino", "encurso"].includes(currentEstado);

                if (socket.connected && !esTaxistaOcupado) {
                    socket.emit("position", newPos);
                }

                // El callback local sigue corriendo libre para mover tu mapa de Leaflet de forma reactiva
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
                timeout: 10000, // Margen de 10s para evitar microcaídas en segundo plano
                maximumAge: 0
            }
        );

        return () => {
            navigator.geolocation.clearWatch(watchId);
        };
        // 💡 Solo reiniciamos el ciclo nativo del GPS si cambia la cuenta del usuario (email diferente)
    }, [user.email]);
};