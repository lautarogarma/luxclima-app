// ============================================================
//  El arranque de la app: el ingreso, las salas y la navegación
// ============================================================
//  Vivía EMBEBIDO en index.html. Se mudó acá el 2026-10-12 sin cambiar
//  una línea, para poder declarar la política de contenido de LuxHort
//  (`script-src 'self'`): con ella, un script embebido no corre — y la
//  app quedaba en blanco, lo mostró tools/humo_csp.py en Chrome. Las
//  pruebas (prueba-salas.js, prueba-panel.js) recortan sus secciones de
//  este archivo con los mismos comentarios-marca que antes.
"use strict";
const _$ = id => document.getElementById(id);
const _ver = (el, s) => el && el.classList.toggle("oculto", !s);

// ── Sin configuración completa no se arranca ──────────────────
//  La de Auth0 cuenta igual que la anon: con el ingreso a medias, el
//  botón «Ingresar» tiraría un error de Auth0 en inglés que no es de
//  nadie (regla aprendida en LuxHort, 2026-09-16).
const A0 = (window.CFG && CFG.auth0) || {};
if (!window.CFG || !CFG.anon || !A0.domain || !A0.clientId || !A0.audience) {
  _ver(_$("sinconfig"), true);
  _$("sub").textContent = "Sin configurar";
  throw new Error("falta configuracion (anon o auth0) en config.js");
}

// ── La cuenta la maneja Auth0; los datos, Supabase ─────────────
//  Mismo esquema que la app de LuxHort (web/nube.js de aquel repo, y
//  su AUTH0.md): el ingreso es una navegación a la página alojada de
//  Auth0 y de vuelta; Supabase recibe el ID token por `accessToken` y
//  sus políticas deciden con el `sub` como identidad (auth-externo.sql).
//  Con esa opción el módulo de cuentas propio de supabase-js queda
//  apagado: acá no existe más `cliente.auth`.

//  A dónde vuelve Auth0 después de entrar o salir: esta misma página,
//  sin query ni hash. Se le saca el «index.html» final a propósito:
//  Auth0 compara el retorno letra por letra contra su lista blanca
//  (anotada con barra final), y entrar por un favorito o la PWA
//  instalada puede traer la URL con `index.html` — en LuxHort eso mató
//  el ingreso el 2026-09-21 con «Callback URL mismatch».
const RETORNO = location.origin + location.pathname.replace(/index\.html?$/i, "");

//  El cliente se crea una vez y es asíncrono: todo lo que lo usa espera
//  esta promesa. `localstorage` para que la sesión sobreviva a cerrar
//  la pestaña (y a la PWA instalada); refresh tokens para renovarla sin
//  iframes ocultos.
const auth0Listo = window.auth0.createAuth0Client({
  domain: A0.domain,
  clientId: A0.clientId,
  cacheLocation: "localstorage",
  useRefreshTokens: true,
  authorizationParams: {
    redirect_uri: RETORNO,
    audience: A0.audience,
    ui_locales: "es",
  },
});

//  El token que viaja a Supabase en cada consulta. Es el ID TOKEN, no
//  el access token: Auth0 quita en silencio los claims sin namespace de
//  los access tokens, y el `role` que pone la acción post-login
//  viajaría vacío. getTokenSilently() va primero igual: es lo que
//  renueva la sesión con el refresh token; pero el ID token y el access
//  token vencen por separado, así que si el ID ya venció se fuerza la
//  renovación salteando el caché. Sin sesión devuelve nulo y la
//  biblioteca manda la clave pública sola: las políticas no dejan ver
//  nada, que es lo correcto.
async function tokenAuth0() {
  const c = await auth0Listo;
  try {
    await c.getTokenSilently();
    let claims = await c.getIdTokenClaims();
    if (!claims || (claims.exp || 0) * 1000 < Date.now() + 60000) {
      await c.getTokenSilently({ cacheMode: "off" });
      claims = await c.getIdTokenClaims();
    }
    return claims && claims.__raw ? claims.__raw : null;
  } catch (_) { return null; }
}

async function haySesion() {
  const c = await auth0Listo;
  //  Sin token utilizable no hay sesión, aunque el caché diga que sí:
  //  el refresh token pudo vencer o haber sido revocado.
  if (!(await c.isAuthenticated())) return false;
  return (await tokenAuth0()) !== null;
}

//  Quién está adentro: { sub, email, name }. El `sub` es la identidad
//  que ven las políticas de la base (usuario_id de `miembros`).
async function quienSoy() {
  const c = await auth0Listo;
  try { return (await c.getUser()) || null; } catch (_) { return null; }
}

//  La vuelta desde la página de Auth0. Devuelve nulo si no venimos de
//  ahí o si entró bien, o el texto del rechazo. Deja la URL limpia en
//  los dos casos: el `code` es de un solo uso y recargar con él en la
//  barra daría un error que no es de nadie.
async function procesarRetorno() {
  const q = new URLSearchParams(location.search);
  if (!q.has("code") && !q.has("error")) return null;
  let error = null;
  if (q.has("error")) {
    error = traducirIngreso(q.get("error"), q.get("error_description"));
  } else {
    try {
      const c = await auth0Listo;
      await c.handleRedirectCallback();
    } catch (e) {
      error = traducirIngreso(e.error, e.error_description || e.message);
    }
  }
  history.replaceState(null, "", location.pathname);
  return error;
}

//  Los rechazos de Auth0 vienen como código + descripción en inglés. La
//  acción post-login del tenant rechaza con «correo_sin_confirmar» a
//  quien todavía no abrió el correo de confirmación.
function traducirIngreso(codigo, desc) {
  const d = String(desc || "");
  if (/correo_sin_confirmar/.test(d))
    return "Te mandamos un correo para confirmar tu cuenta. Abrí el enlace que trae y volvé a tocar Ingresar.";
  if (codigo === "access_denied")  return "No se pudo entrar: " + (d || "acceso denegado");
  if (codigo === "unauthorized")   return "Esta cuenta no tiene acceso: " + (d || "");
  if (codigo === "invalid_state" || /state/i.test(d))
    return "El ingreso venció o se abrió en otra pestaña: tocá Ingresar de nuevo.";
  if (/Failed to fetch|NetworkError/i.test(d)) return "Sin internet";
  return d || codigo || "No se pudo entrar";
}

//  Se llama `cliente` y no `sb`: `app.js` ya declara un `sb` en el
//  mismo ambito global, y dos declaraciones del mismo nombre hacen que
//  este bloque entero NO COMPILE. El sintoma es brutal para lo tonto
//  que es la causa: la pagina se queda en «Conectando...» sin un solo
//  mensaje en consola, porque el error es de parseo y ocurre antes de
//  que corra nada.
const cliente = supabase.createClient(CFG.url, CFG.anon, { accessToken: tokenAuth0 });
LuxApp.init(cliente);

let equipoAbierto = false;
//  Con una sola sala se entra derecho al arrancar: es el caso de todos
//  los días. Pero si la persona vuelve al índice A PROPÓSITO -tocando
//  «‹ Salas»- esa comodidad se convierte en un candado: el botón la
//  saca de la sala, `cargarEquipos()` corre nomás vuelve a ver una sola
//  sala vinculada, y la reabría en el acto. Para quien toca el botón,
//  no pasaba nada: la lista aparecía y se cerraba sola.
//  Esta bandera, una vez en verdadero, apaga esa comodidad por el
//  resto de la sesión.
let volvioASalas = false;

// ── Ingreso ────────────────────────────────────────────────────
function msg(t, clase) {
  const m = _$("msg-ingreso");
  m.textContent = t;
  m.className = "sub " + (clase || "");
}

//  «Ingresar» manda a la página de Auth0. No vuelve: la página cambia.
_$("btn-entrar").onclick = async () => {
  const b = _$("btn-entrar");
  b.disabled = true; b.textContent = "Abriendo el ingreso…";
  try { await (await auth0Listo).loginWithRedirect(); }
  catch (e) {
    msg(traducirIngreso(e.error, e.message), "err");
    b.disabled = false; b.textContent = "Ingresar";
  }
};

//  Cierra la sesión acá Y en Auth0, y vuelve a esta página limpia.
_$("btn-salir").onclick = async () => {
  const c = await auth0Listo;
  await c.logout({ logoutParams: { returnTo: RETORNO } });
};

// ── Sesión ─────────────────────────────────────────────────────
//  Con Auth0 no hay `onAuthStateChange`: la sesión sólo cambia al
//  volver de la página de ingreso (se procesa acá abajo) o al tocar
//  «Cerrar sesión» (que recarga). La renovación del token es silenciosa
//  y no mueve la interfaz.
let cargando = null;
let yoMismo  = null;   // { sub, email } — lo usa «Personas y permisos»

async function arrancar(dentro) {
  _ver(_$("ingreso"), !dentro);
  if (!dentro) {
    _ver(_$("equipos"), false);
    _ver(_$("sala"), false);
    document.body.classList.remove("con-navinf");
    _$("sub").textContent = "Entrá para ver tus salas";
    return;
  }
  yoMismo = await quienSoy();
  const correo = (yoMismo && yoMismo.email) || "";
  _$("sub").textContent = correo;
  const quien = _$("cuenta-correo");
  if (quien) quien.textContent = correo ? "Entraste como " + correo : "";
  //  El perfil se registra en cada entrada: es lo que deja (sub, correo)
  //  en la tabla `perfiles`, de donde salen las invitaciones por correo
  //  y los avisos (auth-externo.sql). Si falla no se corta nada: la
  //  próxima entrada lo reintenta.
  try { await cliente.rpc("registrar_perfil"); } catch (_) {}
  if (equipoAbierto) return;
  _ver(_$("equipos"), true);
  cargando = (cargando || Promise.resolve()).then(cargarEquipos).catch(() => {});
  await cargando;
}

//  El arranque: si venimos de la página de Auth0 se consume el código
//  de la URL (o se muestra el motivo del rechazo), y después se decide
//  con la sesión que haya quedado.
(async () => {
  try {
    const rechazo = await procesarRetorno();
    if (rechazo) msg(rechazo, "err");
    await arrancar(await haySesion());
  } catch (e) {
    msg(traducirIngreso(null, e && e.message), "err");
    await arrancar(false);
  }
})();

// ── Las salas ──────────────────────────────────────────────────
//  Cada sala tiene su propio controlador PoE. Acá se crean, se
//  renombran, se les vincula el controlador y se borran, sin entrar al
//  panel de Supabase. Antes esta pantalla decía «se dan de alta desde
//  el panel de Supabase», que para el que instala el equipo es lo mismo
//  que decirle que no se puede.

//  Todo texto que venga de la base o de un mensaje de error se pone con
//  `textContent`. Concatenarlo en `innerHTML` lo convierte en un camino
//  para inyectar marcado, y el nombre de una sala lo escribe una
//  persona.
function _el(tag, clase, texto) {
  const e = document.createElement(tag);
  if (clase) e.className = clase;
  if (texto !== undefined) e.textContent = texto;
  return e;
}

function _boton(texto, alTocar, clase) {
  const b = _el("button", clase, texto);
  b.style.marginRight = "6px";
  b.onclick = alTocar;
  return b;
}

//  Un error de PostgREST trae el motivo en `message`. Mostrarlo importa:
//  «no se pudo» a secas hace que la persona repita lo mismo tres veces.
function _porQue(error, siNo) {
  const m = error && (error.message || error.hint);
  if (!m) return siNo;
  return LuxApp.enCastellano ? LuxApp.enCastellano(m) : m;
}

//  El diálogo propio vive en app.js y se usa desde acá. Reemplaza a
//  `prompt`/`alert`: los nativos cambian según navegador y sistema,
//  ignoran el tema oscuro y no dejan explicar ni validar nada.
const preguntar = o => LuxApp.dialogo(o);
const avisarModal = (titulo, texto) =>
  LuxApp.dialogo({ titulo, texto, aceptar: "Entendido", soloAceptar: true });

async function crearSala() {
  const nombre = await preguntar({
    titulo: "Nueva sala",
    texto: "Cada sala tiene su propio controlador. Después de crearla te " +
           "damos un código para vincularlo.",
    campo: "Nombre de la sala",
    aceptar: "Crear",
    validar: v => !v ? "Escribí un nombre."
                : v.length > 60 ? "Máximo 60 caracteres." : null,
  });
  if (!nombre) return;
  const { data, error } = await cliente.rpc("crear_sala", { p_nombre: nombre });
  if (error) {
    await avisarModal("No se pudo crear la sala",
                      _porQue(error, "No se pudo crear la sala."));
    return;
  }
  const fila = Array.isArray(data) ? data[0] : data;
  await cargarEquipos();
  if (fila && fila.codigo) mostrarCodigo(fila.equipo_id, fila.codigo);
}

async function renombrarSala(eq) {
  const nombre = await preguntar({
    titulo: "Renombrar «" + eq.nombre + "»",
    campo: "Nombre nuevo",
    valor: eq.nombre,
    aceptar: "Guardar",
    validar: v => !v ? "Escribí un nombre."
                : v.length > 60 ? "Máximo 60 caracteres." : null,
  });
  if (!nombre || nombre === eq.nombre) return;
  const { error } = await cliente.rpc("renombrar_sala",
    { p_equipo_id: eq.id, p_nombre: nombre });
  if (error) {
    await avisarModal("No se pudo renombrar",
                      _porQue(error, "No se pudo renombrar."));
    return;
  }
  await cargarEquipos();
  //  Si la sala renombrada es la que está abierta, el nombre del
  //  encabezado compacto se actualiza en el acto.
  const abierta = LuxApp.equipoActual();
  if (abierta && abierta.id === eq.id) {
    abierta.nombre = nombre;
    _$("sala-nombre").textContent = nombre;
  }
}

async function borrarSala(eq) {
  //  Se pide escribir el nombre y no un «¿seguro?». Borrar una sala se
  //  lleva su historial entero y no hay vuelta atrás; un botón de
  //  confirmar al lado del de borrar se aprieta solo.
  const dice = await preguntar({
    titulo: "Borrar «" + eq.nombre + "»",
    texto: "Se borra la sala con TODO su historial, sus mediciones y sus " +
           "órdenes. No hay vuelta atrás. Si sólo querés cambiar de " +
           "controlador, usá «Cambiar controlador» en vez de borrar.",
    campo: "Escribí «" + eq.nombre + "» para confirmar",
    aceptar: "Borrar para siempre",
    peligro: true,
    validar: v => v === eq.nombre ? null : "El nombre no coincide.",
  });
  if (dice !== eq.nombre) return;
  const { error } = await cliente.rpc("borrar_sala", { p_equipo_id: eq.id });
  if (error) {
    await avisarModal("No se pudo borrar", _porQue(error, "No se pudo borrar."));
    return;
  }
  await cargarEquipos();
}

async function vincular(eq) {
  const { data, error } = await cliente.rpc("codigo_de_sala",
    { p_equipo_id: eq.id });
  if (error) {
    await avisarModal("No se pudo pedir el código",
                      _porQue(error, "No se pudo pedir el código."));
    return;
  }
  const fila = Array.isArray(data) ? data[0] : data;
  if (fila && fila.codigo) mostrarCodigo(eq.id, fila.codigo);
}

//  El código se muestra grande y con el paso a paso al lado. Es el único
//  momento en que la persona tiene que copiar algo de una pantalla a
//  otra, y es donde se pierde la gente.
function mostrarCodigo(equipoId, codigo) {
  const caja = _$("codigo-" + equipoId);
  if (!caja) return;
  caja.innerHTML = "";
  //  El camino con las palabras que se ven en el equipo. Decía «en
  //  Configuración → Nube», un menú que el portal no tiene: la tarjeta se
  //  llama «Vincular a una sala» y se llega desde la página «Conexión»
  //  de la pantalla. Auditoría de interfaz, 2026-09-25.
  caja.appendChild(_el("p", "sub", "En la pantalla del controlador, página " +
    "«Conexión»: escaneá el QR, abrí la dirección que figura debajo y entrá " +
    "con el código de acceso. En la tarjeta «Vincular a una sala», escribí " +
    "este código. Vale por 30 minutos y se usa una sola vez."));
  const c = _el("b", null, codigo);
  c.style.cssText = "font-size:28px;letter-spacing:4px;display:block;" +
    "margin:8px 0;font-family:ui-monospace,monospace";
  caja.appendChild(c);
  caja.appendChild(_el("p", "sub", "Cuando el controlador lo acepte, esta " +
    "sala pasa a decir «controlador vinculado». Si el código venció, pedí " +
    "otro con el mismo botón."));
  _ver(caja, true);
}

function tarjetaSala(eq) {
  const c = _el("section", "card");
  c.style.marginBottom = "10px";

  const cab = _el("div");
  cab.style.cssText = "display:flex;justify-content:space-between;" +
    "align-items:center;gap:8px;flex-wrap:wrap";
  cab.appendChild(_el("b", null, eq.nombre));

  //  El estado se dice en palabras y no sólo con un color: una sala sin
  //  controlador se ve exactamente igual que una vinculada que todavía
  //  no reportó, y son dos problemas distintos.
  const vinculada = !!eq.serie;
  const pill = _el("span", "pill",
    vinculada ? "controlador " + eq.serie : "sin controlador");
  cab.appendChild(pill);
  c.appendChild(cab);

  const acciones = _el("div");
  acciones.style.marginTop = "10px";
  if (vinculada) {
    acciones.appendChild(_boton("Abrir", () => {
      equipoAbierto = true;
      LuxApp.abrirSala(eq);
    }, "pri"));
  }
  acciones.appendChild(_boton("Renombrar", () => renombrarSala(eq)));
  acciones.appendChild(_boton(
    vinculada ? "Cambiar controlador" : "Vincular controlador",
    () => vincular(eq)));
  acciones.appendChild(_boton("Borrar", () => borrarSala(eq)));
  c.appendChild(acciones);

  const caja = _el("div", "oculto");
  caja.id = "codigo-" + eq.id;
  caja.style.cssText = "margin-top:10px;padding:10px;border-radius:8px;" +
    "background:rgba(127,127,127,.12)";
  c.appendChild(caja);

  if (!vinculada) {
    c.appendChild(_el("p", "sub", "Esta sala todavía no tiene controlador. " +
      "Hasta que se vincule no hay mediciones ni configuración que mostrar."));
  }
  return c;
}

async function cargarEquipos() {
  const host = _$("lista-equipos");
  //  Mientras se espera, el panel DICE que está esperando. Un panel
  //  vacío durante la carga es indistinguible de uno vacío porque algo
  //  se rompió, y esa confusión fue la que costó encontrar el cerrojo.
  if (!host.innerHTML.trim() && !host.children.length)
    host.innerHTML = '<p class="sub">Buscando tus salas…</p>';

  let data, error;
  try {
    ({ data, error } = await cliente.from("equipos")
       .select("id,nombre,serie").order("nombre"));
  } catch (e) { error = e; }

  //  El DOM se arma aparte y se cambia UNA vez, al final. Vaciarlo antes
  //  de saber si hay con qué llenarlo deja un panel en blanco si algo
  //  falla en el medio, y un panel en blanco no dice nada.
  const frag = document.createDocumentFragment();

  if (error || !Array.isArray(data)) {
    host.innerHTML = "";
    host.appendChild(_el("p", "sub err",
      "No se pudo leer la lista de salas" +
      (error && error.message ? ": " + error.message : ".")));
    host.appendChild(_boton("Reintentar", () => cargarEquipos()));
    return;
  }

  if (!data.length) {
    frag.appendChild(_el("p", "sub", "Todavía no tenés ninguna sala. " +
      "Creá la primera y después vinculale su controlador."));
  }
  data.forEach(eq => frag.appendChild(tarjetaSala(eq)));

  const nueva = _boton("Nueva sala", crearSala, "pri");
  nueva.style.marginTop = "4px";
  frag.appendChild(nueva);

  host.innerHTML = "";
  host.appendChild(frag);

  //  Con una sola sala YA VINCULADA se entra derecho: es el caso de
  //  todos los días. Si no tiene controlador no se entra, porque adentro
  //  no habría nada que mirar y el que la acaba de crear necesita ver
  //  justamente el botón de vincular.
  //
  //  Y sólo si nadie pidió ver el índice a propósito. Sin `!volvioASalas`
  //  acá, tocar «‹ Salas» con una única sala vinculada abría y cerraba
  //  la lista sola: el botón volvía a traer exactamente la condición
  //  que acababa de cumplirse.
  if (data.length === 1 && data[0].serie && !equipoAbierto && !volvioASalas) {
    equipoAbierto = true;
    LuxApp.abrirSala(data[0]);
  }
}

// ── La gente de la sala ────────────────────────────────────────
//  Invitar, cambiar el rol y sacar. La cuenta se la hace cada uno en la
//  página de ingreso (Google o correo, con confirmación de verdad): acá
//  sólo se anota QUIÉN puede ver esta sala. Si la persona todavía no
//  entró nunca, la invitación queda pendiente y se activa sola en su
//  primer ingreso (auth-externo.sql). Hasta el 2026-10-11 el dueño le
//  creaba la cuenta en el servidor con una contraseña temporal; ese
//  camino murió con el ingreso propio.
//
//  Vive dentro de «Más → Personas y permisos» de la sala ya abierta,
//  y no en la tarjeta del índice: es una función de administración del
//  día a día de ESA sala, no algo que se decide antes de entrar.

const ROLES = [
  ["dueno",    "Dueño",    "Todo, más invitar gente y tocar la instalación"],
  ["operador", "Operador", "El día a día: consignas, riego, luz, alarmas"],
  ["lectura",  "Lectura",  "Ve todo y no cambia nada"],
];
const nombreRol = r => (ROLES.find(x => x[0] === r) || [r, r])[1];

async function verGente() {
  const eq = LuxApp.equipoActual();   // la sala abierta, para «Más → Gente»
  const caja = _$("gente-sala");
  if (!caja || !eq) return;
  caja.innerHTML = "";
  caja.appendChild(_el("p", "sub", "Buscando…"));

  const { data, error } = await cliente.rpc("miembros_de_sala",
    { p_equipo_id: eq.id });
  caja.innerHTML = "";
  if (error) {
    caja.appendChild(_el("p", "sub err",
      _porQue(error, "No se pudo leer quién está en la sala.")));
    return;
  }

  const lista = data || [];
  //  Sólo el dueño administra. Se averigua de la propia lista: si el
  //  que mira figura como dueño, puede. No hace falta preguntar aparte.
  //  `yoMismo.sub` es la identidad del token, la misma que guarda la
  //  base en `usuario_id` desde el ingreso con Auth0.
  const miSub = yoMismo && yoMismo.sub;
  const soyDuenio = lista.some(m => m.usuario_id === miSub &&
                                    m.rol === "dueno");

  lista.forEach(m => {
    const f = _el("div", "renglon");
    const izq = _el("div");
    izq.appendChild(_el("b", null, m.correo));
    //  Una invitación que nadie reclamó todavía se distingue: no es un
    //  miembro, es una puerta abierta a ese correo.
    izq.appendChild(_el("p", "sub", nombreRol(m.rol) +
      (m.usuario_id === miSub ? " · sos vos" : "") +
      (m.pendiente ? " · invitación pendiente: entra cuando ingrese con ese correo" : "")));
    f.appendChild(izq);

    if (soyDuenio) {
      const der = _el("div");
      der.style.cssText = "display:flex;gap:6px;align-items:center";
      if (!m.pendiente) {
        const sel = document.createElement("select");
        sel.setAttribute("aria-label", "rol de " + m.correo);
        ROLES.forEach(([v, n]) => {
          const o = document.createElement("option");
          o.value = v; o.textContent = n;
          sel.appendChild(o);
        });
        sel.value = m.rol;
        sel.onchange = () => cambiarRol(eq, m, sel);
        der.appendChild(sel);
      }
      const b = _boton(m.pendiente ? "Cancelar" : "Sacar",
                       () => sacarMiembro(eq, m), "chico");
      b.style.marginRight = "0";
      der.appendChild(b);
      f.appendChild(der);
    } else {
      f.appendChild(_el("span", "pill", nombreRol(m.rol)));
    }
    caja.appendChild(f);
  });

  if (soyDuenio) {
    const b = _boton("Invitar a alguien", () => invitar(eq), "pri");
    b.style.marginTop = "10px";
    caja.appendChild(b);
  } else {
    //  No se esconde el hecho de que existe: quien no puede tiene que
    //  ver que la función está y a quién pedírsela.
    caja.appendChild(_el("p", "sub",
      "Sólo el dueño de la sala puede invitar gente o cambiar roles."));
  }
}

async function invitar(eq) {
  const correo = await preguntar({
    titulo: "Invitar a la sala «" + eq.nombre + "»",
    texto: "La persona entra a la aplicación con su cuenta de Google o " +
           "creándose una con ese correo, y ve esta sala. Si todavía no " +
           "tiene cuenta, la invitación la espera.",
    campo: "Correo de la persona",
    aceptar: "Invitar",
    validar: v => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)
                  ? null : "Escribí un correo válido.",
  });
  if (!correo) return;

  //  El rol se elige DESPUÉS del correo y en su propio paso: es la
  //  decisión importante de las dos, y mezclarla con escribir un correo
  //  hace que se acepte la que viene puesta sin mirarla.
  //
  //  Se elige de una lista, no se teclea. Pedirle a alguien que escriba
  //  `dueno` sin eñe para dar de alta a un «Dueño» es forzarlo a conocer
  //  un identificador interno que la propia app ya conoce.
  const rol = await preguntar({
    titulo: "¿Qué va a poder hacer?",
    campo: "Rol",
    opciones: ROLES.map(([v, n, d]) => [v, n + " — " + d]),
    valor: "operador",
    aceptar: "Invitar",
  });
  if (!rol) return;

  const { data, error } = await cliente.rpc("invitar_miembro",
    { p_equipo_id: eq.id, p_correo: correo, p_rol: rol });
  if (error) {
    await avisarModal("No se pudo invitar",
                      _porQue(error, "No se pudo invitar."));
    return;
  }
  const f = Array.isArray(data) ? data[0] : data;
  await verGente();           // se refresca la lista

  await avisarModal("Listo", f && f.pendiente
      ? correo + " todavía no entró nunca: la invitación queda " +
        "esperándola. Avisale que entre a la aplicación con ese correo " +
        "(o con Google, si es su cuenta de Google) y va a ver la sala."
      : correo + " ya tenía cuenta: ya aparece en la lista de la sala.");
}

async function cambiarRol(eq, m, sel) {
  const nuevo = sel.value;
  if (nuevo === m.rol) return;
  const ok = await preguntar({
    titulo: "Cambiar el rol de " + m.correo,
    texto: "Pasa de «" + nombreRol(m.rol) + "» a «" + nombreRol(nuevo) +
           "». " + (ROLES.find(x => x[0] === nuevo) || [,, ""])[2] + ".",
    aceptar: "Cambiar",
  });
  if (!ok) { sel.value = m.rol; return; }
  const { error } = await cliente.rpc("cambiar_rol",
    { p_equipo_id: eq.id, p_usuario_id: m.usuario_id, p_rol: nuevo });
  if (error) {
    sel.value = m.rol;
    await avisarModal("No se pudo cambiar el rol",
                      _porQue(error, "No se pudo cambiar el rol."));
    return;
  }
  await verGente();
}

//  «Olvidé mi contraseña» ya no es asunto de la sala: vive en la propia
//  página de ingreso (Auth0), con el correo de recuperación de verdad.

async function sacarMiembro(eq, m) {
  const ok = await preguntar({
    titulo: m.pendiente ? "Cancelar la invitación a " + m.correo
                        : "Sacar a " + m.correo,
    texto: m.pendiente
      ? "Si esa persona entra después, no va a ver esta sala."
      : "Deja de ver esta sala y de poder operarla. Su cuenta no se " +
        "borra: puede estar en otras salas.",
    aceptar: m.pendiente ? "Cancelar invitación" : "Sacar de la sala",
    peligro: true,
  });
  if (!ok) return;
  const { error } = await cliente.rpc("quitar_miembro",
    { p_equipo_id: eq.id, p_usuario_id: m.usuario_id, p_correo: m.correo });
  if (error) {
    await avisarModal("No se pudo sacar", _porQue(error, "No se pudo sacar."));
    return;
  }
  await verGente();
}

//  Desde adentro de una sala siempre se puede volver a la lista. Sin
//  esto, el que tiene una sola sala entra derecho y no puede llegar
//  nunca a renombrarla ni a crear la segunda.
_$("btn-volver-salas").onclick = () => {
  equipoAbierto = false;
  volvioASalas = true;
  document.body.classList.remove("con-navinf");
  LuxApp.cerrarSala();
  cargarEquipos();
};

// ── Navegación inferior y «Más» ────────────────────────────────
document.querySelectorAll("#navinf button").forEach(b =>
  b.onclick = () => LuxApp.pestana(b.dataset.d));

_$("btn-ack").onclick = () => LuxApp.mandar(LuxApp.CMD.ALARMA_ACK, 0xFFFF, 0,
                                            "ack-alarmas", "reconocer las alarmas");
//  Reconocer la seguridad rearma la inyección de CO2: pregunta y dice qué
//  habilita (ver `reconocerSeguridad` en app.js).
_$("btn-ack-seg").onclick = () => LuxApp.reconocerSeguridad();
//  Silenciar pregunta antes: quien calla la sirena desde el teléfono no
//  ve si hay alguien en la sala (ver `silenciarSirena` en app.js).
_$("btn-silenciar").onclick = () => LuxApp.silenciarSirena();
_$("btn-ver-equipos").onclick = () => LuxApp.pestana("mas", "equipos");

//  Cada fila de «Más» abre su propia sub-sección, una a la vez: es una
//  lista de destinos, no un acordeón donde conviene ver dos a la vez.
function _abrirSubMas(cual) {
  ["conexion", "equipos", "gente", "instalacion", "cuenta"].forEach(k =>
    _ver(_$("mas-" + k), k === cual));
  if (cual === "gente") verGente();
}
_$("btn-mas-conexion").onclick = () => _abrirSubMas("conexion");
_$("btn-mas-equipos").onclick = () => _abrirSubMas("equipos");
_$("btn-mas-gente").onclick = () => _abrirSubMas("gente");
_$("btn-mas-instalacion").onclick = () => _abrirSubMas("instalacion");
_$("btn-mas-cuenta").onclick = () => _abrirSubMas("cuenta");

// El trabajador de servicio hace que la aplicación abra sin internet.
// Se registra sólo si la página vino por HTTPS: por HTTP el navegador lo
// rechaza, y el error en consola manda a buscar un problema que no existe.
if ("serviceWorker" in navigator && location.protocol === "https:")
  navigator.serviceWorker.register("sw.js").catch(() => {});
