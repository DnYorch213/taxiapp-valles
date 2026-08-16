// src/controllers/pushController.ts
import { Request, Response } from "express";
import { User } from "../models/User";
import { Position } from "../models/Position";

// 🎯 1. CONTROLADOR PARA GUARDAR SUSCRIPCIÓN PUSH (ESENCIAL)
// Este es el único endpoint HTTP que necesitamos para el sistema de notificaciones.
export const handleSaveSubscription = async (req: Request, res: Response) => {
    const { email, subscription } = req.body;

    if (!email || !subscription) {
        return res.status(400).json({ message: "Faltan datos obligatorios para registrar el Push" });
    }

    try {
        const cleanEmail = email.toLowerCase().trim();

        // Guardamos las llaves de suscripción en los perfiles de MongoDB
        await User.findOneAndUpdate({ email: cleanEmail }, { $set: { pushSubscription: subscription } });
        await Position.findOneAndUpdate({ email: cleanEmail }, { $set: { pushSubscription: subscription } }, { upsert: true });

        console.log(`✅ [Push Sync] Token Web-Push sincronizado en Atlas para: ${cleanEmail}`);
        return res.status(200).json({ message: "Suscripción guardada con éxito" });
    } catch (err) {
        console.error("❌ Error en handleSaveSubscription:", err);
        return res.status(500).json({ message: "Error interno del servidor al guardar token" });
    }
};

// 🚫 2. CONTROLADORES DE ACEPTAR/RECHAZAR VÍA HTTP (ELIMINADOS)
// Nota para el desarrollador:
// Dado que el Service Worker (sw.js) ya no incluye botones de acción y solo abre la app,
// la aceptación y el rechazo se manejan 100% a través de WebSockets en el frontend
// (TaxistaView.tsx -> socket.emit("taxi_response")).
// Se eliminaron handleAcceptTripPush y handleRejectTripPush para evitar código muerto
// y prevenir conflictos de estado por peticiones HTTP rezagadas (stale requests).