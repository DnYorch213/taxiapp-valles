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

// 1. ESCUCHAR LA NOTIFICACIÓN PUSH (SIN BOTONES DE ACCIÓN)
self.addEventListener("push", function (event) {
  if (!event.data) return;

  try {
    const rawData = event.data.json();
    const requestId = rawData.data?.requestId || "unknown";
    const title = rawData.title || "¡NUEVO VIAJE DISPONIBLE! 🚕";

    const options = {
      body: rawData.body || "Toca para ver los detalles y aceptar el servicio.",
      icon: rawData.icon || "/icon-192x192.png",
      vibrate: rawData.vibrate || [200, 100, 200],
      tag: `taxi-request-${requestId}`, // Evita notificaciones duplicadas
      renotify: true, // Vuelve a vibrar si se actualiza
      requireInteraction: true, // No se desaparece sola
      data: rawData.data,
      // 🚫 ELIMINADO: El array 'actions' ya no existe
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error("❌ [SW] Error procesando push:", err);
    // Fallback a notificación simple si falla el JSON
    event.waitUntil(
      self.registration.showNotification("Nuevo servicio", {
        body: "Toca para abrir la app",
      }),
    );
  }
});

// 2. AL TOCAR LA NOTIFICACIÓN: SOLO ABRIR/ENFOCAR LA APP
self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const notificationData = notification.data || {};

  // Cerrar la notificación al hacer clic
  notification.close();

  const pEmail = encodeURIComponent(notificationData.emailPasajero || "");
  const tEmail = encodeURIComponent(notificationData.emailTaxista || "");
  const requestId = encodeURIComponent(notificationData.requestId || "");

  // URL que abre la vista del taxista con los datos necesarios
  const targetUrl = `${self.location.origin}/taxista?pasajero=${pEmail}&taxista=${tEmail}&requestId=${requestId}`;

  event.waitUntil(
    clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windowClients) => {
        // Buscar si ya hay una ventana de la app abierta
        const client = windowClients.find((c) =>
          c.url.startsWith(self.location.origin),
        );

        if (client && "focus" in client) {
          // Si existe, la enfocamos y navegamos a la URL con los parámetros
          if ("navigate" in client) {
            client.navigate(targetUrl);
          }
          return client.focus();
        }

        // Si la app estaba cerrada, abrimos una ventana nueva
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
      .catch((err) => {
        console.error("❌ [SW] Error al abrir la app desde notificación:", err);
      }),
  );
});
