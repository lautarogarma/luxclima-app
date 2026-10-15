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
//  Se cachea el CASCARON -la pagina, los estilos, el guion- que no dice
//  nada sobre la sala. Los datos se piden siempre a la red, y si no hay
//  red la interfaz lo dice con el velo.
const CACHE = "clima-v15";   // v15: el rediseño (plan de Codex, 2026-10-14). v14: el arranque sale de index.html a arranque.js (CSP, 2026-10-12)

//  El cascaron COMPLETO. Antes faltaban `app.js` y `parametros.js`, y
//  sin ellos abrir sin conexion daba una pagina en blanco: cargaba el
//  index y se quedaba sin el codigo que lo llena. Y faltaba supabase-js,
//  que venia de un CDN y este archivo ignoraba por ajeno: sin red, la
//  app quedaba en «Conectando…» muda (CL-014, 2026-10-10). Ahora es
//  propio (vendor/, con su procedencia en vendor/LEEME.md).
const CASCARON = ["./index.html", "./config.js", "./app.js", "./arranque.js",
                  "./parametros.js", "./manifest.webmanifest",
                  "./vendor/supabase.js", "./vendor/auth0.js"];

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

  //  RED PRIMERO, cache como respaldo.
  //
  //  Al reves -cache primero- la aplicacion nunca se actualiza sola: una
  //  vez guardado, `app.js` se sirve del cache para siempre y el unico
  //  modo de renovarlo es acordarse de cambiar el nombre del cache en
  //  cada publicacion. Eso ya fallo: se publico un arreglo de la agenda
  //  que no le habria llegado a nadie que ya hubiera abierto la app.
  //
  //  Con red primero el que tiene internet corre SIEMPRE la version de
  //  hoy, y el que no la tiene abre igual con la ultima que vio. Cuesta
  //  unos milisegundos de mas al abrir; es un tablero de control, no una
  //  portada.
  e.respondWith(
    fetch(e.request).then(res => {
      //  Sólo se guarda lo que salió BIEN: guardar un 404 o un 500 dejaba
      //  ese error como «última versión» para abrir sin red (auditoría
      //  integral 2026-10-10).
      if (res.ok) {
        const copia = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copia)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(e.request)
                         .then(hit => hit || caches.match("./index.html")))
  );
});
