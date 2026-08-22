import { Response } from "express";
import { User } from "../models/User";
import { Position } from "../models/Position";
import { AuthenticatedRequest } from "../middleware/authMiddleware";

/**
 * 🎯 Guardar o actualizar la suscripción Web Push para un usuario autenticado
 */
export const handleSaveSubscription = async (req: AuthenticatedRequest, res: Response) => {
    const { subscription } = req.body;

    // 🔐 Priorizar el email del token JWT autenticado
    const cleanEmail = (req.user?.email || req.body?.email)?.toLowerCase().trim();

    if (!cleanEmail || !subscription) {
        return res.status(400).json({
            message: "Faltan datos obligatorios para registrar la suscripción Web Push"
        });
    }

    try {
        // 1. Actualizar el perfil global del usuario
        const userUpdate = await User.findOneAndUpdate(
            { email: cleanEmail },
            { $set: { pushSubscription: subscription } },
            { new: true }
        );

        if (!userUpdate) {
            return res.status(404).json({ message: "Usuario no encontrado" });
        }

        // 2. Actualizar Position SOLO si el documento ya existe (evita crear registros corruptos)
        await Position.updateOne(
            { email: cleanEmail },
            { $set: { pushSubscription: subscription } }
        );

        console.log(`✅ [Push Sync] Token Web-Push sincronizado para: ${cleanEmail}`);
        return res.status(200).json({ message: "Suscripción guardada con éxito" });

    } catch (err) {
        console.error("❌ Error en handleSaveSubscription:", err);
        return res.status(500).json({
            message: "Error interno del servidor al guardar token Web Push"
        });
    }
};