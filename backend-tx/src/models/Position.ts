import mongoose, { Schema, Document } from "mongoose";

export interface IPosition extends Document {
    email: string;
    name: string;
    taxiNumber?: string;
    lat: number;
    lng: number;
    role: "pasajero" | "taxista" | "admin";
    estado: string;
    // Definimos mejor la estructura interna para evitar que Mongoose la ignore
    pushSubscription?: {
        endpoint: string;
        keys: {
            auth: string;
            p256dh: string;
        };
    } | null;
    updatedAt: Date;
}

const PositionSchema = new Schema<IPosition>({
    email: { type: String, required: true, unique: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    role: { type: String, enum: ["pasajero", "taxista", "admin"], required: true },
    name: { type: String, required: true },
    taxiNumber: { type: String, required: false },
    estado: { type: String, default: "activo" },
    // 💡 CAMBIO CLAVE: Usamos un esquema anidado en lugar de 'Object' genérico
    pushSubscription: {
        type: {
            endpoint: String,
            keys: {
                auth: String,
                p256dh: String
            }
        },
        default: null
    }
}, {
    timestamps: true // Esto genera automáticamente 'updatedAt' y 'createdAt'
});

const Position = mongoose.model<IPosition>("Position", PositionSchema);

export { Position };