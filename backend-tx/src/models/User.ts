import mongoose, { Schema, Document } from "mongoose";

export interface IUser extends Document {
    name: string;
    email: string;
    password: string;
    role: "pasajero" | "taxista" | "admin";
    taxiNumber?: string | null; // 👈 nuevo campo, opcional
}

const UserSchema = new Schema<IUser>({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ["pasajero", "taxista", "admin"], required: true },
    taxiNumber: {
        type: String, required: function () {
            return this.role === "taxista";
        }
    },
});

const User = mongoose.model<IUser>("User", UserSchema);

export { User }; 
