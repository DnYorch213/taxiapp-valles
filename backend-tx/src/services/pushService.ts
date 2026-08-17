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

export const enviarNotificacionPush = async (subscription: any, pasajeroData: any, targetEmail: string) => {
    if (!subscription || !subscription.endpoint) return;

    try {
        let payload: string;

        if (pasajeroData.type === "TRIP_ACCEPTED") {
            // Notificación para el pasajero informándole que su viaje fue aceptado
            payload = JSON.stringify({
                title: "¡VIAJE CONFIRMADO! 🚕",
                body: `El conductor ${pasajeroData.name || "S/N"} (Eco: ${pasajeroData.taxiNumber || "S/N"}) ha aceptado tu viaje y va en camino.`,
                icon: `${process.env.FRONTEND_URL}/icon-192x192.png`,
                vibrate: [200, 100, 200],
                actions: [],
                data: {
                    requestId: pasajeroData.requestId,
                    taxistaEmail: pasajeroData.taxistaEmail,
                    action: "TRIP_ACCEPTED",
                    url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/pasajero`
                }
            });
        } else {
            // Notificación estándar para el taxista sobre un nuevo viaje disponible
            const taxistaPos = await Position.findOne({ email: targetEmail });
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

            payload = JSON.stringify({
                title: "¡NUEVO VIAJE DISPONIBLE! 🚕",
                // 🚨 CORRECCIÓN: Si no hay nombre, usa "Cliente". NUNCA uses el correo.
                body: `Pasajero: ${pasajeroData.name || "Cliente"}\nDistancia: ${distanciaMetros}m`,
                icon: `${process.env.FRONTEND_URL}/icon-192x192.png`,
                vibrate: [200, 100, 200, 100, 200],
                data: {
                    requestId: pasajeroData.requestId,
                    pickupAddress: pasajeroData.pickupAddress,
                    emailPasajero: pasajeroData.pasajeroEmail || pasajeroData.email,
                    emailTaxista: targetEmail,
                    pasajeroLat: pasajeroData.pasajeroLat || pasajeroData.lat,
                    pasajeroLng: pasajeroData.pasajeroLng || pasajeroData.lng,
                    distancia: distanciaMetros,
                    action: "OPEN_TRIP_REQUEST",
                    url: `${process.env.FRONTEND_URL || 'http://localhost:5173'}/taxista`
                }
            });
        }

        await webpush.sendNotification(subscription, payload, { TTL: 60, urgency: 'high' });
        console.log(`🔔 Push enviado con éxito a: ${targetEmail}`);
    } catch (error: any) {
        if (error.statusCode === 410 || error.statusCode === 404) {
            console.log(`⚠️ La suscripción de ${targetEmail} ha expirado. Limpiando BD...`);
            await Position.updateOne({ email: targetEmail }, { $set: { pushSubscription: null } });
            await User.updateOne({ email: targetEmail }, { $set: { pushSubscription: null } });
        }
        console.error(`❌ Error en web-push:`, error);
    }
};