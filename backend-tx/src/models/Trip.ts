import mongoose, { Schema, Document } from "mongoose";
import { TRIP_STATES, VALID_TRIP_STATES, TripState } from "../constants/states";

export interface ITrip extends Document {
    pasajeroEmail: string;
    pasajeroName: string;
    taxistaEmail: string;
    taxistaName: string;
    taxiNumber: string;
    pickupAddress: string;
    destinationAddress: string;
    fecha: Date;
    estado: TripState;
}

const TripSchema: Schema = new Schema({
    pasajeroEmail: { type: String, required: true },
    pasajeroName: { type: String },
    taxistaEmail: { type: String, required: true, index: true },
    taxistaName: { type: String },
    taxiNumber: { type: String },
    pickupAddress: { type: String, default: "Origen no especificado" },
    destinationAddress: { type: String, default: "Destino no especificado" },
    fecha: { type: Date, default: Date.now },
    // 🔐 Estados únicamente para viajes completados (historial)
    estado: {
        type: String,
        enum: VALID_TRIP_STATES,
        default: TRIP_STATES.PENDIENTE
    }
});

export const Trip = mongoose.model<ITrip>("Trip", TripSchema);
