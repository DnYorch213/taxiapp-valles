import { Request, Response } from 'express';
import { User } from '../models/User';
import { Trip } from '../models/Trip';

// 1. Obtener todos los taxistas pendientes
export const getPendingTaxistas = async (req: Request, res: Response) => {
    try {
        const pending = await User.find({
            role: 'taxista',
            adminApproval: 'pendiente'
        }).select('-password').sort({ createdAt: -1 }); // Ordenamos por los más recientes

        res.json(pending);
    } catch (error) {
        res.status(500).json({ message: "Error al obtener taxistas pendientes", error });
    }
};

// 2. Actualización de estatus
export const updateTaxistaStatus = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { action } = req.body;

        // 🛡️ Mapeo de acciones a estados reales de la DB
        const actionMap: Record<string, any> = {
            'aprobar': { isVerified: true, adminApproval: 'aprobado' },
            'rechazar': { isVerified: false, adminApproval: 'rechazado' },
            'suspender': { isVerified: false, adminApproval: 'pendiente' }
        };

        const updateData = actionMap[action];

        if (!updateData) {
            return res.status(400).json({ message: "Acción no válida" });
        }

        // Usamos findByIdAndUpdate con runValidators para asegurar que el enum sea correcto
        const user = await User.findByIdAndUpdate(
            id,
            { $set: updateData },
            { new: true, runValidators: true }
        ).select('-password');

        if (!user) {
            return res.status(404).json({ message: "Taxista no encontrado en la base de datos de Valles" });
        }

        console.log(`🛡️ ADMIN: Taxista ${user.email} -> [${user.adminApproval.toUpperCase()}]`);

        res.json({
            message: `Taxista ${action} con éxito`,
            user
        });

    } catch (error) {
        console.error("❌ Error en updateTaxistaStatus:", error);
        res.status(500).json({ message: "Error al actualizar estatus", error });
    }
};

// 3. Obtener taxistas ya aprobados (Historial)
export const getVerifiedTaxistas = async (req: Request, res: Response) => {
    try {
        const verified = await User.find({
            role: 'taxista',
            adminApproval: 'aprobado' // Solo los que ya pasaron el filtro
        }).select('-password').sort({ updatedAt: -1 });

        res.json(verified);
    } catch (error) {
        res.status(500).json({ message: "Error al obtener historial", error });
    }
};

// 4. Obtener todos los viajes finalizados (Historial General)
export const getAllTripsHistory = async (req: Request, res: Response) => {
    try {
        // Cambiamos 'status' por 'estado'
        const trips = await Trip.find({ estado: 'finalizado' })
            .sort({ fecha: -1 }); // También cambiamos 'endDate' por 'fecha' aquí

        res.json(trips);
    } catch (error) {
        res.status(500).json({ message: "Error al obtener historial", error });
    }
};

// 5. Obtener viajes de un taxista específico (Filtro por Unidad)
export const getTripsByDriver = async (req: Request, res: Response) => {
    try {
        const { email } = req.params;
        const trips = await Trip.find({
            driverEmail: email,
            estado: 'finalizado'
        }).sort({ fecha: -1 });

        res.json(trips);
    } catch (error) {
        res.status(500).json({ message: "Error al filtrar viajes", error });
    }
};