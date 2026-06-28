import { useState, useEffect } from "react";
import { socket } from "../lib/socket";
import { Payload } from "../types/Payload";

const normalizeEmail = (payload: Partial<Payload>) => {
    const email = payload.email || payload.pasajeroEmail || payload.taxistaEmail;
    return typeof email === "string" ? email.toLowerCase().trim() : "";
};

const dedupeByEmail = (items: Payload[]) => {
    const map = new Map<string, Payload>();
    items.forEach(item => {
        const email = normalizeEmail(item);
        if (!email) return;
        map.set(email, { ...item, email });
    });
    return Array.from(map.values());
};

export function useSocketPayload() {
    const [positions, setPositions] = useState<Payload[]>([]);
    const [panelUpdate, setPanelUpdate] = useState<Payload | null>(null);
    const [taxistaAsignado, setTaxistaAsignado] = useState<Payload | null>(null);
    const [pasajeroAsignado, setPasajeroAsignado] = useState<Payload | null>(null);
    const [tripStatus, setTripStatus] = useState<Payload | null>(null);

    useEffect(() => {
        socket.on("positions", (data: Payload[]) => {
            // Normalizar coordenadas y eliminar entradas duplicadas por email
            const sanitized = data.map(d => ({
                ...d,
                email: normalizeEmail(d),
                lat: d.lat ?? null,
                lng: d.lng ?? null,
            })).filter(d => !!d.email) as Payload[];
            setPositions(dedupeByEmail(sanitized));
        });

        socket.on("panel_update", (data: Payload) => {
            const email = normalizeEmail(data);
            const state = data.estado?.toLowerCase();
            const sanitized = {
                ...data,
                email,
                lat: data.lat ?? null,
                lng: data.lng ?? null,
            } as Payload;

            setPanelUpdate(sanitized);
            setPositions((prev) => {
                if (["desconectado", "cancelado", "inactivo"].includes(state)) {
                    return prev.filter((u) => u.email !== email);
                }

                const exists = prev.some((u) => u.email === email);
                return exists
                    ? prev.map((u) => (u.email === email ? { ...u, ...sanitized } : u))
                    : [...prev, sanitized];
            });
        });

        // Manejo explícito de trip_finished
        socket.on("trip_finished", (data: Payload) => {
            setTripStatus(data);
            const email = normalizeEmail(data);
            setPositions((prev) => prev.filter((u) => u.email !== email));
        });

        socket.on("taxista_asignado", (data: Payload) => setTaxistaAsignado(data));
        socket.on("pasajero_asignado", (data: Payload) => setPasajeroAsignado(data));

        socket.on("trip_cancelled_panel", (data: Payload) => {
            setTripStatus(data);
            const email = normalizeEmail(data);
            const sanitized = {
                ...data,
                email,
                lat: data.lat ?? null,
                lng: data.lng ?? null,
            } as Payload;

            setPositions((prev) => {
                const exists = prev.some((u) => u.email === email);
                return exists
                    ? prev.map((u) => (u.email === email ? { ...u, ...sanitized } : u))
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
