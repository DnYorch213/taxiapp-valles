import { Router } from 'express';
import { updateTaxistaStatus, getPendingTaxistas, getVerifiedTaxistas, getTripsByDriver, getAllTripsHistory } from '../controllers/adminController';
import { verifyToken, isAdmin } from '../middleware/authMiddleware';

const router = Router();

router.use(verifyToken, isAdmin);

// Listar pendientes
router.get('/pending', getPendingTaxistas);

// Acción de aprobar/rechazar
router.put('/update-status/:id', updateTaxistaStatus);

// Listar aprobados
router.get('/verified', getVerifiedTaxistas);

// backend-tx/src/routes/adminRoutes.ts

router.get('/historial-viajes', getAllTripsHistory);

router.get('/historial-viajes/:email', getTripsByDriver);


export default router;