// JR Prestamito - Service Worker (beta v1)
// Permite abrir la app sin internet. Los datos viven en localStorage del teléfono;
// este archivo solo guarda en caché la propia app y las librerías de Excel/PDF.
// Para forzar que todos los teléfonos bajen una versión nueva, cambia CACHE_VERSION.
const CACHE_VERSION = "jrp-beta-v1";
const LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
];
const ESPERA_RED_MS = 4000; // si la red tarda más, se usa la copia guardada

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try { await cache.add(new Request("./", { cache: "reload" })); } catch (e) {}
    for (const url of LIBS) {
      try {
        const resp = await fetch(url, { mode: "no-cors" });
        await cache.put(url, resp);
      } catch (e) {}
    }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const claves = await caches.keys();
    await Promise.all(claves.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function conTiempo(promesa, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promesa.then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); reject(e); });
  });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // La app (index.html): primero la red, para tener siempre la última versión;
  // sin internet (o con red muy lenta) usa la copia guardada.
  if (req.mode === "navigate" || (url.origin === self.location.origin && url.pathname.endsWith("/index.html"))) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      try {
        const resp = await conTiempo(fetch(req), ESPERA_RED_MS);
        if (resp && resp.ok) cache.put("./", resp.clone());
        return resp;
      } catch (e) {
        return (await cache.match("./")) || (await cache.match(req)) || Response.error();
      }
    })());
    return;
  }

  // Librerías de Excel y PDF: copia guardada primero, se actualiza en segundo plano.
  if (url.hostname === "cdnjs.cloudflare.com") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_VERSION);
      const guardada = await cache.match(req);
      const red = fetch(req).then(r => { cache.put(req, r.clone()); return r; }).catch(() => null);
      return guardada || (await red) || Response.error();
    })());
    return;
  }
  // Todo lo demás (licencia en Supabase, sincronización, WhatsApp) pasa directo a la red.
});
