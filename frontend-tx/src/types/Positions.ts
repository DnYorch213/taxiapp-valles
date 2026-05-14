// src/types/Positions.ts
export type Rol = "pasajero" | "taxista" | "admin";

// 🚀 Definimos los estados permitidos como un tipo propio para que sea más fácil de usar
export type EstadoUsuario =
  | "buscando"      // pasajero solicitando
  | "preasignado"   // pasajero con oferta enviada
  | "asignado"      // taxista con oferta enviada
  | "encamino"      // ambos en camino
  | "encurso"       // viaje en curso
  | "finalizado"    // viaje terminado
  | "cancelado"     // cancelación
  | "activo"        // taxista disponible
  | "desconectado"; // limpieza de fantasmas

export interface Position {
  email: string;
  id?: string;
  lat: number | null;
  lng: number | null;
  heading?: number | null;
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