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
  const action = event.action; // 'accept_action', 'reject_action' o '' (clic normal)
  const notificationData = notification.data || {};

  console.info("[SW] notificationclick", {
    action,
    pasajero: notificationData.emailPasajero || null,
    taxista: notificationData.emailTaxista || null,
    requestId: notificationData.requestId || null,
  });

  notification.close();

  const pEmail = encodeURIComponent(notificationData.emailPasajero || "");
  const tEmail = encodeURIComponent(notificationData.emailTaxista || "");
  const requestId = encodeURIComponent(notificationData.requestId || "");

  // URL objetivo para abrir la app
  const targetUrl = `${self.location.origin}/taxista?pasajero=${pEmail}&taxista=${tEmail}&requestId=${requestId}`;

  // --- CASO 1: EL TAXISTA RECHAZA EL VIAJE (BOTÓN "❌ IGNORAR") ---
  if (action === "reject_action") {
    event.waitUntil(
      fetch(`${API_BASE_URL}/api/reject-trip-push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          taxistaEmail: notificationData.emailTaxista,
          pasajeroEmail: notificationData.emailPasajero,
          requestId: notificationData.requestId,
        }),
      }).catch((err) => console.error("❌ Error al rechazar vía Push:", err)),
    );
    return;
  }

  // --- CASO 2: EL TAXISTA ACEPTA EL VIAJE (BOTÓN "✅ ACEPTAR VIAJE") ---
  if (action === "accept_action") {
    const autoAcceptUrl = `${targetUrl}&autoAccept=true`;

    console.info("[SW] accept_action -> abriendo app", { autoAcceptUrl });

    const abrirVentanaPromesa = abrirOEnfocarApp(autoAcceptUrl);

    const aceptarApiPromesa = fetch(`${API_BASE_URL}/api/accept-trip-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taxistaEmail: notificationData.emailTaxista,
        pasajeroEmail: notificationData.emailPasajero,
        requestId: notificationData.requestId,
      }),
    })
      .then(() => console.info("[SW] accept_action -> backend OK"))
      .catch((err) => console.error("❌ Error al aceptar HTTP:", err));

    event.waitUntil(Promise.all([abrirVentanaPromesa, aceptarApiPromesa]));
    return;
  }

  // --- CASO 3: CLIC EN EL CUERPO DE LA NOTIFICACIÓN ---
  // Solo abre o enfoca la app para que decida dentro de la pantalla sin pre-aceptar
  event.waitUntil(abrirOEnfocarApp(notificationData.url || targetUrl));
});

// --- FUNCIÓN AUXILIAR DE FOCO AGRESIVO ---
function abrirOEnfocarApp(targetUrl) {
  const urlToOpen = new URL(targetUrl, self.location.origin).href;

  console.info("[SW] abrirOEnfocarApp", { urlToOpen });

  return clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((windowClients) => {
      console.info("[SW] ventanas detectadas", { total: windowClients.length });

      // 1. Si hay ventanas abiertas del mismo origen
      for (const client of windowClients) {
        if ("focus" in client) {
          console.info("[SW] enfocando cliente existente", {
            clientUrl: client.url,
            nextUrl: urlToOpen,
          });
          if ("navigate" in client) {
            client.navigate(urlToOpen);
          }
          return client.focus();
        }
      }

      // 2. Si la app estaba en segundo plano profundo o cerrada, abrir ventana nueva
      if (clients.openWindow) {
        console.info("[SW] abriendo ventana nueva", { urlToOpen });
        return clients.openWindow(urlToOpen);
      }

      console.warn("[SW] no se pudo enfocar ni abrir ventana", { urlToOpen });
    });
}
