// public/sw.js
const API_BASE_URL =
  self.location.hostname === "localhost"
    ? "http://localhost:3001"
    : "https://taxiapp-valles.onrender.com";

// 1. ESCUCHAR LA NOTIFICACIÓN PUSH
self.addEventListener("push", (event) => {
  let rawData = {};

  if (event.data) {
    try {
      rawData = event.data.json();
    } catch {
      rawData = { notification: { body: event.data.text() } };
    }
  }

  // Normalizamos de dónde viene la información (raíz o dentro de .notification)
  const notificationDetails = rawData.notification || rawData || {};
  const customData = rawData.data || notificationDetails.data || {};

  const emailPasajero = customData.emailPasajero || "";
  const emailTaxista = customData.emailTaxista || "";
  const fallbackUrl = customData.url || "/taxista";

  const options = {
    body: notificationDetails.body || "Tienes un nuevo servicio pendiente 🚕",
    icon: "/taxista.png",
    badge: "/taxista.png",
    vibrate: [500, 100, 500, 100, 500, 100, 800],
    tag: "servicio-taxi",
    renotify: true,
    data: {
      url: fallbackUrl,
      emailPasajero: emailPasajero,
      emailTaxista: emailTaxista,
    },
    // Botones directos en la notificación
    actions: [
      { action: "aceptar", title: "✅ ACEPTAR VIAJE" },
      { action: "rechazar", title: "❌ IGNORAR" },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(
      notificationDetails.title || "🚕 Nuevo Servicio Disponible",
      options,
    ),
  );
});

// 2. GESTIONAR EL CLICK Y LAS ACCIONES
self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const action = event.action; // 'aceptar', 'rechazar' o '' (clic normal)
  const notificationData = notification.data || {};

  notification.close();

  // --- CASO 1: EL TAXISTA RECHAZA EL VIAJE ---
  if (action === "rechazar") {
    console.log(
      `ℹ️ Viaje ignorado por el taxista: ${notificationData.emailTaxista}`,
    );
    // No abrimos la app, simplemente cerramos (ya se hizo arriba) y terminamos
    return;
  }

  // --- CASO 2: EL TAXISTA ACEPTA EL VIAJE ---
  if (action === "aceptar") {
    const apiPromise = fetch(`${API_BASE_URL}/api/accept-trip-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taxistaEmail: notificationData.emailTaxista,
        pasajeroEmail: notificationData.emailPasajero,
      }),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Error en servidor al aceptar viaje");

        console.log("✅ Viaje pre-aceptado en BD desde el Service Worker.");

        // 🚀 CONSTRUCCIÓN BLINDADA: Usamos el origen del propio Service Worker
        // Esto asegura que apunte a http://localhost:5173/taxista en local
        // y a https://tu-frontend.onrender.com/taxista en producción automáticamente.
        const pEmail = encodeURIComponent(notificationData.emailPasajero || "");
        const tEmail = encodeURIComponent(notificationData.emailTaxista || "");

        const targetUrl = `${self.location.origin}/taxista?pasajero=${pEmail}&taxista=${tEmail}&autoAccept=true`;

        return abrirOEnfocarApp(targetUrl);
      })
      .catch((err) => {
        console.error(
          "❌ Error al aceptar vía Push, redirigiendo a respaldo:",
          err,
        );

        // Respaldo seguro en caso de falla: igual intentamos mandarlo con los parámetros
        const pEmail = encodeURIComponent(notificationData.emailPasajero || "");
        const tEmail = encodeURIComponent(notificationData.emailTaxista || "");
        return abrirOEnfocarApp(
          `${self.location.origin}/taxista?pasajero=${pEmail}&taxista=${tEmail}`,
        );
      });

    event.waitUntil(apiPromise);
    return;
  }

  // --- CASO 3: CLIC NORMAL EN EL CUERPO DE LA NOTIFICACIÓN ---
  // El taxista solo pulsó la alerta para ver de qué se trata sin decidir aún
  event.waitUntil(abrirOEnfocarApp(notificationData.url || "/taxista"));
});

// --- FUNCIÓN AUXILIAR: FOCO INTELIGENTE ---
function abrirOEnfocarApp(targetPath) {
  // Asegura que la URL sea absoluta usando el origen actual si viene relativa
  const urlToOpen = new URL(targetPath, self.location.origin).href;

  return clients
    .matchAll({ type: "window", includeUncontrolled: true })
    .then((windowClients) => {
      // 1. Si hay una pestaña abierta en esa URL exacta, le damos foco
      for (let client of windowClients) {
        if (client.url === urlToOpen && "focus" in client) {
          return client.focus();
        }
      }
      // 2. Si hay una pestaña de la app abierta pero en otra ruta, la redirigimos
      for (let client of windowClients) {
        if ("navigate" in client) {
          client.navigate(urlToOpen);
          return client.focus();
        }
      }
      // 3. Si la app estaba completamente cerrada, abrimos una nueva ventana
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    });
}
