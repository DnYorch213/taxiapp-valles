// public/sw.js

// 1. ESCUCHAR LA NOTIFICACIÓN PUSH
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    console.error("Error parseando JSON del push:", e);
  }

  const options = {
    body: data.body || "Tienes un nuevo servicio pendiente",
    icon: "/taxista.png",
    badge: "/taxista.png",
    vibrate: [500, 100, 500, 100, 500, 100, 800],
    data: {
      // 🛠️ IMPORTANTE: Guardamos la URL directamente para que notificationclick la encuentre
      url: data.data?.url || data.url || "/taxista",
    },
    tag: "servicio-taxi",
    renotify: true,
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || "🚕 Nuevo Servicio",
      options,
    ),
  );
});

// 2. GESTIONAR EL CLICK (Refactorizado para evitar 404)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  // 🛠️ VALIDACIÓN: Si no hay URL en data, usamos /taxista por defecto
  const targetPath = event.notification.data?.url || "/taxista";

  // Construimos la URL absoluta (ej. https://tu-app.vercel.app/taxista)
  const urlToOpen = new URL(targetPath, self.location.origin).href;

  const promiseChain = clients
    .matchAll({
      type: "window",
      includeUncontrolled: true,
    })
    .then((windowClients) => {
      // Intentar reutilizar pestaña abierta
      for (let client of windowClients) {
        try {
          const clientPath = new URL(client.url).pathname;
          if (clientPath.includes("/taxista") && "focus" in client) {
            return client.focus();
          }
        } catch (e) {
          console.error("Error validando URL del cliente:", e);
        }
      }

      // Si no hay pestañas abiertas, abrir una nueva
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    });

  event.waitUntil(promiseChain);
});
