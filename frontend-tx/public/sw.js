// public/sw.js
const API_BASE_URL =
  self.location.hostname === "localhost"
    ? "http://localhost:3001"
    : "https://taxiapp-valles.onrender.com";

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
  // 🚨 CORRECCIÓN: Alineado con el ID 'reject_action'
  if (action === "reject_action") {
    const apiPromise = fetch(`${API_BASE_URL}/api/reject-trip-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taxistaEmail: notificationData.emailTaxista,
        pasajeroEmail: notificationData.emailPasajero,
        requestId: notificationData.requestId, // 🚨 CORRECCIÓN: Enviamos requestId al backend
      }),
    }).catch((err) => {
      console.error("❌ Error al ignorar viaje vía Push:", err);
    });

    event.waitUntil(apiPromise);
    return;
  }

  // --- CASO 2: EL TAXISTA ACEPTA EL VIAJE ---
  // 🚨 CORRECCIÓN: Alineado con el ID 'accept_action'
  if (action === "accept_action") {
    const apiPromise = fetch(`${API_BASE_URL}/api/accept-trip-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taxistaEmail: notificationData.emailTaxista,
        pasajeroEmail: notificationData.emailPasajero,
        requestId: notificationData.requestId, // 🚨 CORRECCIÓN: Enviamos requestId al backend
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Error en servidor al aceptar viaje");

        console.log("✅ Viaje pre-aceptado en BD desde el Service Worker.");

        const pEmail = encodeURIComponent(notificationData.emailPasajero || "");
        const tEmail = encodeURIComponent(notificationData.emailTaxista || "");
        const requestId = encodeURIComponent(notificationData.requestId || "");
        const targetUrl = `${self.location.origin}/taxista?pasajero=${pEmail}&taxista=${tEmail}&requestId=${requestId}&autoAccept=true`;

        return abrirOEnfocarApp(targetUrl);
      })
      .catch((err) => {
        console.error(
          "❌ Error al aceptar vía Push, redirigiendo a respaldo:",
          err,
        );

        const pEmail = encodeURIComponent(notificationData.emailPasajero || "");
        const tEmail = encodeURIComponent(notificationData.emailTaxista || "");
        return abrirOEnfocarApp(
          `${self.location.origin}/taxista?pasajero=${pEmail}&taxista=${tEmail}&requestId=${encodeURIComponent(notificationData.requestId || "")}`,
        );
      });

    event.waitUntil(apiPromise);
    return;
  }

  // --- CASO 3: CLIC NORMAL EN EL CUERPO DE LA NOTIFICACIÓN ---
  event.waitUntil(abrirOEnfocarApp(notificationData.url || "/taxista"));
});

// --- FUNCIÓN AUXILIAR: FOCO INTELIGENTE ---
function abrirOEnfocarApp(targetPath) {
  const urlToOpen = new URL(targetPath, self.location.origin).href;

  return clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((windowClients) => {
      for (let client of windowClients) {
        if (client.url === urlToOpen && "focus" in client) {
          return client.focus();
        }
      }
      for (let client of windowClients) {
        if ("navigate" in client) {
          client.navigate(urlToOpen);
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    });
}
