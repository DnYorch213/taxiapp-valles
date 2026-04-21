import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
    name: string;
    email: string;
    password: string;
    role: "pasajero" | "taxista" | "admin";
    taxiNumber?: string | null;
    pushSubscription?: any | null;
    // --- Campos de Seguridad ---
    isVerified: boolean;
    adminApproval: "pendiente" | "aprobado" | "rechazado";
    documentos: {
        licencia?: string;
        tarjeton?: string;
        seguro?: string;
        tarjetaCirculación?: string;
    };
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
        required: function (this: IUser) {
            return this.role === "taxista";
        },
        default: null
    },
    pushSubscription: {
        type: Schema.Types.Mixed,
        default: null
    },
    // 🚩 Candado de seguridad: Solo admin puede cambiar esto a true
    isVerified: {
        type: Boolean,
        default: false
    },
    // 🚩 Flujo de aprobación
    adminApproval: {
        type: String,
        enum: ["pendiente", "aprobado", "rechazado"],
        default: "pendiente"
    },
    // 🚩 URLs o referencias a los documentos físicos
    documentos: {
        licencia: { type: String, default: "" },
        tarjeton: { type: String, default: "" },
        seguro: { type: String, default: "" },
        tarjetaCirculación: { type: String, default: "" }
    }
}, {
    // Esto crea 'createdAt' (que sirve como fecha de registro) y 'updatedAt' automáticamente
    timestamps: true
});

const User = mongoose.model<IUser>("User", UserSchema);

export { User };