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

// 1. ESCUCHAR LA NOTIFICACIÓN PUSH (SOLO INFORMATIVA)
self.addEventListener("push", function (event) {
  if (!event.data) return;

  try {
    const rawData = event.data.json();
    const requestId = rawData.data?.requestId || "unknown";
    const title = rawData.title || "¡NUEVO VIAJE DISPONIBLE! 🚕";

    const options = {
      body:
        rawData.body ||
        "Toca para descartar esta alerta. Abre la app para aceptar.",
      icon: rawData.icon || "/icon-192x192.png",
      vibrate: rawData.vibrate || [200, 100, 200, 100, 200],
      tag: `taxi-request-${requestId}`,
      renotify: true,
      requireInteraction: true, // Se queda en pantalla hasta que el usuario la descarte
      data: rawData.data,
      // 🚫 SIN 'actions': No hay botones de aceptar/ignorar
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error("❌ [SW] Error procesando push:", err);
  }
});

// 2. AL TOCAR LA NOTIFICACIÓN: NO HACER NADA (Solo cerrarla)
self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;

  // 🎯 Simplemente cerramos la notificación.
  // No abrimos la app, no navegamos, no enviamos fetch.
  // El taxista abrirá la app manualmente y el WebSocket hará su trabajo de forma segura.
  notification.close();

  // Evitamos cualquier comportamiento por defecto del navegador
  event.stopImmediatePropagation();
});
