// ============================================================
//  Los dos datos del proyecto
// ============================================================
//  Están en un archivo aparte a propósito: es lo único que cambia entre
//  un proyecto y otro, y así actualizar la aplicación no pisa la
//  configuración ni al revés.
//
//  Los dos son PÚBLICOS por diseño. La clave `anon` viaja dentro de la
//  aplicación —cualquiera que abra la página la puede leer— y eso está
//  bien: lo que protege los datos NO es su secreto, son las políticas
//  de acceso que instala `esquema.sql`. Sin haber iniciado sesión, con
//  la anon en la mano no se ve nada.
//
//  La que NO va acá ni en ningún otro lado del lado del cliente es la
//  `service_role`: saltea todas las políticas.
window.CFG = {
  url: "https://ofxasnprbnisbylrhksk.supabase.co",

  // ⚠️  PEGAR ACÁ la clave `anon` / `publishable`.
  //     Project Settings → API → Project API keys → anon public
  //     Es un texto largo (~200 caracteres) que empieza con "eyJ".
  anon: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9meGFzbnByYm5pc2J5bHJoa3NrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0Mzc0MzEsImV4cCI6MjEwNDAxMzQzMX0.35UIHDsZzdb_1IhBnNN-CPVROGIhoOelxB2Pe6dSaSM",
};
