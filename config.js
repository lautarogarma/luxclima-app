// ============================================================
//  Los datos del proyecto
// ============================================================
//  Están en un archivo aparte a propósito: es lo único que cambia entre
//  un proyecto y otro, y así actualizar la aplicación no pisa la
//  configuración ni al revés.
//
//  TODOS son PÚBLICOS por diseño. La clave `anon` viaja dentro de la
//  aplicación —cualquiera que abra la página la puede leer— y eso está
//  bien: lo que protege los datos NO es su secreto, son las políticas
//  de acceso que instala `esquema.sql` (+ `auth-externo.sql`). Sin haber
//  iniciado sesión, con la anon en la mano no se ve nada.
//
//  La que NO va acá ni en ningún otro lado del lado del cliente es la
//  `service_role`: saltea todas las políticas.
window.CFG = {
  url: "https://ofxasnprbnisbylrhksk.supabase.co",
  anon: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9meGFzbnByYm5pc2J5bHJoa3NrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0Mzc0MzEsImV4cCI6MjEwNDAxMzQzMX0.35UIHDsZzdb_1IhBnNN-CPVROGIhoOelxB2Pe6dSaSM",

  //  ── Ingreso con Auth0 (pedido del propietario, 2026-10-11) ──
  //  El ingreso —Google, correo y clave, confirmación del correo,
  //  recuperación— lo hace la página alojada de Auth0, la MISMA que ya
  //  funciona en la app de LuxHort (ver web/supabase/AUTH0.md de aquel
  //  repo). Supabase acepta sus tokens como proveedor externo; las
  //  políticas deciden quién ve qué con el `sub` del token como
  //  identidad (auth-externo.sql). Los tres valores son públicos.
  //
  //  Con cualquiera de los tres vacío la aplicación NO arranca y lo
  //  dice: publicar con esto a medias deja a todo el mundo afuera
  //  (regla aprendida en LuxHort, 2026-09-16).
  auth0: {
    //  El tenant es el mismo de LuxHort: una sola página de ingreso
    //  para las dos apps hasta que exista el tenant de producción.
    domain: "dev-egvuzr7mi0kbqtn3.us.auth0.com",
    //  Applications → LUX Clima → Settings → Client ID (NO es el de
    //  LUXHorticultura: cada app tiene el suyo, con sus URLs de retorno).
    clientId: "TI8FJ1uYBU8HXMx9YFLjsMrKIR3WIeF1",
    //  La API ya creada para LuxHort; permite todas las apps del tenant.
    //  Tiene que ser EXACTAMENTE este texto: con otro, Auth0 entrega un
    //  token opaco que Supabase no puede verificar.
    audience: "https://luxhort-nube",
  },
};
