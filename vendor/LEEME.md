# Bibliotecas de terceros, servidas desde la app

Por qué existe esta carpeta (auditoría integral CL-014, 2026-10-10): la
app cargaba supabase-js desde jsDelivr, sin `integrity` y sin CSP. Un CDN
comprometido habría ejecutado código con la sesión del usuario —y esa
sesión puede operar la sala—. Además, sin red la biblioteca no estaba en
el cascarón del service worker y la app quedaba en «Conectando…» muda.

Detalle que apareció al vendorizar: el paquete oficial NO trae
`supabase.min.js`. Lo que la app cargaba era una minificación que
jsDelivr generaba al vuelo — todavía menos verificable que el original.

## supabase-js 2.45.4 (MIT)

| Archivo | Origen | SHA-256 |
|---|---|---|
| `supabase.js` | `package/dist/umd/supabase.js` del paquete npm | `8596965FE918E656600A1B568D3A168F5C0D3D22A600886BB6F44A6555DB01E7` |
| `591.supabase.js` | `package/dist/umd/591.supabase.js` (stub de `ws` para Node; el navegador no lo carga, se incluye para que la ruta no dé 404) | `9C305B77DAB63DD79EB96EFAB9069366FB2255BD8731D6B862287558D2560406` |

Paquete: `https://registry.npmjs.org/@supabase/supabase-js/-/supabase-js-2.45.4.tgz`,
SHA-1 `0bcf8722f1732dfe3e4c5190d23e3938dcc689c3` — **verificado igual al
`dist.shasum` que publica el registro de npm** (2026-10-11).

## auth0-spa-js 2.26.0 (MIT)

El ingreso lo hace la página alojada de Auth0, igual que en la app de
LuxHort (pedido del propietario, 2026-10-11); esta biblioteca es el
cliente que la abre y guarda la sesión.

| Archivo | Origen | SHA-256 |
|---|---|---|
| `auth0.js` | `package/dist/auth0-spa-js.production.js` del paquete npm | `C1BBB0550A11CB412A240B52C1972D2ADD1590E3014A17479C1AC43079275B70` |

Paquete: `https://registry.npmjs.org/@auth0/auth0-spa-js/-/auth0-spa-js-2.26.0.tgz`,
SHA-1 `08376bca61da2199340bf3190c23ec6f18bb3b3a` — **verificado igual al
`dist.shasum` del registro de npm** (2026-10-11). Es además byte a byte
el mismo archivo que usa la app de LuxHort (`web/vendor/`).

Para actualizar: bajar el `.tgz` de la versión nueva, comparar su SHA-1
con `dist.shasum` del registro, extraer los mismos archivos, anotar
acá los hashes nuevos y subir `CACHE` en `sw.js`.
