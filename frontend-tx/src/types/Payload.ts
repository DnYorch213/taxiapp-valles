// src/types/Payload.ts
import { Rol } from "./Positions";

// Definimos los estados como un tipo aparte para poder reutilizarlo
export type ViajeEstado =
    | "buscando"
    | "preasignado"
    | "asignado"
    | "encamino"
    | "encurso"
    | "finalizado"
    | "cancelado"
    | "desconectado"
    | "activo"; // Estado general para taxistas en sesión, incluso sin viaje activo

export interface Payload {
    email: string;
    name?: string;
    role: Rol;
    taxiNumber?: string;

    lat: number | null;
    lng: number | null;

    pickupAddress?: string;
    destinationAddress?: string;

    // ✅ Usamos el tipo específico para evitar errores de dedo
    estado: ViajeEstado;

    // Campos para asignaciones
    taxistaAsignado?: string | null;
    pasajeroAsignado?: string | null;
    pushSubscription?: {
        endpoint: string;
        keys: {
            auth: string;
            p256dh: string;
        };
    } | null;
    attempt?: number; // Para reintentos de envío de notificaciones
    timestamp: string;
    updatedAt?: string | Date;

    // Campos específicos para asignaciones
    pasajeroEmail?: string;
    taxistaEmail?: string;
}