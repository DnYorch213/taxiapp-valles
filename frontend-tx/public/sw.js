// public/sw.js

// 1. ESCUCHAR LA NOTIFICACIÓN PUSH (Cuando llega el taxi)
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};

  const options = {
    body: data.body || "Tienes un nuevo servicio pendiente",
    icon: "/taxista.png", // Asegúrate de que este archivo exista en /public
    badge: "/taxista.png",
    // Patrón de vibración: [vibrar, pausa, vibrar, pausa...]
    // Este patrón es largo y rítmico para que parezca una llamada
    vibrate: [500, 100, 500, 100, 500, 100, 800],
    data: {
      url: data.data?.url || "/taxista",
    },
    tag: "servicio-taxi", // Agrupa notificaciones para no llenar la pantalla
    renotify: true, // Hace que vibre de nuevo si llega otra del mismo tag
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || "🚕 Nuevo Servicio",
      options,
    ),
  );
});

// 2. GESTIONAR EL CLICK (Llevar al taxista a la app)
self.addEventListener("notificationclick", (event) => {
  event.notification.close(); // Cierra la notificación al hacer clic

  // Normalizamos la URL de destino
  const urlToOpen = new URL(event.notification.data.url, self.location.origin)
    .href;

  const promiseChain = clients
    .matchAll({
      type: "window",
      includeUncontrolled: true,
    })
    .then((windowClients) => {
      // Buscamos si ya hay una pestaña de la app abierta
      for (let client of windowClients) {
        // Usamos .includes para ser flexibles con "/" o parámetros de URL
        if (client.url.includes("/taxista") && "focus" in client) {
          return client.focus();
        }
      }

      // Si la app estaba cerrada, abrimos una nueva pestaña
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    });

  event.waitUntil(promiseChain);
});
