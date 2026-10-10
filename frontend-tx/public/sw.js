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
      body: rawData.body || "Tienes una nueva notificación de TaxiApp-Valles.",
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

// La notificación es únicamente informativa.
// Al tocarla, se cierra sin abrir, enfocar ni recargar la aplicación.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  console.log("🔔 [SW] Notificación cerrada; no se modifica la aplicación.");
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
