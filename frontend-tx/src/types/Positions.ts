// src/types/Positions.ts
export type Rol = "pasajero" | "taxista" | "admin";

// 🚀 Definimos los estados permitidos como un tipo propio para que sea más fácil de usar
export type EstadoUsuario =
  | "activo"
  | "pendiente"
  | "en camino"
  | "finalizado"
  | "cancelado"
  | "buscando"   // 👈 Añadido para el Pasajero solicitando
  | "esperando"  // 👈 Añadido para el Pasajero asignado
  | "en curso"   // 👈 Añadido para cuando ya van en el taxi
  | "desconectado"; // 👈 Añadido para la limpieza de "fantasmas"

export interface Position {
  email: string;
  id?: string;
  lat: number | null;
  lng: number | null;
  name?: string;
  role: Rol;
  taxiNumber?: string;
  pickupAddress?: string;
  estado?: EstadoUsuario; // 👈 Ahora usa el tipo extendido
}

export interface Destination {
  lat: number | null;
  lng: number | null;
  direccion?: string;
}