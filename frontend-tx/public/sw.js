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

// 🎯 AL TOCAR: ABRIR LA APP PARA QUE EL TAXISTA PUEDA ACEPTAR A TIEMPO
self.addEventListener("notificationclick", (event) => {
  // 1. Cerrar la notificación
  event.notification.close();

  // 2. Definir la URL base (sin parámetros, el socket se encargará de rehidratar el estado real)
  const targetUrl = `${self.location.origin}/taxista`;

  // 3. Enfocar o abrir la ventana de la app
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
