// 1. ESCUCHAR LA NOTIFICACIÓN PUSH
self.addEventListener("push", (event) => {
  let data = {};

  // 🚩 Mejora: Manejo de datos más robusto
  if (event.data) {
    try {
      data = event.data.json();
      // Si el backend envió el objeto envuelto en 'notification', lo extraemos
      if (data.notification) {
        data = { ...data.notification, ...data };
      }
    } catch {
      // Si no es JSON (es texto plano), lo guardamos como body
      data = { body: event.data.text() };
    }
  }

  const options = {
    body: data.body || "Tienes un nuevo servicio pendiente",
    icon: "/taxista.png",
    badge: "/taxista.png",
    vibrate: [500, 100, 500, 100, 500, 100, 800],
    data: {
      // Prioridad: data.url > data.data.url > /taxista
      url: data.url || (data.data && data.data.url) || "/taxista",
    },
    tag: "servicio-taxi", // Evita que se amontonen 20 notificaciones
    renotify: true, // Hace que el cel vibre aunque ya haya una notificación activa
  };

  event.waitUntil(
    self.registration.showNotification(
      data.title || "🚕 Nuevo Servicio",
      options,
    ),
  );
});

// 2. GESTIONAR EL CLICK (Sin 404 y con foco inteligente)
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const targetPath = event.notification.data?.url || "/taxista";
  // Esto asegura que siempre sea https://tu-app.vercel.app/taxista
  const urlToOpen = new URL(targetPath, self.location.origin).href;

  const promiseChain = clients
    .matchAll({
      type: "window",
      includeUncontrolled: true,
    })
    .then((windowClients) => {
      // 🚩 Mejora: Foco más agresivo
      for (let client of windowClients) {
        const clientUrl = new URL(client.url);
        // Si el taxista ya tiene la web abierta (en cualquier ruta de la app)
        if (clientUrl.origin === self.location.origin) {
          // Si ya está en /taxista, solo foco. Si no, redirigir y foco.
          if (clientUrl.pathname.includes("/taxista") && "focus" in client) {
            return client.focus();
          }
          if ("navigate" in client) {
            client.navigate(urlToOpen);
            return client.focus();
          }
        }
      }

      // Si no hay pestañas, abrir una nueva
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    });

  event.waitUntil(promiseChain);
});
