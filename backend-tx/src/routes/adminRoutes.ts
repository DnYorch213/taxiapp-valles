import { Router } from 'express';
import { updateTaxistaStatus, getPendingTaxistas, getVerifiedTaxistas, getTripsByDriver, getAllTripsHistory } from '../controllers/adminController';
// Aquí deberías importar tus middlewares de autenticación
// import { authenticateToken, isAdmin } from '../middleware/auth'; 

const router = Router();

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