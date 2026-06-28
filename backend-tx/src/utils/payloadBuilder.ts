import { POSITION_STATES } from "../constants/states";

export function buildPayload(user: any, pos: any, estado: string, extra: any = {}) {
    return {
        email: user?.email || pos?.email,
        name: user?.name || pos?.name,
        role: user?.role || pos?.role,
        taxiNumber: user?.taxiNumber || pos?.taxiNumber,

        lat: pos?.lat ?? null,
        lng: pos?.lng ?? null,

        taxistaAsignado: extra.taxistaAsignado || pos?.taxistaAsignado || null,
        pasajeroAsignado: extra.pasajeroAsignado || pos?.pasajeroAsignado || null,

        pushSubscription: extra.pushSubscription || pos?.pushSubscription || user?.pushSubscription || null,
        pickupAddress: extra.pickupAddress || pos?.pickupAddress || user?.pickupAddress || "Calculando ubicación...",
        destinationAddress: extra.destinationAddress || pos?.destinationAddress || user?.destinationAddress || "Destino no especificado",

        estado: estado ?? pos?.estado ?? POSITION_STATES.ACTIVO,

        // 🚩 Campos explícitos para notificaciones y métricas
        pasajeroEmail: extra.pasajeroEmail || pos?.pasajeroEmail || null,
        pasajeroLat: extra.pasajeroLat || pos?.pasajeroLat || null,
        pasajeroLng: extra.pasajeroLng || pos?.pasajeroLng || null,
        taxistaEmail: extra.taxistaEmail || pos?.taxistaEmail || null,
        distancia: extra.distancia || null,

        timestamp: new Date().toISOString(),
        ...extra,
    };
}
