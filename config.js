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
  anon: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9meGFzbnByYm5pc2J5bHJoa3NrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg0Mzc0MzEsImV4cCI6MjEwNDAxMzQzMX0.35UIHDsZzdb_1IhBnNN-CPVROGIhoOelxB2Pe6dSaSM",

  //  ── Entrar con Google ──
  //  En FALSO hasta que el proveedor esté configurado en Supabase
  //  (Authentication → Providers → Google, con el identificador y el
  //  secreto que se sacan de la consola de Google Cloud).
  //
  //  Está apagado a propósito y no simplemente sin configurar: con el
  //  botón visible y el proveedor apagado, tocarlo saca al operador de
  //  la aplicación y lo deja en una página de error en JSON que dice
  //  «Unsupported provider». Eso no es un contratiempo menor — el que
  //  lo toca no puede saber si se rompió la aplicación, si su cuenta
  //  está mal, o si tiene que hacer algo. Un botón que no funciona es
  //  peor que un botón que no está.
  google: false,

  //  ── Correo ──
  //  En FALSO mientras el proyecto no tenga un servidor de correo
  //  propio (SMTP). Con esto apagado, Supabase manda con su servicio de
  //  cortesía: dos correos por hora y sólo a la casilla del dueño del
  //  proyecto, así que recuperar la contraseña NO funciona para nadie
  //  más. La aplicación lo dice en vez de aparentar que se mandó.
  //
  //  Cuando se configure SMTP en Authentication → Emails, poner `true`.
  correoPropio: false
};
