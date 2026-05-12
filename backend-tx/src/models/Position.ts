import mongoose, { Schema, Document } from "mongoose";

export interface IPosition extends Document {
    email: string;
    name: string;
    taxiNumber?: string;
    lat: number;
    lng: number;
    role: "pasajero" | "taxista" | "admin";
    estado: string;
    taxistaAsignado?: string | null;
    pasajeroAsignado?: string | null; // 👈 AGREGADO
    pickupAddress?: string;
    destinationAddress?: string;    // 👈 AGREGADO
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
        trim: true,
        index: true
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
        default: "disponible" // 💡 Nota: Lo cambié a minúsculas para seguir tu nueva lógica
    },
    taxistaAsignado: {
        type: String,
        default: null,
        lowercase: true,
        trim: true
    },
    pasajeroAsignado: { // 👈 AGREGADO
        type: String,
        default: null,
        lowercase: true,
        trim: true
    },
    pickupAddress: {    // 👈 AGREGADO
        type: String,
        default: ""
    },
    destinationAddress: {    // 👈 AGREGADO
        type: String,
        default: ""
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
    timestamps: true
});

// --- ⚡ SECCIÓN DE ÍNDICES ESTRATÉGICOS ---

PositionSchema.index({ role: 1, estado: 1, email: 1 });
PositionSchema.index({ "pushSubscription.endpoint": 1 }, { sparse: true });
PositionSchema.index({ taxistaAsignado: 1, role: 1 });
PositionSchema.index({ pasajeroAsignado: 1 }); // 👈 Índice nuevo para búsquedas de taxistas
PositionSchema.index({ updatedAt: 1 });

const Position = mongoose.model<IPosition>("Position", PositionSchema);

export { Position };