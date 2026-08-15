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
    const requestId = rawData.data?.requestId || "unknown";

    const options = {
      body: rawData.body || "Nuevo servicio solicitado cerca de ti.",
      icon: rawData.icon || "/icon-192x192.png",
      vibrate: rawData.vibrate || [200, 100, 200],
      // 🎯 OPTIMIZACIÓN: Usar 'tag' evita que se acumulen notificaciones duplicadas si el backend reenvía
      tag: `taxi-request-${requestId}`,
      renotify: true,
      actions: rawData.actions || [
        { action: "accept_action", title: "✅ ACEPTAR" },
        { action: "reject_action", title: "❌ IGNORAR" },
      ],
      requireInteraction: true, // Mantiene la notificación hasta que el usuario interactúa
      data: rawData.data,
    };

    event.waitUntil(self.registration.showNotification(title, options));
  } catch (err) {
    console.error("❌ [SW] Error procesando push:", err);
  }
});

// 2. GESTIONAR EL CLICK Y LAS ACCIONES
self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const action = event.action;
  const notificationData = notification.data || {};

  notification.close();

  const pEmail = encodeURIComponent(notificationData.emailPasajero || "");
  const tEmail = encodeURIComponent(notificationData.emailTaxista || "");
  const requestId = encodeURIComponent(notificationData.requestId || "");

  const targetUrl = `${self.location.origin}/taxista?pasajero=${pEmail}&taxista=${tEmail}&requestId=${requestId}`;

  // 🎯 OPTIMIZACIÓN: Función asíncrona para manejar la apertura de la app de forma limpia
  const abrirApp = async () => {
    try {
      const windowClients = await clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Buscar si ya existe una ventana de la app
      const client = windowClients.find((c) =>
        c.url.startsWith(self.location.origin),
      );

      if (client && "focus" in client) {
        if ("navigate" in client) {
          await client.navigate(targetUrl);
        }
        return client.focus();
      }

      // Si no existe, abrir una nueva
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }
    } catch (err) {
      console.error("❌ [SW] Error al abrir/enfocar app:", err);
    }
  };

  // --- CASO 1: RECHAZAR ---
  if (action === "reject_action") {
    event.waitUntil(
      Promise.all([
        abrirApp(), // Siempre abrimos la app para dar feedback visual
        fetch(`${API_BASE_URL}/api/reject-trip-push`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taxistaEmail: notificationData.emailTaxista,
            pasajeroEmail: notificationData.emailPasajero,
            requestId: notificationData.requestId,
          }),
        }).catch((err) =>
          console.error("❌ [SW] Error al rechazar vía Push:", err),
        ),
      ]),
    );
    return;
  }

  // --- CASO 2: ACEPTAR ---
  if (action === "accept_action") {
    const autoAcceptUrl = `${targetUrl}&autoAccept=true`;

    event.waitUntil(
      Promise.all([
        abrirApp()
          .then(() => clients.matchAll({ type: "window" }))
          .then((clientsList) => {
            // Forzamos la navegación a la URL con autoAccept después de abrir
            const client = clientsList.find((c) =>
              c.url.startsWith(self.location.origin),
            );
            if (client && "navigate" in client)
              return client.navigate(autoAcceptUrl);
          }),
        fetch(`${API_BASE_URL}/api/accept-trip-push`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            taxistaEmail: notificationData.emailTaxista,
            pasajeroEmail: notificationData.emailPasajero,
            requestId: notificationData.requestId,
          }),
        }).catch((err) => console.error("❌ [SW] Error HTTP al aceptar:", err)),
      ]),
    );
    return;
  }

  // --- CASO 3: CLIC EN EL CUERPO DE LA NOTIFICACIÓN ---
  event.waitUntil(abrirApp());
});
