// public/sw.js
const API_BASE_URL =
  self.location.hostname === "localhost"
    ? "http://localhost:3001"
    : "https://taxiapp-valles.onrender.com";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// 1. ESCUCHAR LA NOTIFICACIÓN PUSH
self.addEventListener("push", function (event) {
  if (!event.data) return;

  try {
    const rawData = event.data.json();
    const title = rawData.title || "¡NUEVO VIAJE DISPONIBLE! 🚕";

    const options = {
      body: rawData.body || `Nuevo servicio solicitado.`,
      icon: rawData.icon || "/icon-192x192.png",
      vibrate: rawData.vibrate || [200, 100, 200],
      actions: [
        { action: "accept_action", title: "✅ ACEPTAR VIAJE" },
        { action: "reject_action", title: "❌ IGNORAR" },
      ],
      requireInteraction: true,
      data: rawData.data, // Contiene requestId, emailPasajero, emailTaxista, etc.
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error("Error procesando notificación push en background:", err);
  }
});

// 2. GESTIONAR EL CLICK Y LAS ACCIONES
self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const action = event.action;
  const notificationData = notification.data || {};

  notification.close();

  // --- CASO 1: EL TAXISTA RECHAZA EL VIAJE ---
  if (action === "reject_action") {
    const apiPromise = fetch(`${API_BASE_URL}/api/reject-trip-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taxistaEmail: notificationData.emailTaxista,
        pasajeroEmail: notificationData.emailPasajero,
        requestId: notificationData.requestId,
      }),
    }).catch((err) => {
      console.error("❌ Error al ignorar viaje vía Push:", err);
    });

    event.waitUntil(apiPromise);
    return;
  }

  // --- CASO 2: EL TAXISTA ACEPTA EL VIAJE (BOTÓN "ACEPTAR") ---
  if (action === "accept_action") {
    const pEmail = encodeURIComponent(notificationData.emailPasajero || "");
    const tEmail = encodeURIComponent(notificationData.emailTaxista || "");
    const requestId = encodeURIComponent(notificationData.requestId || "");
    const targetUrl = `${self.location.origin}/taxista?pasajero=${pEmail}&taxista=${tEmail}&requestId=${requestId}&autoAccept=true`;

    event.waitUntil(
      (async () => {
        // 🚀 Primero enfocamos la ventana para no perder el permiso táctil
        await abrirOEnfocarApp(targetUrl);

        try {
          const response = await fetch(`${API_BASE_URL}/api/accept-trip-push`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              taxistaEmail: notificationData.emailTaxista,
              pasajeroEmail: notificationData.emailPasajero,
              requestId: notificationData.requestId,
            }),
          });

          if (!response.ok) {
            throw new Error("Error en servidor al aceptar viaje");
          }

          console.log("✅ Viaje pre-aceptado en BD desde el Service Worker.");
        } catch (err) {
          console.error("❌ Error al aceptar vía Push:", err);
        }
      })(),
    );
    return;
  }

  // --- CASO 3: CLIC NORMAL EN EL CUERPO DE LA NOTIFICACIÓN ---
  event.waitUntil(abrirOEnfocarApp(notificationData.url || "/taxista"));
});

// --- FUNCIÓN AUXILIAR: FOCO INTELIGENTE Y RÁPIDO ---
function abrirOEnfocarApp(targetPath) {
  const urlToOpen = new URL(targetPath, self.location.origin).href;

  return clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((windowClients) => {
      // 1) Si ya existe exactamente esa URL, solo enfocarla.
      for (const client of windowClients) {
        if (client.url === urlToOpen && "focus" in client) {
          return client.focus();
        }
      }

      // 2) Si existe una ventana del mismo origen, enfocar PRIMERO y navegar después.
      const sameOriginClient = windowClients.find((client) => {
        try {
          return new URL(client.url).origin === self.location.origin;
        } catch {
          return false;
        }
      });

      if (sameOriginClient) {
        // 🚨 FOCO INMEDIATO: Evita que Android bloquee el levantamiento de ventana
        if ("focus" in sameOriginClient) {
          sameOriginClient.focus();
        }
        if ("navigate" in sameOriginClient) {
          return sameOriginClient.navigate(urlToOpen);
        }
        return;
      }

      // 3) Si la app estaba completamente cerrada en background, abrir ventana nueva.
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    });
}
