import mongoose, { Schema, Document } from "mongoose";

export interface IPosition extends Document {
    email: string;
    name: string;
    taxiNumber?: string; // 👈 Opcional con "?"
    lat: number;
    lng: number;
    role: "pasajero" | "taxista" | "admin";
    estado: string;      // 👈 Agregamos estado para persistencia
    pushSubscription?: any | null; // 👈 Para notificaciones push, opcional
    updatedAt: Date;
}

const PositionSchema = new Schema<IPosition>({
    email: { type: String, required: true, unique: true }, // unique para evitar duplicados
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    role: { type: String, enum: ["pasajero", "taxista", "admin"], required: true },
    name: { type: String, required: true },
    taxiNumber: { type: String, required: false }, // 👈 Cambiado a false
    estado: { type: String, default: "activo" },
    pushSubscription: { type: Object, default: null },      // 👈 Para notificaciones push, opcional
    updatedAt: { type: Date, default: Date.now },
});

const Position = mongoose.model<IPosition>("Position", PositionSchema);

export { Position };