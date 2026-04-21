// public/sw.js
const API_BASE_URL = "https://taxiapp-valles.onrender.com";
// 1. ESCUCHAR LA NOTIFICACIÓN PUSH
self.addEventListener("push", (event) => {
  let data = {};

  if (event.data) {
    try {
      data = event.data.json();
      // Extraemos la info si viene anidada en 'notification'
      if (data.notification) {
        data = { ...data.notification, ...data };
      }
    } catch {
      data = { body: event.data.text() };
    }
  }

  // Extraemos emails de la data del backend para las acciones
  const emailPasajero = data.data?.emailPasajero || "";
  const emailTaxista = data.data?.emailTaxista || "";

  const options = {
    body: data.body || "Tienes un nuevo servicio pendiente",
    icon: "/taxista.png",
    badge: "/taxista.png",
    vibrate: [500, 100, 500, 100, 500, 100, 800],
    tag: "servicio-taxi",
    renotify: true,
    data: {
      url: data.url || (data.data && data.data.url) || "/taxista",
      emailPasajero: emailPasajero,
      emailTaxista: emailTaxista,
    },
    // 🚩 ACCIONES: Botones directos en la notificación
    actions: [
      { action: "aceptar", title: "✅ ACEPTAR VIAJE" },
      { action: "rechazar", title: "❌ IGNORAR" },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || "🚕 Nuevo Servicio",
      options,
    ),
  );
});

// 2. GESTIONAR EL CLICK Y LAS ACCIONES
self.addEventListener("notificationclick", (event) => {
  const notification = event.notification;
  const action = event.action; // Puede ser 'aceptar', 'rechazar' o vacío (clic normal)
  const notificationData = notification.data;

  notification.close();

  // --- LÓGICA DE ACCIÓN: ACEPTAR ---
  if (action === "aceptar") {
    const apiPromise = fetch(`${API_BASE_URL}/api/accept-trip-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taxistaEmail: notificationData.emailTaxista,
        pasajeroEmail: notificationData.emailPasajero,
      }),
    })
      .then(() => abrirOEnfocarApp("/taxista"))
      .catch((err) => {
        console.error("Error al aceptar vía Push:", err);
        return abrirOEnfocarApp("/taxista");
      });

    event.waitUntil(apiPromise);
    return;
  }

  // --- LÓGICA DE ACCIÓN: RECHAZAR O CLIC NORMAL ---
  // Si rechaza, no hacemos fetch, solo abrimos la app (o no hacemos nada)
  // En este caso, por UX, abriremos la app en /taxista para que vea su estado
  event.waitUntil(abrirOEnfocarApp(notificationData.url || "/taxista"));
});

// --- FUNCIÓN AUXILIAR: FOCO INTELIGENTE ---
function abrirOEnfocarApp(targetPath) {
  const urlToOpen = new URL(targetPath, self.location.origin).href;

  return clients
    .matchAll({
      type: "window",
      includeUncontrolled: true,
    })
    .then((windowClients) => {
      for (let client of windowClients) {
        const clientUrl = new URL(client.url);

        if (clientUrl.origin === self.location.origin) {
          // Si ya está en la ruta, foco. Si no, navega.
          if (clientUrl.pathname.includes(targetPath) && "focus" in client) {
            return client.focus();
          }
          if ("navigate" in client) {
            client.navigate(urlToOpen);
            return client.focus();
          }
        }
      }
      // Si no hay pestañas abiertas de nuestra app, abre una nueva
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    });
}
