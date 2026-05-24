// src/utils/payloadBuilder.ts

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

        estado: estado ?? pos?.estado ?? "pendiente",

        timestamp: new Date().toISOString(),
        ...extra,
    };
}