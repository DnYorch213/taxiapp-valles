import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
    name: string;
    email: string;
    password: string;
    role: "pasajero" | "taxista" | "admin";
    taxiNumber?: string | null;
    pushSubscription?: any | null;
}

const UserSchema = new Schema<IUser>({
    name: { type: String, required: true, trim: true },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: { type: String, required: true },
    role: {
        type: String,
        enum: ["pasajero", "taxista", "admin"],
        required: true
    },
    taxiNumber: {
        type: String,
        // 💡 Validación mejorada: Solo requerimos taxiNumber si es taxista
        required: function (this: IUser) {
            return this.role === "taxista";
        },
        default: null
    },
    // Usamos 'Mixed' para suscripciones push ya que la estructura 
    // de las keys de los navegadores puede variar ligeramente.
    pushSubscription: {
        type: Schema.Types.Mixed,
        default: null
    }
}, {
    timestamps: true // Útil para saber cuándo se registró el usuario
});

const User = mongoose.model<IUser>("User", UserSchema);

export { User };