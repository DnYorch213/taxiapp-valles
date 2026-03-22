// src/types/Payload.ts
import { Rol } from "./Positions";

export interface Payload {
    email: string;
    name?: string;
    role: Rol;
    taxiNumber?: string;

    lat: number | null;
    lng: number | null;

    pickupAddress?: string;

    // Estados posibles del flujo (Actualizado)
    estado:
    | "activo" | "pendiente" | "esperando" | "asignado" | "solicitando"
    | "aceptado" | "rechazado" | "cancelado" | "terminado" | "Finalizado" | "en camino" | "en curso" | "buscando" | "desconectado" | "ocupado"
    | "desconectado" | "ocupado"
    | "Inactivo" | "Esperando Asignación" | "Asignado" | "En Camino" | "En Curso" // ✅ Agrégalos aquí tal cual los usas en la UI
    | string; // Para cualquier estado personalizado que quieras agregar dinámicamente

    timestamp: string;
    updatedAt?: string | Date; // Para ordenar por fecha de actualización
}