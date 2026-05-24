// src/services/pushService.ts
import * as dotenv from "dotenv";
import webpush from "web-push";
import { Position } from "../models/Position";
import { User } from "../models/User";
import { calculateDistance } from "../utils/distance";

dotenv.config();

webpush.setVapidDetails(
    "mailto:jorgelopezarevalo0@gmail.com",
    process.env.VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!
);

export const enviarNotificacionPush = async (subscription: any, pasajeroData: any, taxistaEmail: string) => {
    if (!subscription || !subscription.endpoint) return;

    try {
        const taxistaPos = await Position.findOne({ email: taxistaEmail });
        let distanciaMetros = 0;

        if (taxistaPos && taxistaPos.lat && pasajeroData.lat) {
            const distKM = calculateDistance(
                Number(pasajeroData.lat),
                Number(pasajeroData.lng),
                Number(taxistaPos.lat),
                Number(taxistaPos.lng)
            );
            distanciaMetros = Math.round(distKM * 1000);
        }

        const payload = JSON.stringify({
            title: "¡NUEVO VIAJE DISPONIBLE! 🚕",
            body: `Pasajero: ${pasajeroData.name}\nDistancia: ${distanciaMetros}m`,
            icon: "/icon-192x192.png",
            vibrate: [200, 100, 200, 100, 200],
            actions: [
                { action: "aceptar", title: "✅ ACEPTAR VIAJE" },
                { action: "rechazar", title: "❌ IGNORAR" }
            ],
            // Agrupamos todos tus metadatos dentro de un solo objeto data plano
            data: {
                emailPasajero: pasajeroData.email,
                emailTaxista: taxistaEmail,
                action: "OPEN_TRIP_REQUEST",
                url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/taxista`
            }
        });

        await webpush.sendNotification(subscription, payload, { TTL: 60, urgency: 'high' });
        console.log(`🔔 Push enviado con éxito a: ${taxistaEmail}`);
    } catch (error: any) {
        if (error.statusCode === 410 || error.statusCode === 404) {
            console.log(`⚠️ La suscripción de ${taxistaEmail} ha expirado. Limpiando BD...`);
            await Position.updateOne({ email: taxistaEmail }, { $set: { pushSubscription: null } });
            await User.updateOne({ email: taxistaEmail }, { $set: { pushSubscription: null } });
        }
        console.error(`❌ Error en web-push:`, error);
    }
};