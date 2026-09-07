const API_BASE_URL =
  self.location.hostname === "localhost"
    ? "http://localhost:3001"
    : "https://taxiapp-valles.onrender.com";

const isStandalone = () => {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
};

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
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
