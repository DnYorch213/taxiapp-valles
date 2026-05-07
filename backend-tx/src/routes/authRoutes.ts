import { Router } from "express";
import { Request, Response } from "express";
import { User } from "../models/User";
import { Position } from "../models/Position"; // Asegúrate de que la ruta sea correcta
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";

const router = Router();

// --- RUTA: REGISTRO ---
router.post("/register", async (req: Request, res: Response) => {
    try {
        const { name, email, password, role, taxiNumber } = req.body;

        // Aquí pegas todas tus validaciones (role === "admin", emailRegex, etc.)
        // ... (Tu lógica de validación de Valles)

        const existingUser = await User.findOne({ email });
        if (existingUser) return res.status(400).json({ message: "El correo ya existe" });

        const hashed = await bcrypt.hash(password, 10);
        const user = new User({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            password: hashed,
            role,
            taxiNumber: role === "taxista" ? taxiNumber.trim() : undefined,
            adminApproval: role === "taxista" ? "pendiente" : "aprobado"
        });

        await user.save();
        res.status(201).json({ message: "Usuario registrado con éxito" });
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
            return res.status(400).json({ message: "Credenciales inválidas" });
        }

        const lastPos = await Position.findOne({ email: user.email });
        const token = jwt.sign(
            { email: user.email, name: user.name, role: user.role },
            process.env.JWT_SECRET as string,
            { expiresIn: '30d' }
        );

        res.json({
            token,
            role: user.role,
            name: user.name,
            taxiNumber: user.taxiNumber,
            email: user.email,
            adminApproval: user.adminApproval,
            lastCoords: lastPos ? { lat: lastPos.lat, lng: lastPos.lng } : null
        });
    } catch (error) {
        res.status(500).json({ message: "Error en login" });
    }
});

export default router;