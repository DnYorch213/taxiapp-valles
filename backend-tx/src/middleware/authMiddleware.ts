import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// ?? Middleware 1: Verifica que el token JWT sea v?lido
export const verifyToken = (req: any, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        const cookieHeader = req.headers.cookie || "";
        const cookieToken = cookieHeader
            .split(";")
            .map((cookie: string) => cookie.trim())
            .find((cookie: string) => cookie.startsWith("token="));
        const tokenFromCookie = cookieToken ? decodeURIComponent(cookieToken.split("=")[1]) : null;
        const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : tokenFromCookie;

        if (!token) {
            return res.status(401).json({
                message: "? Token no proporcionado o inv?lido"
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET as string);

        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({
            message: "? Token expirado o inv?lido"
        });
    }
};

// ?? Middleware 2: Verifica que el usuario sea admin DESPU?S de verificar token
export const isAdmin = (req: any, res: Response, next: NextFunction) => {
    if (req.user && req.user.role === 'admin') {
        next(); // Es admin, puede pasar
    } else {
        return res.status(403).json({
            message: "?? Acceso denegado. Solo el administrador de Valles Viaje puede autorizar taxistas."
        });
    }
};

// ?? Middleware 3: Verifica que el usuario sea taxista
export const isTaxista = (req: any, res: Response, next: NextFunction) => {
    if (req.user && req.user.role === 'taxista') {
        next();
    } else {
        return res.status(403).json({
            message: "?? Acceso denegado. Solo taxistas pueden acceder a este recurso."
        });
    }
};

// ?? Middleware 4: Verifica que el usuario sea pasajero
export const isPasajero = (req: any, res: Response, next: NextFunction) => {
    if (req.user && req.user.role === 'pasajero') {
        next();
    } else {
        return res.status(403).json({
            message: "?? Acceso denegado. Solo pasajeros pueden acceder a este recurso."
        });
    }
};
