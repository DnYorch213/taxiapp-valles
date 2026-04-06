// src/types/Payload.ts
import { Rol } from "./Positions";

// Definimos los estados como un tipo aparte para poder reutilizarlo
export type ViajeEstado =
    | "Disponible"
    | "Buscando"
    | "Asignado"
    | "EnCamino"
    | "EnCurso"
    | "Finalizado"
    | "Cancelado"
    | "Desconectado"
    | "Ocupado";

export interface Payload {
    email: string;
    name?: string;
    role: Rol;
    taxiNumber?: string;

    lat: number | null;
    lng: number | null;

    pickupAddress?: string;

    // ✅ Usamos el tipo específico para evitar errores de dedo
    estado: ViajeEstado;

    timestamp: string;
    updatedAt?: string | Date;
}