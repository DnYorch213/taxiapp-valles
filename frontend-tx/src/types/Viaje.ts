// src/types/Viaje.ts
export interface Viaje {
  _id?: string;            // opcional si viene de Mongo
  email: string;
  name: string;
  pickupAddress: string;
  lat: number | null;
  lng: number | null;
  estado: "pendiente" | "encamino" | "finalizado" | "cancelado" | "asignado" | "aceptado" | "rechazado" | "terminado" | "desconectado";
  role: "pasajero" | "taxista" | "admin";
  timestamp?: string;      // opcional
}
