import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// 1. Extensión de la interfaz de Express para incluir req.user con tipos estrictos
export interface AuthUser {
    email: string;
    role: 'admin' | 'taxista' | 'pasajero';
    id?: string;
    [key: string]: any;
}

export interface AuthenticatedRequest extends Request {
    user?: AuthUser;
}

// 🔐 Middleware 1: Verifica que el token JWT sea válido
export const verifyToken = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                message: "❌ Token no proporcionado o formato inválido"
            });
        }

        const token = authHeader.substring(7);
        const secret = process.env.JWT_SECRET;

        // Guardacostas: asegura que la variable de entorno exista en producción
        if (!secret) {
            console.error("❌ ERROR CRÍTICO: JWT_SECRET no está configurado en las variables de entorno.");
            return res.status(500).json({ message: "Error de configuración interna en el servidor" });
        }

        const decoded = jwt.verify(token, secret) as AuthUser;

        req.user = decoded;
        return next();
    } catch (error: any) {
        // 401 para que Axios o el cliente entiendan que el token expiró y deben pedir re-login
        return res.status(401).json({
            message: "❌ Token expirado o inválido"
        });
    }
};

// 🔐 Middleware 2: Verifica que el usuario sea admin
export const isAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.user && req.user.role === 'admin') {
        return next();
    }
    return res.status(403).json({
        message: "🚫 Acceso denegado. Solo el administrador puede acceder a este recurso."
    });
};

// 🔐 Middleware 3: Verifica que el usuario sea taxista
export const isTaxista = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.user && req.user.role === 'taxista') {
        return next();
    }
    return res.status(403).json({
        message: "🚫 Acceso denegado. Solo taxistas pueden acceder a este recurso."
    });
};

// 🔐 Middleware 4: Verifica que el usuario sea pasajero
export const isPasajero = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.user && req.user.role === 'pasajero') {
        return next();
    }
    return res.status(403).json({
        message: "🚫 Acceso denegado. Solo pasajeros pueden acceder a este recurso."
    });
};