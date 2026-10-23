/* FirePulse service worker: shows alerts pushed by the server and opens
   the app at the right fire or place when one is tapped. It doesn't
   cache anything; the map needs live data. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "FirePulse", body: event.data ? event.data.text() : "" };
  }
  const urgent = data.severity === "urgent";
  event.waitUntil(
    self.registration.showNotification(data.title || "FirePulse", {
      body: data.body || "",
      tag: data.tag || undefined,
      // A newer alert for the same fire replaces the old one, but still buzzes.
      renotify: Boolean(data.tag),
      requireInteraction: urgent,
      icon: "/icons/icon-192.png",
      badge: "/icons/badge-96.png",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin === target.origin) {
          await client.focus();
          client.postMessage({ type: "open", url: target.pathname + target.search });
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
