import { Request, Response, NextFunction } from 'express';

// Este middleware asume que ya pasaste por un login y tienes el req.user
export const isAdmin = (req: any, res: Response, next: NextFunction) => {
    if (req.user && req.user.role === 'admin') {
        next(); // Es admin, puede pasar
    } else {
        res.status(403).json({
            message: "Acceso denegado. Solo el administrador de Valles Viaje puede autorizar taxistas."
        });
    }
};