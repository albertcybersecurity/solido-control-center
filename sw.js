// Service Worker de Sólido Control Center.
// Su único trabajo es recibir las notificaciones push que manda la Edge
// Function "send-push-notification" y mostrarlas, incluso si el navegador
// está cerrado o en segundo plano. No cachea nada de la app (no es un PWA
// offline), así que cada visita sigue cargando la versión más reciente.

self.addEventListener("install", (event) => {
  // Activar la nueva versión del service worker de inmediato, sin esperar a
  // que se cierren las demás pestañas abiertas.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "Sólido Control", body: event.data ? event.data.text() : "Tienes una notificación nueva." };
  }

  const title = data.title || "Sólido Control";
  const options = {
    body: data.body || "Tienes una notificación nueva.",
    icon: "assets/solido-logo.jpeg",
    badge: "assets/solido-logo.jpeg",
    // Mismo esquema de "tag" que usa app.js para el aviso que llega por Realtime
    // mientras la pestaña está abierta: si ambos caminos llegan casi juntos, el
    // segundo reemplaza al primero en la bandeja del sistema en vez de duplicarse.
    tag: data.id ? `solido-activity-${data.id}` : (data.tag || "solido-notification"),
    renotify: true,
    data: {
      url: data.url || "./",
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "./";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) client.navigate(targetUrl);
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
