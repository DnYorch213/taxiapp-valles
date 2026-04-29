// src/types/Payload.ts
import { Rol } from "./Positions";

// Definimos los estados como un tipo aparte para poder reutilizarlo
export type ViajeEstado =
    | "disponible"
    | "buscando"
    | "asignado"
    | "encamino"
    | "encurso"
    | "finalizado"
    | "cancelado"
    | "desconectado"
    | "ocupado"
    | "activo"
    | "esperando"; // Estado general para taxistas en sesión, incluso sin viaje activo

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

    timestamp: string;
    updatedAt?: string | Date;
}