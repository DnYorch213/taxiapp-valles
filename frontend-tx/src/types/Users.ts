export type Rol = "pasajero" | "taxista" | "admin";

export interface Users {
  _id?: string;        // opcional, útil si viene de Mongo
  id?: string;         // opcional, útil en frontend
  name: string;
  email: string;
  password?: string | null;  // opcional en payloads, nunca se expone completo
  role: Rol;
  taxiNumber?: string;       // solo para taxistas, opcional
  updatedAt?: string;        // opcional, para trazabilidad
}
