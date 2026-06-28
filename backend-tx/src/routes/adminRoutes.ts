import { Router } from 'express';
import { updateTaxistaStatus, getPendingTaxistas, getVerifiedTaxistas, getTripsByDriver, getAllTripsHistory } from '../controllers/adminController';
import { verifyToken, isAdmin } from '../middleware/authMiddleware';

const router = Router();

// 🔐 TODAS LAS RUTAS REQUIEREN: Token válido + Rol admin
// Listar pendientes
router.get('/pending', verifyToken, isAdmin, getPendingTaxistas);

// Acción de aprobar/rechazar
router.put('/update-status/:id', verifyToken, isAdmin, updateTaxistaStatus);

// Listar aprobados
router.get('/verified', verifyToken, isAdmin, getVerifiedTaxistas);

// Historial de viajes
router.get('/historial-viajes', verifyToken, isAdmin, getAllTripsHistory);

router.get('/historial-viajes/:email', verifyToken, isAdmin, getTripsByDriver);


export default router;