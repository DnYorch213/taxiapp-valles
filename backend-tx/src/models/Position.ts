import mongoose, { Schema, Document } from "mongoose";

export interface IPosition extends Document {
    email: string;
    name: string;
    taxiNumber?: string;
    lat: number;
    lng: number;
    role: "pasajero" | "taxista" | "admin";
    estado: string;
    // 🔗 CAMBIO CLAVE: Campo para vincular taxista y pasajero
    taxistaAsignado?: string | null;
    pushSubscription?: {
        endpoint: string;
        keys: {
            auth: string;
            p256dh: string;
        };
    } | null;
    updatedAt: Date;
    createdAt: Date;
}

const PositionSchema = new Schema<IPosition>({
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    name: { type: String, required: true },
    taxiNumber: { type: String, required: false },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    role: {
        type: String,
        enum: ["pasajero", "taxista", "admin"],
        required: true
    },
    estado: {
        type: String,
        default: "activo" // activo, asignado, en curso, ocupado, desconectado
    },
    // 💡 Aquí guardaremos el email del taxista si el rol es 'pasajero'
    taxistaAsignado: {
        type: String,
        default: null
    },
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
    timestamps: true // Esto ya maneja 'updatedAt' y 'createdAt' automáticamente
});

// Índice para búsquedas rápidas de servicios activos
PositionSchema.index({ taxistaAsignado: 1, role: 1 });

const Position = mongoose.model<IPosition>("Position", PositionSchema);

export { Position };