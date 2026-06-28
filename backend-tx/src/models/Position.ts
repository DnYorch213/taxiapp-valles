import mongoose, { Schema, Document } from "mongoose";
import { POSITION_STATES, VALID_POSITION_STATES, PositionState } from "../constants/states";

export interface IPosition extends Document {
    email: string;
    name: string;
    taxiNumber?: string;
    lat: number;
    lng: number;
    role: "pasajero" | "taxista" | "admin";
    estado: PositionState;
    taxistaAsignado?: string | null;
    pasajeroAsignado?: string | null;
    pickupAddress?: string;
    destinationAddress?: string;
    requestId?: string;
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
    requestId: { type: String, default: null },
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
    // 🔐 Estados de posición en tiempo real - Utiliza constantes centralizadas
    estado: {
        type: String,
        enum: VALID_POSITION_STATES,
        default: POSITION_STATES.ACTIVO
    },
    taxistaAsignado: {
        type: String,
        default: null,
        lowercase: true,
        trim: true
    },
    pasajeroAsignado: {
        type: String,
        default: null,
        lowercase: true,
        trim: true
    },
    pickupAddress: {
        type: String,
        default: ""
    },
    destinationAddress: {
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
PositionSchema.index({ pasajeroAsignado: 1 });
PositionSchema.index({ updatedAt: 1 });

const Position = mongoose.model<IPosition>("Position", PositionSchema);

export { Position };