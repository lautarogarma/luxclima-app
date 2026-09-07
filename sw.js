// ============================================================
//  El trabajador de servicio
// ============================================================
//  Hace que la aplicacion ABRA sin internet. No hace que muestre datos
//  viejos como si fueran nuevos: el estado NUNCA se cachea.
//
//  Esa distincion es todo el diseno de este archivo. Una aplicacion de
//  control que guarda la ultima lectura y la muestra al abrir sin
//  conexion es peor que una que no abre: quien la mira decide sobre un
//  numero de hace seis horas creyendo que es de ahora.
//
//  Se cachea el CASCARON -la pagina, los estilos, el guion- que no
//  cambia y no dice nada sobre la sala. Los datos se piden siempre a la
//  red, y si no hay red la interfaz lo dice con el velo.
const CACHE = "clima-v1";
const CASCARON = ["./index.html", "./config.js", "./manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CASCARON))
                    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  // Se borran las versiones viejas: dos cascarones conviviendo hacen que
  // la aplicacion abra a veces vieja y a veces nueva, sin patron.
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);

  //  Todo lo que sea de Supabase va DERECHO A LA RED, siempre. Es el
  //  estado de la sala: cachearlo seria exactamente el error que este
  //  archivo existe para no cometer.
  if (url.hostname.endsWith(".supabase.co")) return;

  //  Solo el cascaron, y solo lo propio.
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      // Se guarda una copia para la proxima, sin bloquear la respuesta.
      const copia = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copia)).catch(() => {});
      return res;
    }).catch(() => caches.match("./index.html")))
  );
});
