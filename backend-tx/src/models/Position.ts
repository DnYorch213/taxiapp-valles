// src/models/Position.ts
import mongoose, { Schema, Document } from "mongoose";

// 🆕 Definir la interfaz con TODAS las propiedades necesarias
export interface IPosition extends Document {
    email: string;
    name?: string;
    role: string;
    lat?: number;
    lng?: number;
    destinationLat?: number;
    destinationLng?: number;
    estado: string;
    socketId?: string; // 🆕 AGREGAR ESTA LÍNEA
    taxiNumber?: string;
    taxistaAsignado?: string;
    pasajeroAsignado?: string;
    pickupAddress?: string;
    destinationAddress?: string;
    requestId: string;
    pushSubscription?: any;
    updatedAt?: Date;
    createdAt?: Date;
}

const positionSchema = new Schema(
    {
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        name: { type: String, trim: true },
        role: { type: String, required: true, enum: ["pasajero", "taxista", "admin"] },
        lat: { type: Number },
        lng: { type: Number },
        destinationLat: { type: Number },
        destinationLng: { type: Number },
        estado: { type: String, default: "pendiente" },
        socketId: { type: String }, // 🆕 AGREGAR ESTA LÍNEA
        taxiNumber: { type: String },
        taxistaAsignado: { type: String, lowercase: true, trim: true },
        pasajeroAsignado: { type: String, lowercase: true, trim: true },
        pickupAddress: { type: String },
        destinationAddress: { type: String },
        requestId: { type: String, required: true },
        pushSubscription: { type: Schema.Types.Mixed },
        updatedAt: { type: Date, default: Date.now },
        createdAt: { type: Date, default: Date.now }
    },
    {
        timestamps: true,
        collection: "positions"
    }
);

// 🆕 Índices para optimizar consultas frecuentes
positionSchema.index({ email: 1, estado: 1 });
positionSchema.index({ role: 1, estado: 1 });
positionSchema.index({ lat: 1, lng: 1 });
positionSchema.index({ socketId: 1 });

export const Position = mongoose.model<IPosition>("Position", positionSchema);