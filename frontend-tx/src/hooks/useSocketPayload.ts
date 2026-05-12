import { useState, useEffect } from "react";
import { socket } from "../lib/socket";
import { Payload } from "../types/Payload";

export function useSocketPayload() {
    const [positions, setPositions] = useState<Payload[]>([]);
    const [panelUpdate, setPanelUpdate] = useState<Payload | null>(null);
    const [taxistaAsignado, setTaxistaAsignado] = useState<Payload | null>(null);
    const [pasajeroAsignado, setPasajeroAsignado] = useState<Payload | null>(null);
    const [tripStatus, setTripStatus] = useState<Payload | null>(null);

    useEffect(() => {
        socket.on("positions", (data: Payload[]) => {
            // Normalizar coordenadas
            setPositions(data.map(d => ({
                ...d,
                lat: d.lat ?? null,
                lng: d.lng ?? null,
            })));
        });

        socket.on("panel_update", (data: Payload) => {
            setPanelUpdate(data);
            setPositions((prev) => {
                const estado = data.estado?.toLowerCase();

                // 🚀 Limpieza inmediata de cancelados, inactivos o desconectados
                if (["desconectado", "cancelado", "inactivo"].includes(estado)) {
                    return prev.filter((u) => u.email !== data.email);
                }

                const exists = prev.some((u) => u.email === data.email);
                const sanitized = {
                    ...data,
                    lat: data.lat ?? null,
                    lng: data.lng ?? null,
                };

                return exists
                    ? prev.map((u) => (u.email === data.email ? { ...u, ...sanitized } : u))
                    : [...prev, sanitized];
            });
        });

        // Manejo explícito de trip_finished
        socket.on("trip_finished", (data: Payload) => {
            setTripStatus(data);
            setPositions((prev) => prev.filter((u) => u.email !== data.pasajeroEmail));
        });

        socket.on("taxista_asignado", (data: Payload) => setTaxistaAsignado(data));
        socket.on("pasajero_asignado", (data: Payload) => setPasajeroAsignado(data));

        socket.on("trip_cancelled_panel", (data: Payload) => {
            setTripStatus(data);
            setPositions((prev) => {
                const exists = prev.some((u) => u.email === data.email);
                const sanitized = {
                    ...data,
                    lat: data.lat ?? null,
                    lng: data.lng ?? null,
                };
                return exists
                    ? prev.map((u) => (u.email === data.email ? { ...u, ...sanitized } : u))
                    : [...prev, sanitized];
            });
        });

        socket.on("response_from_taxi", ({ accepted }) => {
            if (!accepted) {
                setTaxistaAsignado(null);
                setPasajeroAsignado(null);
            }
        });

        socket.on("end_trip", (data: Payload) => {
            setTripStatus(data);
            setTaxistaAsignado(null);
            setPasajeroAsignado(null);
        });

        return () => {
            socket.off("positions");
            socket.off("panel_update");
            socket.off("taxista_asignado");
            socket.off("pasajero_asignado");
            socket.off("trip_cancelled_panel");
            socket.off("response_from_taxi");
            socket.off("trip_finished");
            socket.off("end_trip");
        };
    }, []);

    return { positions, panelUpdate, taxistaAsignado, pasajeroAsignado, tripStatus };
}
