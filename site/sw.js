// EurekaScout service worker. It never serves an old copy of the site: every page and every NEAR read goes
// to the network as normal. It only steps in when there is no connection at all, to show a small offline page.
const CACHE = "es-offline-v1";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/offline.html", "/img/icon-192.png"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;            // images, scripts and NEAR calls: straight to the network
  e.respondWith(fetch(e.request).catch(() => caches.match("/offline.html")));
});
