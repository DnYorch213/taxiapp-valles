const API_BASE_URL =
  self.location.hostname === "localhost"
    ? "http://localhost:3001"
    : "https://taxiapp-valles.onrender.com";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

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
    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error("❌ [SW] Error procesando push:", err);
  }
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const action = event.notification.data?.action || "OPEN_TRIP_REQUEST";
  const requestId = event.notification.data?.requestId || "";

  let targetUrl = `${self.location.origin}/taxista`;
  if (action === "TRIP_ACCEPTED" || action === "TRIP_STARTED" || action === "TRIP_FINISHED") {
    targetUrl = `${self.location.origin}/pasajero`;
  }

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        const client = windowClients.find((c) =>
          c.url.startsWith(self.location.origin),
        );

        if (client && "focus" in client) {
          if ("navigate" in client) {
            client.navigate(targetUrl);
          }
          return client.focus();
        }

        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      }),
  );
});
