// JR Prestamito BETA - Service Worker (v2)
// - Permite abrir la app sin internet (guarda una copia de la app y de las librerías de Excel/PDF).
// - AVISA cuando hay una versión nueva (igual que la versión PRO): la versión nueva se descarga en
//   segundo plano, pero NO se usa hasta que la persona toca "Actualizar".
// - Detecta la versión nueva comparando el CONTENIDO de index.html, así que ya no hace falta
//   acordarse de cambiar ningún número: basta con subir el index.html nuevo.
// Los datos viven en localStorage del teléfono; este archivo no los toca.
const SW_VERSION = "beta-v2";
const CACHE_APP   = "jrp-beta-app";    // la copia de la app que se está usando
const CACHE_NUEVA = "jrp-beta-nueva";  // la versión nueva ya descargada, esperando que toquen "Actualizar"
const CACHE_LIBS  = "jrp-beta-libs";   // librerías de Excel y PDF
const LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"
];
const ESPERA_RED_MS = 4000;

function conTiempo(promesa, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    promesa.then(r => { clearTimeout(t); resolve(r); }, e => { clearTimeout(t); reject(e); });
  });
}
function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }

// Copia "limpia" de la página (sin marca de redirección, que el navegador no acepta al servirla).
async function limpia(resp) {
  const blob = await resp.clone().blob();
  return new Response(blob, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}
async function huella(resp) {
  const buf = await resp.clone().arrayBuffer();
  const h = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function avisar(tipo) {
  const lista = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  lista.forEach(c => c.postMessage({ tipo: tipo }));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cApp = await caches.open(CACHE_APP);
    // Solo si todavía no hay copia de la app. Si ya había una, se conserva: la versión nueva
    // se detecta y se ofrece con el aviso "Actualizar", no se cambia a escondidas.
    if (!(await cApp.match("./"))) {
      try { await cApp.put("./", await limpia(await fetch(new Request("./", { cache: "reload" })))); } catch (e) {}
    }
    const cLibs = await caches.open(CACHE_LIBS);
    for (const url of LIBS) {
      try { await cLibs.put(url, await fetch(url, { mode: "no-cors" })); } catch (e) {}
    }
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const validas = [CACHE_APP, CACHE_NUEVA, CACHE_LIBS];
    const claves = await caches.keys();
    // Solo borra copias viejas DE ESTA app (jrp-beta-...), no las de otras apps del mismo sitio (ej. la PRO).
    await Promise.all(claves.filter(k => k.startsWith("jrp-beta-") && !validas.includes(k)).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Revisa si hay una versión nueva de index.html. Si la hay, la deja descargada y avisa a la app.
let revisando = false;
async function revisar() {
  if (revisando) return;
  revisando = true;
  try {
    const cApp = await caches.open(CACHE_APP);
    let resp = null;
    try { resp = await conTiempo(fetch(new Request("./", { cache: "no-store" })), 8000); } catch (e) {}
    if (resp && resp.ok) {
      const actual = await cApp.match("./");
      if (!actual) {                         // primera vez: se guarda y listo
        await cApp.put("./", await limpia(resp));
        await caches.delete(CACHE_NUEVA);
        return;
      }
      if ((await huella(resp)) === (await huella(actual))) {   // es la misma: no hay nada nuevo
        await caches.delete(CACHE_NUEVA);
        return;
      }
      const cNueva = await caches.open(CACHE_NUEVA);
      await cNueva.put("./", await limpia(resp));
      await avisar("jr-nueva-version");
    } else {
      // Sin internet: si ya había una versión nueva descargada que no se ha aplicado, se vuelve a avisar.
      const cNueva = await caches.open(CACHE_NUEVA);
      if (await cNueva.match("./")) await avisar("jr-nueva-version");
    }
  } finally { revisando = false; }
}

// La persona tocó "Actualizar": la copia nueva pasa a ser la que se usa y la app se recarga.
async function aplicar(origen) {
  const cApp = await caches.open(CACHE_APP);
  const cNueva = await caches.open(CACHE_NUEVA);
  const nueva = await cNueva.match("./");
  if (nueva) {
    await cApp.put("./", nueva.clone());
    await caches.delete(CACHE_NUEVA);
  }
  if (origen) origen.postMessage({ tipo: "jr-aplicada" }); else await avisar("jr-aplicada");
}

self.addEventListener("message", (event) => {
  const d = event.data || {};
  if (d.tipo === "jr-buscar") event.waitUntil(revisar());
  else if (d.tipo === "jr-aplicar") event.waitUntil(aplicar(event.source));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // La app (index.html): se usa la copia guardada (abre rápido y sin internet) y, en segundo plano,
  // se revisa si hay una versión nueva para avisar. Si no hay copia, va a la red.
  if (req.mode === "navigate" || (url.origin === self.location.origin && url.pathname.endsWith("/index.html"))) {
    event.waitUntil((async () => { await esperar(1500); await revisar(); })());
    event.respondWith((async () => {
      const cApp = await caches.open(CACHE_APP);
      const guardada = await cApp.match("./");
      if (guardada) return guardada;
      try { return await conTiempo(fetch(req), ESPERA_RED_MS); } catch (e) { return Response.error(); }
    })());
    return;
  }

  // Librerías de Excel y PDF: copia guardada primero, se actualiza en segundo plano.
  if (url.hostname === "cdnjs.cloudflare.com") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_LIBS);
      const guardada = await cache.match(req);
      const red = fetch(req).then(r => { cache.put(req, r.clone()); return r; }).catch(() => null);
      return guardada || (await red) || Response.error();
    })());
    return;
  }
  // Todo lo demás (licencia en Supabase, sincronización, WhatsApp) pasa directo a la red.
});
