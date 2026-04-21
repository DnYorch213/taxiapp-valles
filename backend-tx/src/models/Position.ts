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
        index: true // Índice simple adicional para búsquedas directas por correo
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
        default: "Disponible"
        // Valores sugeridos: Disponible, Asignado, EnCamino, EnCurso, Ocupado, Desconectado
    },
    taxistaAsignado: {
        type: String,
        default: null,
        lowercase: true,
        trim: true
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

// 1. Despacho Veloz: Encuentra taxistas libres para asignar servicios de inmediato
PositionSchema.index({ role: 1, estado: 1, email: 1 });

// 2. Búsqueda Inmortal: Localiza suscripciones de Push sin recorrer documentos nulos
// El 'sparse: true' hace que el índice sea pequeño y rápido (ignora a quien no tiene push)
PositionSchema.index({ "pushSubscription.endpoint": 1 }, { sparse: true });

// 3. Vinculación de Viajes: Para que el pasajero encuentre a su taxi (y viceversa) rápido
PositionSchema.index({ taxistaAsignado: 1, role: 1 });

// 4. Geo-limpieza: Para que el TTL (limpieza automática) sea posible si decides usarlo después
PositionSchema.index({ updatedAt: 1 });

const Position = mongoose.model<IPosition>("Position", PositionSchema);

export { Position };