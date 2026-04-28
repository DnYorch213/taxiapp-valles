import mongoose, { Schema, Document } from "mongoose";

export interface ITrip extends Document {
    pasajeroEmail: string;
    pasajeroName: string;
    taxistaEmail: string;
    taxistaName: string;
    taxiNumber: string;
    pickupAddress: string;
    fecha: Date;
    estado: string; // "finalizado" | "cancelado"
}

const TripSchema: Schema = new Schema({
    pasajeroEmail: { type: String, required: true },
    pasajeroName: { type: String },
    taxistaEmail: { type: String, required: true, index: true }, // Indexado para que la búsqueda sea instantánea
    taxistaName: { type: String },
    taxiNumber: { type: String },
    pickupAddress: { type: String },
    fecha: { type: Date, default: Date.now },
    estado: { type: String, default: "finalizado" }
});

export const Trip = mongoose.model<ITrip>("Trip", TripSchema);