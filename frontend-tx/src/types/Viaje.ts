// src/types/Viaje.ts
export type EstadoViaje =
  | "buscando"     // pasajero solicita taxi
  | "preasignado"  // oferta enviada
  | "asignado"     // taxista asignado
  | "encamino"     // taxista en camino
  | "encurso"      // viaje en curso
  | "finalizado"   // viaje terminado
  | "cancelado"    // cancelación
  | "desconectado" // limpieza de fantasmas
  | "activo";  // estado inicial del taxista

export interface Viaje {
  _id?: string;            // opcional si viene de Mongo
  email: string;
  name: string;
  pickupAddress: string;
  lat: number | null;
  lng: number | null;
  estado: EstadoViaje;
  role: "pasajero" | "taxista" | "admin";
  timestamp?: string;      // opcional
}
