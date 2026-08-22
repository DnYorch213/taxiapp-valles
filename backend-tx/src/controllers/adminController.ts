import { Request, Response } from 'express';
import mongoose from 'mongoose';
import { User } from '../models/User';
import { Trip } from '../models/Trip';
import { TRIP_STATES } from '../constants/states';

// 1. Obtener todos los taxistas pendientes
export const getPendingTaxistas = async (req: Request, res: Response) => {
    try {
        const pending = await User.find({
            role: 'taxista',
            adminApproval: 'pendiente'
        }).select('-password').sort({ createdAt: -1 });

        return res.json(pending);
    } catch (error) {
        return res.status(500).json({ message: "Error al obtener taxistas pendientes", error });
    }
};

// 2. Actualización de estatus del taxista (Aprobar / Rechazar / Suspender)
export const updateTaxistaStatus = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const { action } = req.body;

        // 🛡️ Validar que el ID sea un ObjectId válido de Mongoose
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "ID de taxista no válido" });
        }

        // 🛡️ Mapeo de acciones a estados reales de la DB
        const actionMap: Record<string, any> = {
            'aprobar': { isVerified: true, adminApproval: 'aprobado' },
            'rechazar': { isVerified: false, adminApproval: 'rechazado' },
            'suspender': { isVerified: false, adminApproval: 'pendiente' }
        };

        const updateData = actionMap[action];

        if (!updateData) {
            return res.status(400).json({ message: "Acción no válida. Opciones: aprobar, rechazar, suspender" });
        }

        const user = await User.findByIdAndUpdate(
            id,
            { $set: updateData },
            { returnDocument: "after", runValidators: true }
        ).select('-password');

        if (!user) {
            return res.status(404).json({ message: "Taxista no encontrado en la base de datos de Valles" });
        }

        console.log(`🛡️ ADMIN: Taxista ${user.email} -> [${user.adminApproval.toUpperCase()}]`);

        return res.json({
            message: `Taxista ${action} con éxito`,
            user
        });

    } catch (error) {
        console.error("❌ Error en updateTaxistaStatus:", error);
        return res.status(500).json({ message: "Error al actualizar estatus del taxista", error });
    }
};

// 3. Obtener taxistas ya aprobados (Historial)
export const getVerifiedTaxistas = async (req: Request, res: Response) => {
    try {
        const verified = await User.find({
            role: 'taxista',
            adminApproval: 'aprobado'
        }).select('-password').sort({ updatedAt: -1 });

        return res.json(verified);
    } catch (error) {
        return res.status(500).json({ message: "Error al obtener historial de taxistas", error });
    }
};

// 4. Obtener todos los viajes finalizados (Historial General con Límite de Seguridad)
export const getAllTripsHistory = async (req: Request, res: Response) => {
    try {
        const limitParam = Math.max(1, Math.min(Number(req.query.limit) || 100, 500));

        const trips = await Trip.find({ estado: TRIP_STATES.FINALIZADO })
            .sort({ fecha: -1 })
            .limit(limitParam)
            .lean();

        return res.json(trips);
    } catch (error) {
        return res.status(500).json({ message: "Error al obtener historial de viajes", error });
    }
};

// 5. Obtener viajes de un taxista específico (Filtro por Unidad con Límite)
export const getTripsByDriver = async (req: Request, res: Response) => {
    try {
        const email = req.params.email.toLowerCase().trim();
        const limitParam = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));

        const trips = await Trip.find({
            taxistaEmail: email,
            estado: TRIP_STATES.FINALIZADO
        })
            .sort({ fecha: -1 })
            .limit(limitParam)
            .lean();

        return res.json(trips);
    } catch (error) {
        return res.status(500).json({ message: "Error al filtrar viajes del taxista", error });
    }
};

// 6. Control de pasajeros: métricas generales + recientes
export const getPassengerControlStats = async (req: Request, res: Response) => {
    try {
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

        const daysParam = Number(req.query.days);
        const searchParam = String(req.query.search || '').trim();
        const limitParam = Math.max(1, Math.min(Number(req.query.limit) || 50, 500));

        const createdAtFilter = Number.isFinite(daysParam) && daysParam > 0
            ? { $gte: new Date(now.getTime() - daysParam * 24 * 60 * 60 * 1000) }
            : undefined;

        const sanitizedSearch = searchParam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const searchRegex = sanitizedSearch ? new RegExp(sanitizedSearch, 'i') : null;

        const listFilter: Record<string, any> = { role: 'pasajero' };
        if (createdAtFilter) listFilter.createdAt = createdAtFilter;
        if (searchRegex) {
            listFilter.$or = [
                { name: searchRegex },
                { email: searchRegex },
                { phone: searchRegex },
            ];
        }

        const [
            totalRegistered,
            registeredLast7Days,
            registeredLast30Days,
            filteredRegistered,
            passengersRecent,
        ] = await Promise.all([
            User.countDocuments({ role: 'pasajero' }),
            User.countDocuments({ role: 'pasajero', createdAt: { $gte: sevenDaysAgo } }),
            User.countDocuments({ role: 'pasajero', createdAt: { $gte: thirtyDaysAgo } }),
            User.countDocuments(listFilter),
            User.find(listFilter)
                .select('name email phone createdAt updatedAt')
                .sort({ createdAt: -1 })
                .limit(limitParam)
                .lean(),
        ]);

        return res.json({
            totalRegistered,
            registeredLast7Days,
            registeredLast30Days,
            filteredRegistered,
            passengersRecent,
            filters: {
                days: createdAtFilter ? daysParam : null,
                search: searchParam || null,
                limit: limitParam,
            },
            generatedAt: now.toISOString(),
        });
    } catch (error) {
        return res.status(500).json({ message: 'Error al obtener control de pasajeros', error });
    }
};