import mongoose, { Schema, Document } from "mongoose";

export interface IPosition extends Document {
    email: string;
    name: string;
    taxiNumber?: string; // 👈 Opcional con "?"
    lat: number;
    lng: number;
    role: "pasajero" | "taxista" | "admin";
    estado: string;      // 👈 Agregamos estado para persistencia
    updatedAt: Date;
}

const PositionSchema = new Schema<IPosition>({
    email: { type: String, required: true, unique: true }, // unique para evitar duplicados
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    role: { type: String, enum: ["pasajero", "taxista", "admin"], required: true },
    name: { type: String, required: true },
    taxiNumber: { type: String, required: false }, // 👈 Cambiado a false
    estado: { type: String, default: "activo" },    // 👈 Campo necesario
    updatedAt: { type: Date, default: Date.now },
});

// Índice para que los registros expiren si no se actualizan (opcional, p.ej. 24h)
// PositionSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 86400 });

const Position = mongoose.model<IPosition>("Position", PositionSchema);

export { Position };