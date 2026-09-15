import mongoose, { Schema, Document } from "mongoose";

export interface IPosition extends Document {
    email: string;
    name?: string;
    role: "pasajero" | "taxista" | "admin";
    lat?: number;
    lng?: number;
    destinationLat?: number;
    destinationLng?: number;
    estado: string;
    socketId?: string;
    taxiNumber?: string;
    taxistaAsignado?: string;
    pasajeroAsignado?: string;
    pickupAddress?: string;
    destinationAddress?: string;
    requestId?: string;
    pushSubscription?: any;

    location?: {
        type: "Point";
        coordinates: [number, number];
    };

    updatedAt?: Date;
    createdAt?: Date;
}

const positionSchema = new Schema<IPosition>(
    {
        email: {
            type: String,
            required: true,
            unique: true,
            lowercase: true,
            trim: true
        },

        name: {
            type: String,
            trim: true
        },

        role: {
            type: String,
            required: true,
            enum: ["pasajero", "taxista", "admin"]
        },

        lat: {
            type: Number
        },

        lng: {
            type: Number
        },

        destinationLat: {
            type: Number
        },

        destinationLng: {
            type: Number
        },

        estado: {
            type: String,
            default: "pendiente"
        },

        socketId: {
            type: String
        },

        location: {
            type: {
                type: String,
                enum: ["Point"],
                default: "Point"
            },

            coordinates: {
                type: [Number],
                default: undefined
            }
        },

        taxiNumber: {
            type: String
        },

        taxistaAsignado: {
            type: String,
            lowercase: true,
            trim: true
        },

        pasajeroAsignado: {
            type: String,
            lowercase: true,
            trim: true
        },

        pickupAddress: {
            type: String
        },

        destinationAddress: {
            type: String
        },

        requestId: {
            type: String
        },

        pushSubscription: {
            type: Schema.Types.Mixed
        }
    },
    {
        timestamps: true,
        collection: "positions"
    }
);

// Índices
positionSchema.index({ email: 1, estado: 1 });
positionSchema.index({ role: 1, estado: 1 });
positionSchema.index({ lat: 1, lng: 1 });
positionSchema.index({ socketId: 1 });
positionSchema.index({ location: "2dsphere" });

export const Position = mongoose.model<IPosition>(
    "Position",
    positionSchema
);