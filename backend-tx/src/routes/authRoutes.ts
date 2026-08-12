import { Router } from "express";
import { Request, Response } from "express";
import { User } from "../models/User";
import { Position } from "../models/Position"; // Aseg?rate de que la ruta sea correcta
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { verifyToken } from "../middleware/authMiddleware";

const router = Router();

// --- RUTA: REGISTRO ---
router.post("/register", async (req: Request, res: Response) => {
    try {
        const { name, email, phone, password, role, taxiNumber } = req.body;
        const normalizedEmail = email?.toLowerCase().trim();
        const digitsOnlyPhone = String(phone ?? "").replace(/\D/g, "");
        const normalizedPhone =
            digitsOnlyPhone.length === 12 && digitsOnlyPhone.startsWith("52")
                ? digitsOnlyPhone.slice(2)
                : digitsOnlyPhone;

        if (normalizedPhone.length !== 10) {
            return res.status(400).json({
                message: "El celular debe tener 10 d?gitos (puedes incluir +52).",
            });
        }

        const existingUser = await User.findOne({ email: normalizedEmail });
        if (existingUser) return res.status(400).json({ message: "El correo ya existe" });

        const hashed = await bcrypt.hash(password, 10);
        const user = new User({
            name: name.trim(),
            email: normalizedEmail,
            phone: normalizedPhone,
            password: hashed,
            role,
            taxiNumber: role === "taxista" ? taxiNumber.trim() : undefined,
            adminApproval: role === "taxista" ? "pendiente" : "aprobado"
        });

        await user.save();
        res.status(201).json({ message: "Usuario registrado con ?xito" });
    } catch (err) {
        res.status(500).json({ message: "Error en el servidor al registrar" });
    }
});

// --- RUTA: LOGIN ---
router.post("/login", async (req: Request, res: Response) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email: email.toLowerCase().trim() });

        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(400).json({ message: "Credenciales inv?lidas" });
        }

        const lastPos = await Position.findOne({ email: user.email });
        const token = jwt.sign(
            { email: user.email, name: user.name, phone: user.phone, role: user.role, taxiNumber: user.taxiNumber },
            process.env.JWT_SECRET as string,
            { expiresIn: '30d' }
        );

        const isProduction = process.env.NODE_ENV === "production";
        res.cookie("token", token, {
            httpOnly: true,
            secure: isProduction,
            sameSite: isProduction ? "none" : "lax",
            maxAge: 30 * 24 * 60 * 60 * 1000,
            path: "/"
        });

        res.json({
            role: user.role,
            name: user.name,
            phone: user.phone,
            taxiNumber: user.taxiNumber,
            email: user.email,
            adminApproval: user.adminApproval,
            lastCoords: lastPos ? { lat: lastPos.lat, lng: lastPos.lng } : null
        });
    } catch (error) {
        res.status(500).json({ message: "Error en login" });
    }
});

router.post("/logout", (req: Request, res: Response) => {
    const isProduction = process.env.NODE_ENV === "production";
    res.clearCookie("token", {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? "none" : "lax",
        path: "/"
    });
    return res.json({ success: true, message: "Sesi?n cerrada" });
});

// ==================== ?? RUTA PROTEGIDA: ACTUALIZAR GPS ====================
// ??? Requiere token JWT v?lido para evitar actualizaciones no autorizadas
router.post("/positions/update-gps", verifyToken, async (req: Request, res: Response) => {
    try {
        const { email, lat, lng } = req.body;
        const authenticatedEmail = (req as any).user?.email;

        if (authenticatedEmail?.toLowerCase().trim() !== email?.toLowerCase().trim()) {
            return res.status(403).json({
                success: false,
                message: "? No puedes actualizar la posici?n de otro usuario"
            });
        }

        if (!email || lat === undefined || lng === undefined) {
            return res.status(400).json({ success: false, message: "Datos de GPS incompletos" });
        }

        const posicionActualizada = await Position.findOneAndUpdate(
            { email: email.toLowerCase().trim() },
            {
                $set: {
                    lat: Number(lat),
                    lng: Number(lng),
                    updatedAt: new Date()
                }
            },
            { upsert: true, returnDocument: "after" }
        );

        return res.status(200).json({
            success: true,
            message: "Telemetr?a guardada en Atlas correctamente",
            data: {
                lat: posicionActualizada.lat,
                lng: posicionActualizada.lng
            }
        });

    } catch (error) {
        console.error("? Error HTTP en update-gps:", error);
        return res.status(500).json({ success: false, message: "Error interno del servidor en la telemetr?a" });
    }
});

export default router;
