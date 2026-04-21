import { Router } from 'express';
import { updateTaxistaStatus, getPendingTaxistas, getVerifiedTaxistas } from '../controllers/adminController';
// Aquí deberías importar tus middlewares de autenticación
// import { authenticateToken, isAdmin } from '../middleware/auth'; 

const router = Router();

// Listar pendientes
router.get('/pending', getPendingTaxistas);

// Acción de aprobar/rechazar
router.put('/update-status/:id', updateTaxistaStatus);

// Listar aprobados
router.get('/verified', getVerifiedTaxistas);


export default router;