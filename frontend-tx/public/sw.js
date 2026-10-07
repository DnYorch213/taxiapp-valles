const API_BASE_URL =
  self.location.hostname === "localhost"
    ? "http://localhost:3001"
    : "https://taxiapp-valles.onrender.com";

self.addEventListener("install", () => {
  console.log("✅ [SW] Instalando service worker...");
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  console.log("✅ [SW] Activando service worker...");
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  if (!event.data) return;

  try {
    const rawData = event.data.json();

    const requestId = rawData.data?.requestId || "unknown";
    const title = rawData.title || "¡NUEVO VIAJE DISPONIBLE! 🚕";
    const action = rawData.data?.action || "OPEN_TRIP_REQUEST";

    const options = {
      body: rawData.body || "Toca para abrir la app y aceptar el servicio.",
      icon: rawData.icon || "/icon-192x192.png",
      vibrate: rawData.vibrate || [200, 100, 200, 100, 200],
      tag: `taxi-request-${requestId}`,
      renotify: true,
      requireInteraction: true,
      data: rawData.data,
    };

    console.log("🔔 [SW] Mostrando notificación:", title, "acción:", action);

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error("❌ [SW] Error procesando push:", err);
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const data = event.notification.data || {};

  const requestId = data.requestId;
  const pasajero = data.emailPasajero;
  const taxista = data.emailTaxista;

  let url = data.url || `${self.location.origin}/taxista`;

  // 🔔 NUEVO VIAJE:
  // Construimos la URL que TaxistaView ya sabe
  // interpretar para rehidratar la solicitud.
  if (data.action === "OPEN_TRIP_REQUEST" && requestId && pasajero && taxista) {
    const params = new URLSearchParams({
      pasajero: pasajero,
      taxista: taxista,
      requestId: requestId,
    });

    url = `${self.location.origin}/taxista?` + params.toString();
  }

  console.log("🔔 [SW] Abriendo solicitud:", {
    url,
    requestId,
    pasajero,
    taxista,
  });

  event.waitUntil(
    self.clients
      .matchAll({
        type: "window",
        includeUncontrolled: true,
      })
      .then((clientList) => {
        // Si la app ya está abierta, reutilizamos esa ventana
        for (const client of clientList) {
          if ("focus" in client) {
            return client.focus().then(() => {
              if ("navigate" in client) {
                return client.navigate(url);
              }

              return undefined;
            });
          }
        }

        // Si la app no está abierta, la abrimos
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }

        return undefined;
      }),
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
