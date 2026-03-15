// src/types/Positions.ts
export type Rol = "pasajero" | "taxista" | "admin";

export interface Position {
  email: string;
  id?: string;
  lat: number | null;
  lng: number | null;
  name?: string;
  role: Rol;
  taxiNumber?: string;
  pickupAddress?: string;
  estado?: "activo" | "pendiente" | "en camino" | "finalizado" | "cancelado";
}

export interface Destination {
  lat: number | null;
  lng: number | null;
  direccion?: string;
}
