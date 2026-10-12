// ============================================================
//  LuxHort Clima — la aplicación
// ============================================================
//  Todo lo que se ve y se toca en la pantalla del tablero, desde el
//  teléfono. Una sola interfaz para los dos lados: dos interfaces
//  distintas para el mismo equipo obligarían al operador a decidir a
//  cuál creerle.
//
//  ── Lo que manda ──
//  Los controles NO se escriben acá: salen de `parametros.js`, que se
//  genera desde la pantalla. Si una fila cambia de límite o de paso, la
//  app cambia con ella. Escritos dos veces divergen, y el día que
//  divergen la app deja poner un valor que el controlador recorta — y
//  el operador ve un número que no es el que puso.
//
//  ── Cómo se modifica ──
//  Un cambio desde acá es un `HMI_CMD_PARAMETRO` en la tabla de
//  comandos. El equipo lo busca, lo ejecuta por el MISMO camino que un
//  toque en el vidrio, y escribe qué pasó. No hay una vía «de la app»
//  que saltee verificaciones: esa vía tampoco existe desde el tablero.
//
//  ── Navegación (rediseño 2026-09-20, auditoría Codex) ──
//  Cuatro destinos en una barra inferior fija — Inicio / Control /
//  Historial / Más — en vez de las pestañas horizontales de antes.
//  Control agrupa los parámetros por SUBSISTEMA (Clima/CO2/Riego/Luz),
//  no por la sección textual de `parametros.js`: esa sección mezcla,
//  bajo el mismo rótulo «Que atiende cada demanda», la llave maestra de
//  CO2, la de riego y el ruteo de temperatura/humedad, que son cosas
//  distintas. `categoriaControl()` de acá abajo hace ese agrupamiento a
//  mano, por el NOMBRE semántico de `window.PAR` — nunca adivinando por
//  texto, que es exactamente el error que ya costó caro una vez (ver el
//  comentario histórico sobre «Minutos respecto de UTC» puesto en CO2).
"use strict";

const $ = id => document.getElementById(id);
const ver = (el, s) => el && el.classList.toggle("oculto", !s);

const CMD = { ACK_SEGURIDAD: 1, ALARMA_ACK: 2, ALARMA_SILENCIAR: 3,
             MANUAL_ON: 4, MANUAL_OFF: 5, PARAMETRO: 9, ASIGNAR_SALIDA: 10,
             SATURAR_SUSTRATO: 12, RESET_CONSUMO_CO2: 13,
             //  C-19 (mapa 26): MANUAL_ON con la confirmación de que se
             //  prende una luz fuera de la fase de luz.
             MANUAL_ON_NOCHE: 16 };
//  El canal va en el byte alto y el estado en el bajo, como todo
//  parámetro que habla de un canal.

//  Con tildes: acá no hay fuente que lo impida (ver `con_tildes` en
//  tools/gen_parametros.py). El orden es el del contrato.
const EQUIPOS = ["libre", "extracción", "ventilación interna",
  "aire acondicionado", "calefacción", "deshumidificador", "humidificador",
  "VÁLVULA DE CO₂", "bomba de riego", "luminarias", "sirena",
  "luz UV", "luz roja", "luz far red"];

// Con datos más viejos que esto, el número desaparece.
const VIEJO_S = 90;

let sb = null, equipoActual = null, timer = null;
let ultimoEstado = null, ultimaConfig = null;
let destinoActual = "inicio";

//  ── Qué puede hacer quien está mirando ──
//  Los roles ya existen en la base y las políticas de fila los aplican:
//  `lectura` no puede insertar un comando aunque lo intente. Lo que
//  faltaba era que la interfaz DIJERA eso, en vez de ofrecer controles
//  que la base va a rechazar — un botón que se toca y devuelve un error
//  de permisos es peor que uno que explica por qué está apagado.
//
//  `dueno` hace además de instalador: es quien da de alta la sala y
//  vincula el controlador. No se inventa un cuarto rol para eso.
let rolActual = null;
const puedeOperar = () => rolActual === "dueno" || rolActual === "operador";
const puedeInstalar = () => rolActual === "dueno";
// Comandos pedidos y todavía sin resolver, por identificador de
// parámetro. Es lo que permite marcar EL control que está esperando, y
// no un cartel general que no dice cuál.
const enVuelo = new Map();

// ------------------------------------------------------------
//  Formato — el mismo que la pantalla
// ------------------------------------------------------------
//  Los formatos vienen del firmware y significan cosas concretas: 3, 4
//  y 5 son «cero quiere decir sin límite», y mostrarlo como «0.0» haría
//  leer un límite durísimo donde no hay ninguno.
function fmtValor(v, p) {
  if (p.k === "llave") return v ? "sí" : "no";
  if (p.k === "lista") return (p.op && p.op[v] !== undefined) ? p.op[v] : String(v);
  const f = p.f || 0;
  if (f >= 3 && f <= 5 && v === 0) return "sin límite";
  if (f === 7 && v === 0) return "sin techo";
  if (f === 6 && v < 10) return "apagada";
  //  8 y 9 (2026-09-26): conductas del cultivo que se prenden con un
  //  número; el cero las apaga. «sin límite» diría lo contrario.
  if ((f === 8 || f === 9) && v === 0) return "apagado";
  if (f === 9) return (v / 10).toFixed(1);
  //  El 3 son décimas y el 5 centésimas, igual que en `pintarParam` de
  //  la pantalla. Antes caían al entero de abajo: un aviso de 18,0 °C
  //  se leía «180» y uno de VPD de 0,80 kPa, «80». La prueba sólo miraba
  //  el «sin límite». Auditoría de interfaz, 2026-09-25.
  if (f === 1 || f === 3) return (v / 10).toFixed(1);
  if (f === 5) return (v / 100).toFixed(2);
  if (f === 2) return String(Math.floor(v / 60)).padStart(2, "0") + ":" +
                      String(v % 60).padStart(2, "0");
  //  10 (2026-09-26): la hora de un pulso de riego por reloj. El bit 15
  //  dice si está activo -así lo guarda el controlador-; sin él, el pulso
  //  está apagado aunque tenga una hora vieja guardada.
  if (f === 10) return (v & 0x8000) ? fmtValor(v & 0x7FFF, { f: 2 }) : "apagado";
  //  11 (mapa 26): un borde con signo respecto de la luz principal. El
  //  cero no es «0 min», es «acompaña a la luz»; el signo, con palabras.
  if (f === 11) return v === 0 ? "con la luz"
                               : (v < 0 ? (-v) + " min antes" : v + " min después");
  return String(v);
}

//  Lo que escribe una persona, pasado a las unidades crudas del
//  parámetro. Devuelve `{ v }` o `{ error }` con el motivo en palabras.
//
//  Existe porque llegar de 400 a 1200 ppm con el «+» de a 50 son
//  dieciséis toques, y cada uno espera la confirmación del equipo -que
//  busca órdenes cada cinco segundos-: más de un minuto tocando y
//  esperando para un solo cambio. Escribir el número es una orden.
function leerValor(texto, p) {
  const f = p.f || 0;
  const t = String(texto || "").trim().toLowerCase();
  if (!t) return { error: "Escribí un valor." };
  //  «sin límite» / «sin techo» / «apagada» se escriben como cero, que es
  //  lo que significan para el equipo.
  if (/^sin\s|^apagad/.test(t) || (f === 11 && /^con/.test(t))) {
    if ((f >= 3 && f <= 5) || f === 7) return { v: 0 };
    if (f === 6 || f === 8 || f === 9 || f === 10 || f === 11) return { v: 0 };
    return { error: "Este valor no admite «" + texto.trim() + "»." };
  }
  //  11: también se escribe con palabras («30 antes», «120 después»).
  if (f === 11) {
    const m = t.match(/^(-?\d+)\s*(?:min\.?\s*)?(antes|despu[eé]s)?$/);
    if (!m) return { error: "Escribí los minutos, como «30 antes» o «120 después»." };
    let n = +m[1];
    if (m[2] === "antes") n = -Math.abs(n);
    const paso11 = p.paso || 1;
    n = Math.round(n / paso11) * paso11;
    if (n < p.min || n > p.max) {
      return { error: "Tiene que estar entre " + fmtValor(p.min, p) + " y " +
                       fmtValor(p.max, p) + "." };
    }
    return { v: n };
  }
  let crudo;
  if (f === 2 || f === 10) {
    const m = t.match(/^(\d{1,2})(?:[:.h](\d{1,2}))?$/);
    if (!m) return { error: "Escribí la hora como 08:30." };
    const h = +m[1], mi = m[2] === undefined ? 0 : +m[2];
    if (h > 23 || mi > 59) return { error: "Esa hora no existe." };
    crudo = h * 60 + mi;
  } else {
    //  Coma o punto: en el teléfono en castellano el teclado numérico
    //  trae coma.
    const n = Number(t.replace(",", "."));
    if (!isFinite(n)) return { error: "Escribí un número." };
    const escala = (f === 1 || f === 3 || f === 9) ? 10 : f === 5 ? 100 : 1;
    crudo = Math.round(n * escala);
  }
  //  Al paso más cercano: el equipo trabaja con ese paso y un valor
  //  intermedio lo recortaría distinto de lo que se escribió.
  const paso = p.paso || 1;
  crudo = Math.round(crudo / paso) * paso;
  //  10: el bit de «activo» se pone DESPUÉS de redondear los minutos. El
  //  0x8000 no es múltiplo de 15, y redondear el número entero corría la
  //  hora: «08:00» salía 08:07.
  if (f === 10) crudo = 0x8000 + crudo;
  const piso = p.piso || 0;
  if (piso && crudo !== 0 && crudo < piso) {
    return { error: "Lo más bajo con sentido es " + fmtValor(piso, p) +
                     (f === 8 || f === 9 ? ". Para apagarlo, escribí 0."
                                         : ". Para no poner límite, escribí 0.") };
  }
  if (crudo < p.min || crudo > p.max) {
    return { error: "Tiene que estar entre " + fmtValor(p.min, p) + " y " +
                     fmtValor(p.max, p) + "." };
  }
  return { v: crudo };
}

//  Los mensajes de Supabase llegan en inglés y tal cual. «Invalid login
//  credentials» en una app en castellano hace que la persona dude de si
//  el problema es la contraseña, la cuenta o la app. Se traducen los que
//  aparecen en el uso normal; lo desconocido pasa como vino, que es mejor
//  que esconderlo.
function enCastellano(mensaje) {
  const m = String(mensaje || "");
  const reglas = [
    [/invalid login credentials/i, () => "Correo o contraseña incorrectos."],
    [/email not confirmed/i, () =>
      "Falta confirmar el correo: buscá el mensaje de confirmación en tu casilla."],
    [/user already registered/i, () =>
      "Ya hay una cuenta con ese correo. Probá con «Entrar» o con «Olvidé mi contraseña»."],
    [/password should be at least (\d+)/i, r =>
      "La contraseña tiene que tener al menos " + r[1] + " caracteres."],
    [/new password should be different/i, () =>
      "La contraseña nueva tiene que ser distinta de la anterior."],
    [/only request this after (\d+) seconds?/i, r =>
      "Por seguridad, esperá " + r[1] + " segundos antes de volver a pedirlo."],
    [/rate limit/i, () =>
      "Se hicieron demasiados pedidos seguidos. Esperá unos minutos y probá de nuevo."],
    [/invalid format|unable to validate email/i, () =>
      "Ese correo no tiene un formato válido."],
    [/row-level security|permission denied/i, () =>
      "Tu rol en esta sala no permite hacer esto."],
    [/jwt expired|refresh token/i, () => "La sesión venció: volvé a entrar."],
    [/failed to fetch|networkerror|network request failed|load failed/i, () =>
      "Sin conexión con el servidor. Revisá internet y volvé a intentar."],
  ];
  for (const [re, f] of reglas) {
    const r = m.match(re);
    if (r) return f(r);
  }
  return m;
}

function siguiente(v, p, subir) {
  const paso = p.paso || 1, piso = p.piso || 0;
  if (piso) {
    if (subir && v === 0) return piso;
    if (!subir && v === piso) return 0;
    if (v === 0) return 0;
  }
  let n = v + (subir ? paso : -paso);
  if (n > p.max) n = p.max;
  if (n < p.min) n = p.min;
  return n;
}

// ------------------------------------------------------------
//  Mandar una orden
// ------------------------------------------------------------
//  Queda en la cola `comandos` y el equipo la busca. No se dispara nada
//  hacia el equipo: no acepta conexiones entrantes, y no debe. Un
//  puerto abierto hacia un controlador que maneja una válvula de gas lo
//  encuentran los buscadores de dispositivos expuestos en horas.
//
//  Se pide por `pedir_comando` y no con un INSERT (C-21, 2026-10-12; R2-001
//  y R2-002 de Codex): el servidor decide si este rol puede dar ESTA
//  orden, y pone él quién la pidió y cuándo vence. Si no puede, la causa
//  viene en castellano en el error y se muestra tal cual.
async function mandar(codigo, arg1, arg2, claveVuelo, queDice) {
  if (!equipoActual) return;

  //  Una orden por control a la vez. Sin esto, dos toques rápidos al «+»
  //  con la red lenta insertaban DOS comandos: el equipo aplicaba los
  //  dos y el operador terminaba con el doble de lo que creía haber
  //  pedido. La fila decía «enviando…» pero seguía aceptando toques,
  //  que es lo peor de los dos mundos: parece bloqueada y no lo está.
  //
  //  No se encola el segundo. Encolar «subí a 900» detrás de «subí a
  //  850» deja al operador esperando dos confirmaciones para un solo
  //  gesto, y si la primera se rechaza la segunda ya no tiene sentido.
  if (claveVuelo !== undefined && enVuelo.has(claveVuelo)) {
    aviso("Esperá la confirmación de lo anterior antes de volver a tocarlo.",
          "warn");
    return;
  }
  if (claveVuelo !== undefined)
    enVuelo.set(claveVuelo, { desde: Date.now(), dice: queDice || "" });
  pintarTodo();

  const { data, error } = await sb.rpc("pedir_comando", {
    p_equipo_id: equipoActual.id, p_codigo: codigo,
    p_arg1: arg1 | 0, p_arg2: arg2 | 0,
  });

  if (error || !data) {
    if (claveVuelo !== undefined) enVuelo.delete(claveVuelo);
    aviso("No se pudo enviar: " +
          enCastellano(error ? error.message : "el servidor no devolvió la orden"),
          "err");
    pintarTodo();
    return;
  }
  vigilar(data, claveVuelo);
}

//  Qué se pidió, para decirlo en el resultado. «Hecho.» a secas no dice
//  QUÉ se aplicó, y con dos órdenes seguidas no se sabe cuál volvió.
function queSePidio(claveVuelo) {
  const e = claveVuelo !== undefined ? enVuelo.get(claveVuelo) : null;
  return e && e.dice ? e.dice : "";
}

//  Se sigue el comando hasta que el equipo lo resuelve, y se muestra su
//  resultado CON LA CAUSA. Un «no se pudo» mudo manda a buscar cinco
//  cosas distintas a mano.
//
//  Se sigue HASTA QUE VENCE, no un minuto (auditoría integral 2026-10-10,
//  CL-013). A los 60 s decía «el equipo no la tomó: no se ejecutó, volvé
//  a intentar» con la orden todavía viva en la cola cinco minutos: si el
//  equipo la tomaba después, la ejecutaba — y el usuario ya la había
//  repetido. Dos «Saturar» eran dos saturaciones. El primer minuto se
//  mira seguido (lo normal es que se resuelva en segundos); después, más
//  espaciado, hasta pasar el vencimiento.
async function vigilar(id, claveVuelo) {
  let ultimo = "pendiente", vence = null;
  //  La sala de ESTA orden. Con la espera de hasta seis minutos, el
  //  resultado puede llegar con otra sala abierta: entonces no se avisa
  //  ni se repinta —el aviso vive dentro de la sala en pantalla y se lo
  //  atribuiría a la otra— (revisor de la tanda de app, 2026-10-11). Se
  //  compara el id y no el objeto: volver a la misma sala trae otro.
  const salaId = equipoActual && equipoActual.id;
  const misma = () => !!equipoActual && equipoActual.id === salaId;
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, i < 40 ? 1500 : 5000));
    let data = null;
    try {
      ({ data } = await sb.from("comandos")
        .select("estado,resultado,vence").eq("id", id).maybeSingle());
    } catch (e) { data = null; }
    if (!data) continue;
    ultimo = data.estado;
    if (data.vence) vence = new Date(data.vence);
    //  Pasado el vencimiento con la orden todavía pendiente, ya no puede
    //  ejecutarse: se deja de mirar y se dice eso, que ahora sí es cierto.
    if (ultimo === "pendiente" && vence && Date.now() > vence.getTime() + 5000) break;
    const dice = queSePidio(claveVuelo);
    if (data.estado === "aplicado") {
      if (claveVuelo !== undefined) enVuelo.delete(claveVuelo);
      if (!misma()) return;
      aviso(dice ? "Aplicado: " + dice + "." : "Hecho.", "ok"); refrescar(); return;
    }
    //  `indeterminado` es terminal y NO es un rechazo: el equipo se
    //  llevó la orden y nunca dijo qué pasó. Mezclarlo con «rechazado»
    //  haría creer que no se ejecutó, que es justo lo contrario de lo
    //  que hay que asumir.
    if (data.estado === "rechazado" || data.estado === "vencido" ||
        data.estado === "indeterminado") {
      if (claveVuelo !== undefined) enVuelo.delete(claveVuelo);
      const motivo = data.resultado ||
            (data.estado === "indeterminado"
              ? "El equipo la tomó y no dijo qué pasó: pudo haberse ejecutado."
              : "El equipo lo rechazó.");
      //  «No se aplicó» sólo si de verdad no se aplicó: una orden
      //  indeterminada pudo haberse ejecutado, y decir lo contrario
      //  invita a repetirla.
      const cabeza = !dice ? ""
                   : data.estado === "indeterminado" ? "«" + dice + "»: "
                   : "No se aplicó «" + dice + "»: ";
      if (!misma()) return;
      aviso(cabeza + motivo, "err");
      pintarTodo(); return;
    }
  }
  if (claveVuelo !== undefined) enVuelo.delete(claveVuelo);
  if (!misma()) return;
  //  Sin resolución. Lo que se dice depende de dónde quedó, y la
  //  diferencia es la que importa: si el equipo NO la tomó y la orden
  //  YA VENCIÓ, no pasó nada y se puede repetir; si LA TOMÓ y no contestó,
  //  la acción pudo haber ocurrido y repetirla a ciegas es peor que no
  //  mandarla; y si no se sabe si venció, se dice hasta cuándo puede
  //  ejecutarse todavía.
  const vencida = vence && Date.now() > vence.getTime();
  aviso(ultimo === "entregado"
        ? "El equipo la recibió pero no dijo qué pasó. Pudo haberse " +
          "ejecutado: verificá la sala antes de repetir."
        : vencida
        ? "El equipo no la tomó y la orden venció: no se ejecutó. Revisá " +
          "el enlace y volvé a intentar."
        : "El equipo todavía no la tomó. Puede ejecutarse hasta las " +
          //  `hhmm`, 24 h y sin depender del idioma del teléfono: con
          //  toLocaleTimeString un teléfono en inglés daba «3:45:» sin
          //  AM/PM (revisor, 2026-10-11).
          (vence ? hhmm(vence) : "—") +
          ": esperá antes de repetirla.", "err");
  pintarTodo();
}

let avisoT = null;
function aviso(t, clase) {
  const a = $("aviso");
  if (!a) return;
  a.textContent = t;
  a.className = "aviso-linea " + (clase || "");
  clearTimeout(avisoT);
  // Ocho segundos, no dos: el texto lleva la causa de un rechazo, y una
  // causa que se va antes de leerla no sirve de nada.
  avisoT = setTimeout(() => { a.textContent = ""; a.className = "aviso-linea"; }, 8000);
}

// ------------------------------------------------------------
//  Preguntar antes de hacer algo que cuesta deshacer
// ------------------------------------------------------------
//  Propio y no `confirm()`/`prompt()`. Los nativos cambian de forma
//  según navegador y sistema, ignoran el tema oscuro, no admiten
//  explicación ni validación, y en el teléfono aparecen lejos de lo que
//  los originó — con el nombre de la sala recortado, justo cuando hay
//  que escribirlo para confirmar un borrado.
//
//  Devuelve una promesa: `null` si se cancela; el texto escrito o el
//  valor elegido si pide campo u opciones, o `true` si es sólo
//  confirmar. `o.opciones` es una lista de `[valor, nombre]`: se
//  muestra el nombre y se devuelve el valor, para no obligar a nadie a
//  teclear un identificador interno.
function dialogo(o) {
  return new Promise(resolve => {
    //  Quién tenía el foco antes de abrir. Se lo devuelve al cerrar: sin
    //  esto, cancelar con Escape o con el botón deja el punto de trabajo
    //  del teclado sin dueño, porque el control que abrió el diálogo ya
    //  no está ahí y nada lo reemplaza.
    const origen = document.activeElement;

    const fondo = document.createElement("div");
    fondo.className = "modal-fondo";
    const caja = document.createElement("div");
    caja.className = "modal";
    caja.setAttribute("role", "dialog");
    caja.setAttribute("aria-modal", "true");

    const h = document.createElement("h3");
    h.textContent = o.titulo;
    //  Sin nombre, un lector de pantalla anuncia «diálogo» y nada más.
    h.id = "modal-titulo";
    caja.setAttribute("aria-labelledby", "modal-titulo");
    caja.appendChild(h);

    if (o.texto) {
      const p = document.createElement("p");
      p.className = "sub";
      p.textContent = o.texto;
      caja.appendChild(p);
    }

    let campo = null;
    if (o.opciones) {
      //  Una lista, no un campo de texto: si las opciones son fijas
      //  -un rol, un modo- pedir que se las TECLEE hace que la persona
      //  tenga que recordar un identificador interno en vez de leer un
      //  nombre. «Dueño» con eñe se escribe fácil; `dueno` sin tilde
      //  hay que acordárselo.
      const lab = document.createElement("label");
      lab.className = "sub";
      lab.textContent = o.campo;
      lab.setAttribute("for", "modal-campo");
      campo = document.createElement("select");
      campo.id = "modal-campo";
      o.opciones.forEach(([valor, nombre]) => {
        const op = document.createElement("option");
        op.value = valor; op.textContent = nombre;
        campo.appendChild(op);
      });
      campo.value = o.valor || o.opciones[0][0];
      caja.append(lab, campo);
    } else if (o.campo !== undefined) {
      const lab = document.createElement("label");
      lab.className = "sub";
      lab.textContent = o.campo;
      lab.setAttribute("for", "modal-campo");
      campo = document.createElement("input");
      campo.id = "modal-campo";
      //  Una contraseña se escribe tapada y el teléfono ofrece guardarla;
      //  un número abre el teclado numérico, que es el que corresponde.
      campo.type = o.clave ? "password" : "text";
      if (o.teclado) campo.inputMode = o.teclado;
      campo.value = o.valor || "";
      campo.autocomplete = o.clave ? "new-password" : "off";
      caja.append(lab, campo);
      if (o.ayuda) caja.appendChild(_p("sub", o.ayuda));
    }

    const err = document.createElement("p");
    err.className = "sub err";
    caja.appendChild(err);

    const fila = document.createElement("div");
    fila.className = "modal-botones";
    const cancelar = document.createElement("button");
    cancelar.textContent = "Cancelar";
    const aceptar = document.createElement("button");
    aceptar.textContent = o.aceptar || "Confirmar";
    aceptar.className = o.peligro ? "peligro" : "pri";
    //  Un aviso no se «cancela»: no hay nada que elegir. Dejar el botón
    //  de cancelar al lado de uno que hace lo mismo obliga a decidir
    //  entre dos opciones idénticas.
    if (!o.soloAceptar) fila.appendChild(cancelar);
    fila.appendChild(aceptar);
    caja.appendChild(fila);

    //  El orden real de Tab dentro del diálogo. Se arma con las
    //  referencias que ya se tienen -no con `querySelectorAll`- porque
    //  son justo los tres controles que se crearon arriba, en el orden
    //  en que quedaron en la página.
    const focoOrden = [];
    if (!o.soloAceptar) focoOrden.push(cancelar);
    if (campo) focoOrden.push(campo);
    focoOrden.push(aceptar);

    const cerrar = r => {
      document.removeEventListener("keydown", tecla);
      if (fondo.remove) fondo.remove();
      //  Se devuelve el foco a quien abrió el diálogo.
      if (origen && typeof origen.focus === "function") origen.focus();
      resolve(r);
    };
    const tecla = e => {
      if (e.key === "Escape") { cerrar(null); return; }
      if (e.key === "Enter" && campo) { aceptar.onclick(); return; }
      //  Tab atrapado DENTRO del diálogo. Sin esto, tabular desde el
      //  último botón sigue de largo hacia la página de fondo: se ve
      //  bloqueada por el overlay pero el foco de teclado igual la
      //  alcanza, y de ahí no hay vuelta al diálogo sin usar el mouse.
      if (e.key === "Tab" && focoOrden.length) {
        const i = focoOrden.indexOf(document.activeElement);
        const ultimo = focoOrden.length - 1;
        if (e.shiftKey) {
          if (i <= 0) { e.preventDefault(); focoOrden[ultimo].focus(); }
        } else if (i < 0 || i === ultimo) {
          e.preventDefault();
          focoOrden[0].focus();
        }
      }
    };
    cancelar.onclick = () => cerrar(null);
    aceptar.onclick = () => {
      if (!campo) return cerrar(true);
      //  Una contraseña NO se recorta: un espacio al final es parte de
      //  ella, y sacarlo en silencio deja a la persona afuera con la
      //  clave que cree haber puesto.
      const v = o.clave ? (campo.value || "") : (campo.value || "").trim();
      //  La validación se dice EN EL DIÁLOGO y no en un aviso que
      //  aparece después de cerrarlo: cerrar y volver a abrir pierde lo
      //  que la persona ya había escrito.
      const problema = o.validar ? o.validar(v) : (v ? null : "Escribí algo.");
      if (problema) { err.textContent = problema; campo.focus(); return; }
      cerrar(v);
    };
    fondo.onclick = e => { if (e.target === fondo) cerrar(null); };
    document.addEventListener("keydown", tecla);

    fondo.appendChild(caja);
    document.body.appendChild(fondo);
    if (campo && campo.focus) { campo.focus(); if (campo.select) campo.select(); }
    else if (aceptar.focus) aceptar.focus();
  });
}

// ------------------------------------------------------------
//  Reconocer la seguridad
// ------------------------------------------------------------
//  No es lo mismo que reconocer una alarma. El enganche de seguridad
//  se pone tras una puerta abierta, una parada de emergencia o una
//  purga, y RECONOCERLO vuelve a habilitar la inyección de CO2 apenas
//  la puerta esté cerrada y los sensores anden (`Safety::acknowledge`,
//  `HmiLink::ejecutar`). En la pantalla del tablero lo toca alguien
//  parado frente a la sala; desde el teléfono puede tocarlo alguien que
//  no ve si queda una persona adentro con la puerta cerrada. Antes era
//  un toque sin pregunta. Ahora se dice qué habilita y se pide
//  confirmarlo. Si además hay que prohibirlo desde lejos es una decisión
//  del propietario: ESTADO-Y-PROXIMOS-PASOS.md §2.8. Auditoría de
//  interfaz, 2026-09-25.
async function reconocerSeguridad() {
  const ok = await dialogo({
    titulo: "Rearmar la inyección de CO₂",
    texto: "El equipo se enganchó por seguridad (puerta, parada de " +
           "emergencia o purga). Reconocerlo vuelve a habilitar la inyección " +
           "de CO₂ en cuanto la puerta esté cerrada y los sensores anden. " +
           "Hacelo sólo si alguien confirmó EN LA SALA que no queda nadie " +
           "adentro.",
    aceptar: "Rearmar",
    peligro: true,
  });
  if (!ok) return false;
  mandar(CMD.ACK_SEGURIDAD, 0, 0, "ack-seg", "rearmar la seguridad");
  return true;
}

// ------------------------------------------------------------
//  Silenciar la sirena desde lejos
// ------------------------------------------------------------
//  Decisión del propietario, 2026-09-27 (ESTADO §2.11). La sirena avisa
//  a quien está EN la sala, y quien la calla desde el teléfono no ve si
//  hay alguien adentro: por eso pregunta antes, con esas palabras. Lo
//  que la hace aceptable es que no es un interruptor: el equipo la
//  calla SILENCIO_MAX_S (10 min) y vuelve sola si la alarma sigue o
//  empeora, y la de purga no pasa por acá (Safety la pide directo).
async function silenciarSirena() {
  const ok = await dialogo({
    titulo: "Silenciar la sirena",
    texto: "La sirena avisa a quien está EN la sala. Se calla diez " +
           "minutos y vuelve sola si la alarma sigue o empeora; la " +
           "alarma queda activa igual. Hacelo sólo si sabés que no hay " +
           "nadie adentro que dependa de ese aviso.",
    aceptar: "Silenciar 10 min",
    peligro: true,
  });
  if (!ok) return false;
  //  0xFFFF = «callar lo que suena», igual que el botón de la pantalla.
  mandar(CMD.ALARMA_SILENCIAR, 0xFFFF, 0, "silenciar", "silenciar la sirena");
  return true;
}

//  La contraseña ya no se cambia acá (2026-10-11): el ingreso lo hace
//  la página alojada de Auth0 —la misma de la app de LuxHort—, que trae
//  su propio «¿Olvidaste tu contraseña?» con correo de verdad. El
//  `cambiarClave` que vivía en este lugar murió con los formularios
//  propios.

// ------------------------------------------------------------
//  Pintado
// ------------------------------------------------------------
function edadSegundos(cuando) {
  return cuando ? (Date.now() - cuando.getTime()) / 1000 : null;
}

function pintarTodo() {
  if (!ultimoEstado) return;
  pintarInicio(ultimoEstado.d, ultimoEstado.cuando);
  pintarControl();
  pintarEquiposPanel();
}

function tarjeta(titulo) {
  const s = document.createElement("section");
  s.className = "card";
  if (titulo) {
    const h = document.createElement("h2");
    h.textContent = titulo;
    s.appendChild(h);
  }
  return s;
}

function _p(clase, texto) {
  const e = document.createElement("p");
  e.className = clase;
  e.textContent = texto;
  return e;
}

//  Armada nodo por nodo y no con innerHTML + querySelector: el mismo
//  resultado en pantalla, y la clase de riesgo del número (CL-015) queda
//  en un nodo que la prueba puede mirar.
function medida(nombre, valor, unidad, clase) {
  const d = document.createElement("div");
  const s = document.createElement("div");
  s.className = "sub";
  s.style.margin = "0";
  s.textContent = nombre;
  const v = document.createElement("div");
  v.className = "val" + (clase ? " " + clase : "");
  const num = document.createElement("span");
  num.className = "num";
  num.textContent = valor;
  const uni = document.createElement("span");
  uni.className = "uni";
  uni.textContent = " " + unidad;
  v.appendChild(num);
  v.appendChild(uni);
  d.appendChild(s);
  d.appendChild(v);
  return d;
}

// ============================================================
//  INICIO
// ============================================================
//  «hace 180 min» obliga a hacer la cuenta; «hace 3 h» no.
function haceCuanto(seg) {
  if (seg < 90) return "hace " + Math.round(seg) + " s";
  const min = Math.round(seg / 60);
  if (min < 90) return "hace " + min + " min";
  const h = Math.round(min / 60);
  if (h < 36) return "hace " + h + " h";
  return "hace " + Math.round(h / 24) + " días";
}

//  La medición es fresca con el MISMO criterio que el portal del equipo
//  (`PaginaWeb.h`): calidad útil y menos de dos minutos. Antes la app
//  miraba sólo cuándo PUBLICÓ el equipo: con los sensores caídos y el
//  controlador publicando igual, mostraba el último CO2 con la pastilla
//  «en vivo». Es exactamente el número viejo que se lee como actual y
//  que este proyecto prometió no mostrar. Auditoría de interfaz,
//  2026-09-25.
const MED_EDAD_MAX_S = 120;
function medicionFresca(m, equipoViejo) {
  if (equipoViejo || !m) return false;
  return (m.calidad | 0) >= 2 && (m.edad_s === undefined || m.edad_s <= MED_EDAD_MAX_S);
}

//  Punto de rocío, con la misma fórmula de Magnus que usa el equipo para
//  el VPD (`contrato/Psicrometria.h`: 17,27 y 237,3).
function puntoRocio(tempC, humPct) {
  if (!(humPct > 0) || tempC === undefined || tempC === null) return null;
  const g = Math.log(humPct / 100) + (17.27 * tempC) / (tempC + 237.3);
  return (237.3 * g) / (17.27 - g);
}

//  Cuánto le falta a la HOJA para mojarse: su temperatura (la del aire
//  menos el desfase de hoja que ya usa el VPD) menos el punto de rocío.
//  Con la hoja por debajo del rocío se condensa agua sobre ella, y el
//  agua libre es lo que necesita la botrytis para germinar (Punja y
//  colaboradores; ver docs/INVESTIGACION-CULTIVO-2026-09-25.md). Dos
//  grados de margen es el criterio conservador que se usa en invernadero
//  para no llegar justo: los sensores tienen ±0,8 °C y la hoja del
//  medio de la planta está más fría que la de arriba.
const CONDENSACION_MARGEN_C = 2;
function margenCondensacion(tempC, humPct, offsetHojaC10) {
  const rocio = puntoRocio(tempC, humPct);
  if (rocio === null) return null;
  return (tempC - (offsetHojaC10 || 0) / 10) - rocio;
}

//  La zona del VPD contra los límites que cargó la persona, si los
//  cargó. Los fijos de la pantalla (0,80 a 1,40 kPa) no sirven para
//  todas las etapas: en esquejes lo sano es 0,4-0,8 y en floración
//  tardía se trabaja arriba de 1,2 para no darle humedad a la botrytis.
//  Sin límites cargados se usan los fijos y se dice que son genéricos.
function zonaVpdApp(vpdKpa, cfg) {
  const P = window.PAR || {};
  const lo = cfg && cfg[P.AV_VPD_MIN] ? cfg[P.AV_VPD_MIN] / 100 : null;
  const hi = cfg && cfg[P.AV_VPD_MAX] ? cfg[P.AV_VPD_MAX] / 100 : null;
  const propios = lo !== null || hi !== null;
  const min = lo !== null ? lo : 0.8, max = hi !== null ? hi : 1.4;
  const zona = vpdKpa < min ? "bajo" : vpdKpa > max ? "alto" : "en rango";
  return { zona, min, max, propios };
}

function pintarInicio(d, cuando) {
  const seg = edadSegundos(cuando);
  const viejo = seg === null || seg > VIEJO_S;

  const p = $("sala-edad");
  p.className = "pill" + (viejo || errorRed ? "" : " on");
  //  «sin conexión» es el TELÉFONO; «sin contacto» / «hace N» es el
  //  EQUIPO. Se veían igual, y mandaban a revisar lo equivocado.
  p.textContent = errorRed
      ? "sin conexión" + (seg === null ? "" : " · último dato " + haceCuanto(seg))
      : seg === null ? "sin contacto"
      : viejo ? haceCuanto(seg) : "en vivo";

  //  El banner: lo que hay que atender antes que ningún número, y con
  //  la misma prioridad explícita que la pantalla. Apilar tres carteles
  //  hace que no se lea ninguno.
  const sg = d.seguridad || {};
  const b = $("banner");
  let tit = null, sub = null;
  //  El estado del CO₂ viaja como texto (Co2Control::stateName); los dos
  //  que importan acá empiezan siempre igual. El banner de la app cubría
  //  4 casos y el de la pantalla 6: «la válvula puede estar abierta»
  //  aparecía como un renglón más abajo, con texto crudo (auditoría
  //  integral 2026-10-10, CL-015). Mismo orden de prioridad que la
  //  pantalla (Interfaz.cpp): purga > corte > ineficaz > parada > sirena
  //  > puerta.
  const coEst = String((d.co2 && d.co2.estado) || "");
  if (sg.purga && sg.purgaOk) {
    tit = "PURGA ACTIVA — NO ENTRAR";
    sub = "Extracción forzada.";
  } else if (sg.purga) {
    tit = "PURGA NO CONFIRMADA — NO ENTRAR";
    sub = "Se ordenó y la extracción no respondió. Verificarla.";
  } else if (coEst.indexOf("CORTE NO CONFIRMADO") === 0) {
    tit = "CORTE DE VÁLVULA NO CONFIRMADO";
    sub = "El equipo no sabe en qué posición quedó la válvula de CO₂: " +
          "puede estar abierta. Verificarla físicamente.";
  } else if (coEst.indexOf("ENCLAVADO") === 0) {
    tit = "INYECCIONES SIN EFECTO";
    sub = "No subieron el CO₂: fuga, sala mal sellada o sensor equivocado. " +
          "Enclavado hasta reconocer.";
  } else if (sg.parada) {
    tit = "PARADA DE EMERGENCIA ACCIONADA";
    sub = "La inyección está cortada. Rearmar en el tablero.";
  } else if (d.sirena) {
    tit = "ALARMA SONORA ACTIVA";
    sub = "Ver la lista de avisos.";
  } else if (sg.puerta) {
    tit = "PUERTA ABIERTA";
    sub = "La inyección queda bloqueada mientras esté abierta.";
  }
  //  Un banner de un dato viejo se sigue mostrando —una emergencia no se
  //  esconde por falta de datos— pero dice de cuándo es (CL-012).
  if (tit && viejo && seg !== null) sub += " (último dato " + haceCuanto(seg) + ")";
  ver(b, !!tit);
  if (tit) { $("banner-tit").textContent = tit; $("banner-sub").textContent = sub; }

  // ── Puesta en marcha guiada ──
  pintarPuestaEnMarcha(d, viejo);

  // ── Ahora ──
  const m = d.medicion || {};
  const su = d.suelo || {};
  const host = $("medidas");
  const fresca = medicionFresca(d.medicion, viejo);
  host.innerHTML = "";
  host.classList.toggle("viejo", !fresca);
  //  Con decimales fijos: el equipo manda flotantes, y «24.370001 °C»
  //  es ruido que no agrega nada.
  const n = (x, dec) => (!fresca || x === undefined || x === null) ? "—"
                      : Number(x).toFixed(dec);
  //  El color del CO₂ dice el riesgo, con los umbrales de la pantalla:
  //  ámbar desde 1500 (límite de proceso), rojo desde 3000 (crítico).
  //  3500 ppm se veían en blanco (CL-015).
  const claseCo2 = (!fresca || m.co2 === undefined || m.co2 === null) ? null
                 : m.co2 >= 3000 ? "err" : m.co2 >= 1500 ? "warn" : null;
  host.appendChild(medida("CO₂", n(m.co2, 0), "ppm", claseCo2));
  host.appendChild(medida("Temperatura", n(m.temp, 1), "°C"));
  host.appendChild(medida("Humedad", n(m.hum, 0), "%"));
  host.appendChild(medida("VPD", n(m.vpd, 2), "kPa"));
  if (su.hay) {
    //  El sustrato lleva su nombre al lado por la misma razón que en la
    //  pantalla: su unidad es «%» igual que la humedad del aire, y dos
    //  números con el mismo símbolo se confunden.
    const leyendo = (su.leyendo || 0) > 0;
    host.appendChild(medida("Sustrato",
        (viejo || !leyendo) ? "—" : (su.hum / 10).toFixed(1), "%"));
  }

  const det = $("medidas-pie");
  const partes = [];
  let clasePie = su.discrepan ? " warn" : "";
  //  El equipo en línea pero sin medición fresca: los números se tapan
  //  (arriba) y se dice POR QUÉ, que es lo que hay que ir a revisar.
  if (!viejo && !fresca) {
    partes.push("sin medición fresca de la sala" +
      (m.edad_s ? " (la última es de " + haceCuanto(m.edad_s) + ")" : "") +
      ": revisar los sensores");
    clasePie = " err";
  }
  //  La consigna YA viene en grados y en %: el equipo divide antes de
  //  publicar (`Portal.cpp`, `temp_cons`). La app volvía a dividir y
  //  mostraba «consigna 2.6 °C · 6.0 %» con la sala en 26 °C y 60 %.
  if (m.temp_cons) partes.push("consigna " + Number(m.temp_cons).toFixed(1) + " °C");
  if (m.hum_cons)  partes.push(Number(m.hum_cons).toFixed(0) + " %");
  //  Por qué la consigna no es la cargada (R2 y R5, 2026-09-26). Sin
  //  decirlo, un deshumidificador andando con la luz prendida o un aire
  //  que enfría de más al amanecer parecen fallas.
  const cu = d.cultivo || {};
  if (cu.anticipa_hum) partes.push("humedad de noche adelantada: falta poco para apagar");
  if (cu.drop) partes.push("temperatura bajada del amanecer");
  if (fresca && m.vpd !== undefined) {
    const z = zonaVpdApp(m.vpd, ultimaConfig);
    partes.push("VPD " + z.zona + " (" + z.min.toFixed(2) + "–" + z.max.toFixed(2) +
                " kPa" + (z.propios ? ", tus límites" : ", genérico") + ")");
    if (z.zona !== "en rango" && !clasePie) clasePie = " warn";
  }
  if (fresca && m.temp !== undefined && m.hum !== undefined) {
    const P = window.PAR || {};
    const off = ultimaConfig ? ultimaConfig[P.VPD_OFFSET_HOJA] : 0;
    const rocio = puntoRocio(m.temp, m.hum);
    if (rocio !== null) partes.push("punto de rocío " + rocio.toFixed(1) + " °C");
    //  Desde el 2026-09-26 el equipo lo decide él (R3), con histéresis y
    //  con alarma que avisa por correo: si lo manda, manda él. Dos
    //  criterios -uno en el equipo y otro acá- harían que la app dijera
    //  «riesgo» con la alarma apagada, en el borde. Con un firmware que
    //  no lo manda, se calcula acá como antes.
    let riesgo, margen;
    if (cu.condensacion !== undefined) {
      riesgo = !!cu.condensacion;
      margen = cu.rocio_margen !== undefined ? Number(cu.rocio_margen)
                                             : margenCondensacion(m.temp, m.hum, off);
    } else {
      margen = margenCondensacion(m.temp, m.hum, off);
      riesgo = margen !== null && margen < CONDENSACION_MARGEN_C;
    }
    if (riesgo) {
      partes.push(margen !== null && margen > 0
        ? "RIESGO DE CONDENSACIÓN: la hoja está a " + margen.toFixed(1) + " °C del rocío (botrytis)"
        : "RIESGO DE CONDENSACIÓN: la hoja está bajo el rocío (botrytis)");
      clasePie = " err";
    }
  }
  if (m.nodos !== undefined) partes.push(m.nodos + " sensores");
  //  Por qué el sustrato no riega, con la regla de la pantalla
  //  (firmware-pantalla/include/ResumenRiego.h). Decía «riega por reloj»
  //  con las macetas en desacuerdo, y ese respaldo nunca existió; y «regó
  //  y no subió» cortaba el riego sin que nada lo dijera. 2026-09-26.
  const P2 = window.PAR || {};
  const mandaSu = !!(ultimaConfig && ultimaConfig[P2.RIEGO_HABILITADO] &&
                     (ultimaConfig[P2.RIEGO_VENTANA] | 0) === 2);
  if (su.discrepan) {
    partes.push(mandaSu ? "las macetas no coinciden: el riego por sustrato NO riega"
                        : "las macetas no coinciden");
    if (mandaSu) clasePie = " err";
  } else if (mandaSu && su.no_sube) {
    partes.push("regó y no subió: riego por sustrato cortado (revisar bomba y sensor)");
    clasePie = " err";
  } else if (mandaSu && su.tope_hoy) {
    partes.push("tope de riegos del día alcanzado: hoy no riega más");
  }
  det.textContent = partes.join(" · ");
  det.className = "sub" + clasePie;

  // ── Atención: sólo anomalías, no todo lo normal ──
  const a = $("atencion");
  const al = d.alarmas || [];
  a.innerHTML = "";
  //  «Sin avisos: todo dentro de lo normal» SÓLO con un dato fresco. Sin
  //  datos —o con datos viejos— la app afirmaba normalidad con el equipo
  //  caído o la sala sin internet (auditoría integral 2026-10-10,
  //  CL-012). La pantalla tapa todo con un velo; acá se dice qué no se
  //  sabe, y las alarmas viejas llevan su edad.
  const nota = (texto, clase) => {
    const p = document.createElement("p");
    p.className = "sub" + (clase ? " " + clase : "");
    p.textContent = texto;
    a.appendChild(p);
  };
  if (seg === null) {
    nota("Sin datos del equipo: no se sabe si hay avisos.", "warn");
  } else if (viejo) {
    nota("Último dato del equipo " + haceCuanto(seg) + ": " +
         (al.length ? "estos avisos pueden haber cambiado."
                    : "no se sabe si hay avisos ahora."), "warn");
    ordenarAlarmas(al).forEach(x => a.appendChild(renglonAlarma(x)));
  } else if (!al.length) {
    nota("Sin avisos: todo dentro de lo normal.");
  } else {
    ordenarAlarmas(al).forEach(x => a.appendChild(renglonAlarma(x)));
  }
  //  Con la orden en camino, también trabados: dos «reconocer» seguidos
  //  con la red lenta son dos órdenes.
  $("btn-ack").disabled = !d.sin_ver || enVuelo.has("ack-alarmas");
  $("btn-ack-seg").disabled = !(sg.enganchado) || enVuelo.has("ack-seg");
  //  §2.11 (decisión del propietario, 2026-09-27): silenciar la sirena
  //  también desde el teléfono. Misma regla que el botón de la pantalla:
  //  sólo mientras suena, y NUNCA durante una purga (esa sirena la pide
  //  Safety y no se calla desde ningún lado). El equipo la calla diez
  //  minutos y vuelve sola si la alarma sigue o empeora.
  ver($("btn-silenciar"), !!d.sirena && !sg.purga);
  $("btn-silenciar").disabled = enVuelo.has("silenciar");

  // ── Próximo: sólo los primeros eventos, no la agenda entera ──
  pintarAgenda();

  // ── Equipos: resumen de máximo tres líneas ──
  pintarEquiposResumen(d);
}

//  ── Las alarmas, de a una ──
//  Antes cada alarma era su nombre en rojo o en ámbar y nada más: el
//  color era lo ÚNICO que separaba una crítica de un aviso (WCAG 1.4.1:
//  el color no puede ser el único indicador), y una resuelta sin ver se
//  leía igual que una activa. Ahora cada renglón dice la gravedad y el
//  estado en palabras, y desde cuándo. Van ordenadas por gravedad: con
//  cinco alarmas, la que arriesga personas no puede quedar cuarta.
const SEV_NOMBRE = ["info", "aviso", "grave", "crítica"];
const ESTADO_ALARMA = { 1: "sin reconocer", 2: "reconocida", 3: "resuelta, sin ver" };

function ordenarAlarmas(al) {
  return al.slice().sort((x, y) =>
    ((y.sev | 0) - (x.sev | 0)) ||
    //  A igual gravedad, primero lo que nadie vio.
    ((x.estado === 1 ? 0 : 1) - (y.estado === 1 ? 0 : 1)) ||
    ((x.id | 0) - (y.id | 0)));
}

function renglonAlarma(x) {
  const r = document.createElement("div");
  r.className = "renglon";
  const t = document.createElement("span");
  t.textContent = x.texto || ("alarma " + x.id);
  //  Resuelta es pasado: no se pinta como un peligro presente.
  t.className = x.estado === 3 ? "" : (x.sev >= 2 ? "err" : "warn");
  const pill = document.createElement("span");
  pill.className = "pill" + (x.estado === 3 ? "" : x.sev >= 2 ? " mal" : " warn-pill");
  pill.textContent = SEV_NOMBRE[x.sev | 0] || "aviso";
  r.append(t, pill);

  const detalle = [ESTADO_ALARMA[x.estado] || "activa"];
  if (x.desde > 0) {
    const seg = Date.now() / 1000 - x.desde;
    if (seg >= 0) detalle.push("desde " + haceCuanto(seg));
  }
  if (x.veces > 1) detalle.push(x.veces + " veces desde el arranque");
  if (x.silenciada) detalle.push("sirena callada");
  r.appendChild(_p("sub por", detalle.join(" · ")));
  return r;
}

//  ── Puesta en marcha guiada ──
//  Sólo aparece mientras falte algo, y se basa en datos CONFIRMADOS por
//  el equipo -nunca en lo que la persona acaba de tocar-: si el paso 3
//  se diera por hecho apenas se toca «Aplicar», y la orden se rechazara
//  del otro lado, la tarjeta mentiría por unos segundos.
function pintarPuestaEnMarcha(d, viejo) {
  const host = $("puesta-marcha");
  const lista = $("pm-lista");
  const pasos = [];

  pasos.push({ txt: "Controlador vinculado", hecho: true });   // si se abrió la sala, ya lo está

  //  Fresca de verdad, no sólo publicada: un paso tildado con los
  //  sensores caídos haría creer que la sala ya está midiendo.
  const hayMedicion = medicionFresca(d.medicion, viejo) &&
    (d.medicion.co2 !== undefined || d.medicion.temp !== undefined);
  pasos.push({ txt: "Recibir mediciones de sala", hecho: !!hayMedicion,
               accion: "hist" });

  const salidas = d.salidas || [];
  const hayEquipos = salidas.some(o => o.tipo);
  pasos.push({ txt: "Configurar equipos y salidas", hecho: hayEquipos,
               accion: "mas", sub: "equipos" });

  const c = ultimaConfig || {};
  const P = window.PAR;
  const hayConsignas = !!(c[P.TEMP_MAX_DIA] || c[P.HUM_MAX_DIA]);
  pasos.push({ txt: "Cargar clima, CO₂, riego y luz", hecho: hayConsignas,
               accion: "control" });

  const sinAlarmasPendientes = !d.sin_ver;
  pasos.push({ txt: "Confirmar que no hay alarmas pendientes",
               hecho: sinAlarmasPendientes, accion: "inicio" });

  const faltaAlgo = pasos.some(p => !p.hecho);
  ver(host, faltaAlgo);
  if (!faltaAlgo) return;

  lista.innerHTML = "";
  pasos.forEach(p => {
    const li = document.createElement("li");
    const txt = document.createElement("span");
    txt.className = "pm-txt";
    if (p.hecho) {
      const chk = document.createElement("span");
      chk.className = "pm-check";
      chk.textContent = "✓";
      chk.setAttribute("aria-hidden", "true");
      const nombre = document.createElement("span");
      nombre.textContent = p.txt;
      txt.append(chk, nombre);
      txt.setAttribute("aria-label", p.txt + ", listo");
    } else {
      txt.textContent = p.txt;
    }
    li.appendChild(txt);
    if (!p.hecho && p.accion) {
      const b = document.createElement("button");
      b.textContent = p.accion === "control" || p.accion === "mas"
        ? "Configurar" : "Revisar";
      b.onclick = () => pestana(p.accion, p.sub);
      li.appendChild(b);
    }
    lista.appendChild(li);
  });
}

function pintarEquiposResumen(d) {
  const host = $("equipos-resumen");
  host.innerHTML = "";
  const sal = (d.salidas || []).filter(o => o.tipo);
  if (!sal.length) {
    host.innerHTML = '<p class="sub">Sin equipos asignados.</p>';
    return;
  }
  sal.slice(0, 3).forEach(o => {
    const row = document.createElement("div");
    row.className = "renglon";
    const nom = document.createElement("span");
    nom.textContent = o.equipo || EQUIPOS[o.tipo] || "?";
    const est = document.createElement("span");
    est.className = "pill" + (o.falla ? " mal" : (o.real ? " on" : ""));
    est.textContent = o.falla ? "no cumple" : (o.real ? "encendido" : "apagado");
    row.append(nom, est);
    host.appendChild(row);
  });
  if (sal.length > 3) {
    const p = document.createElement("p");
    p.className = "sub";
    p.style.margin = "8px 0 0";
    p.textContent = "y " + (sal.length - 3) + " más…";
    host.appendChild(p);
  }
}

// ============================================================
//  CONTROL — cuatro tarjetas por subsistema, con detalle plegable
// ============================================================
//  Ver el comentario grande al principio del archivo: el agrupamiento
//  es por NOMBRE semántico de `window.PAR`, no por sección textual.
const AVISO_CATEGORIA = () => ({
  [window.PAR.AV_TEMP_MIN]: "clima", [window.PAR.AV_TEMP_MAX]: "clima",
  [window.PAR.AV_HUM_MIN]: "clima",  [window.PAR.AV_HUM_MAX]: "clima",
  [window.PAR.AV_CO2_MIN]: "co2",    [window.PAR.AV_CO2_MAX]: "co2",
  [window.PAR.AV_VPD_MIN]: "clima",  [window.PAR.AV_VPD_MAX]: "clima",
});
const EXCEPCIONES_CATEGORIA = () => ({
  [window.PAR.CO2_HABILITADO]: "co2",
  [window.PAR.RIEGO_HABILITADO]: "riego",
  [window.PAR.RUTEO_TEMP_ET1]: "clima", [window.PAR.RUTEO_TEMP_ET2]: "clima",
  [window.PAR.RUTEO_HUM_ET1]: "clima",  [window.PAR.RUTEO_HUM_ET2]: "clima",
});

function categoriaControl(id, p) {
  const av = AVISO_CATEGORIA();
  if (av[id]) return av[id];
  const ex = EXCEPCIONES_CATEGORIA();
  if (ex[id]) return ex[id];
  const s = p.s;
  if (s === "CO2") return "co2";
  if (s === "Temperatura y humedad de sala") return "clima";
  if (s === "Riego y sustrato") return "riego";
  if (s === "Fotoperiodo" || s === "Mezcla de espectro") return "luz";
  return null;   // Conexión y el resto: instalación, van a Más.
}

const CATEGORIAS = [
  { id: "clima", nombre: "Clima", desc: "Temperatura, humedad y ventilación" },
  { id: "co2",   nombre: "CO₂",   desc: "Objetivo, ventana e inyección" },
  { id: "riego", nombre: "Riego", desc: "Pulsos y sustrato" },
  { id: "luz",   nombre: "Luz",   desc: "Fotoperiodo y espectro" },
];

let categoriaAbierta = null;   // acordeón: una sola a la vez

// ============================================================
//  La etapa del cultivo (R1 y R7, propietario 2026-09-26)
// ============================================================
//  Puntos de partida de la bibliografía por etapa
//  (docs/INVESTIGACION-CULTIVO-2026-09-25.md §2), en las unidades crudas
//  de cada parámetro. NO son consignas del equipo -el equipo no inventa
//  valores de cultivo-: la app los PROPONE y cada uno se aplica con su
//  propio botón, por el mismo camino que cualquier otro cambio. Elegir
//  la etapa no toca nada por sí solo.
//
//  Temperatura y humedad: el techo es el borde alto del rango (es donde
//  arranca a enfriar o secar). VPD: la banda entera, como límites de
//  aviso. CO₂: el medio del rango; en esquejes, sin enriquecer.
const ETAPA_SUGERIDOS = {
  1: { nombre: "esquejes", valores: [["TEMP_MAX_DIA", 280], ["HUM_MAX_DIA", 750],
       ["AV_VPD_MIN", 40], ["AV_VPD_MAX", 80], ["CO2_HABILITADO", 0]] },
  2: { nombre: "vegetativo", valores: [["TEMP_MAX_DIA", 280], ["HUM_MAX_DIA", 700],
       ["AV_VPD_MIN", 80], ["AV_VPD_MAX", 110], ["CO2_OBJETIVO", 1000]] },
  3: { nombre: "floración temprana", valores: [["TEMP_MAX_DIA", 280], ["HUM_MAX_DIA", 600],
       ["AV_VPD_MIN", 100], ["AV_VPD_MAX", 140], ["CO2_OBJETIVO", 1200]] },
  4: { nombre: "floración tardía", valores: [["TEMP_MAX_DIA", 260], ["HUM_MAX_DIA", 500],
       ["AV_VPD_MIN", 120], ["AV_VPD_MAX", 160], ["CO2_OBJETIVO", 1100]] },
};

//  Lo sugerido para la etapa cargada, con lo que hay ahora al lado. Sólo
//  los parámetros que el equipo publica: uno que no está no se ofrece.
function sugerenciasEtapa(cfg) {
  const P = window.PAR || {};
  const s = cfg ? ETAPA_SUGERIDOS[cfg[P.ETAPA] | 0] : null;
  if (!s) return [];
  return s.valores
    .map(([nombre, sugerido]) => ({ id: P[nombre], sugerido }))
    .filter(x => x.id !== undefined && cfg[x.id] !== undefined && window.PARAMETROS[x.id])
    .map(x => Object.assign(x, { actual: cfg[x.id], p: window.PARAMETROS[x.id] }));
}

//  R7: en floración, el aire. Mover el aire entre las flores bajó la
//  botrytis 66-92 % (Punja; INVESTIGACION-CULTIVO §3.2). Misma regla que
//  la pantalla (firmware-pantalla/include/ReglasCultivo.h): la
//  ventilación interna puede ser un relé asignado como tal; si los
//  ventiladores van enchufados directo, el aviso lo dice.
const TIPO_VENT_INTERNA = 2;
function recordatorioAire(cfg, salidas) {
  const P = window.PAR || {};
  if (!cfg) return "";
  const etapa = cfg[P.ETAPA] | 0;
  if (etapa !== 3 && etapa !== 4) return "";
  const hayRele = (salidas || []).some(o => o && o.tipo === TIPO_VENT_INTERNA);
  if (!hayRele) {
    return "Floración: mover el aire entre las flores previene la botrytis. " +
           "Ningún relé está asignado a ventilación interna (se asigna en Más → " +
           "Equipos). Si los ventiladores van enchufados directo, ignorá este aviso.";
  }
  if ((cfg[P.VENT_INT_MODO] | 0) === 0) {
    return "Floración: la ventilación interna está apagada, y mover el aire " +
           "entre las flores previene la botrytis. Se enciende acá abajo, en " +
           "«Ventilación interna».";
  }
  return "";
}

function pintarCultivo(det) {
  const c = ultimaConfig;
  const salidas = (ultimoEstado && ultimoEstado.d && ultimoEstado.d.salidas) || [];
  const aire = recordatorioAire(c, salidas);
  if (aire) det.appendChild(_p("sub warn", aire));

  const P = window.PAR;
  const s = ETAPA_SUGERIDOS[c[P.ETAPA] | 0];
  const lista = sugerenciasEtapa(c);
  if (!s || !lista.length) return;
  const t = tarjeta("Valores sugeridos para " + s.nombre);
  t.appendChild(_p("sub", "Puntos de partida de la bibliografía, no del equipo. " +
    "No se aplican solos: cada uno con su botón, y después se ajustan como " +
    "cualquier otro valor."));
  lista.forEach(x => {
    const row = document.createElement("div");
    const pendiente = enVuelo.get(x.id);
    row.className = "fila" + (pendiente ? " esperando" : "");
    const nombre = document.createElement("span");
    nombre.className = "fila-t";
    nombre.textContent = x.p.t;
    const cuenta = document.createElement("span");
    cuenta.className = "sub";
    const igual = x.actual === x.sugerido;
    cuenta.textContent = igual ? fmtValor(x.actual, x.p) + " (ya está)"
      : "ahora " + fmtValor(x.actual, x.p) + " → sugerido " + fmtValor(x.sugerido, x.p);
    row.append(nombre, cuenta);
    if (!igual && puedeOperar()) {
      const b = document.createElement("button");
      b.textContent = "Aplicar";
      b.setAttribute("aria-label", "aplicar " + x.p.t + ": " + fmtValor(x.sugerido, x.p));
      b.disabled = !!pendiente;
      b.onclick = () => mandar(CMD.PARAMETRO, x.id, x.sugerido, x.id,
                               x.p.t + " → " + fmtValor(x.sugerido, x.p));
      row.appendChild(b);
    }
    t.appendChild(row);
  });
  det.appendChild(t);
}

function resumenCategoria(cat) {
  const c = ultimaConfig;
  if (!c) return "Esperando configuración…";
  const P = window.PAR;
  if (cat === "clima") {
    if (!c[P.TEMP_MAX_DIA] && !c[P.HUM_MAX_DIA]) return "Sin consignas cargadas";
    const salidas = (ultimoEstado && ultimoEstado.d && ultimoEstado.d.salidas) || [];
    return (c[P.TEMP_MAX_DIA] / 10).toFixed(1) + " °C día · " +
           (c[P.HUM_MAX_DIA] / 10).toFixed(1) + " % día" +
           (recordatorioAire(c, salidas) ? " · floración: revisar el aire" : "");
  }
  if (cat === "co2") {
    if (!c[P.CO2_HABILITADO]) return "Inyección apagada";
    const co = (ultimoEstado && ultimoEstado.d.co2) || {};
    const dias = co.dias_restantes;
    if (dias !== undefined && dias >= 0) {
      return "objetivo " + c[P.CO2_OBJETIVO] + " ppm · tubo: " +
             dias + (dias === 1 ? " día" : " días");
    }
    return "objetivo " + c[P.CO2_OBJETIVO] + " ppm";
  }
  if (cat === "riego") {
    if (!c[P.RIEGO_HABILITADO]) return "Riego automático apagado";
    //  Según de qué cuelga (2026-09-26): antes contaba siempre el tren de
    //  la luz, y con la ventana en el reloj -la de fábrica- decía «4 pulsos
    //  programados» sobre un riego que no regaba. Misma regla que la
    //  pantalla (firmware-pantalla/include/ResumenRiego.h).
    const ventana = c[P.RIEGO_VENTANA] | 0;
    if (ventana === 2) return "Decide el sustrato";
    let veces = 0;
    if (ventana === 1) {
      veces = (c[P.RIEGO_P1_DUR] || 0) ? (c[P.RIEGO_P1_REP] || 0) : 0;
    } else {
      for (let i = 0; i < 10; i++)
        if ((c[P.RIEGO_HORA_BASE + i * 2] & 0x8000) && c[P.RIEGO_DUR_BASE + i * 2]) veces++;
    }
    const donde = ventana === 1 ? " con la luz" : " a hora fija";
    return veces ? veces + " pulso" + (veces === 1 ? "" : "s") + donde
                 : "Sin pulsos cargados";
  }
  if (cat === "luz") {
    if (!c[P.LUZ_HABILITADA]) return "Fotoperiodo apagado";
    //  En superciclo (13/13, por ejemplo) el encendido se corre cada día:
    //  un «08:00–20:00» sería un horario que el equipo no está corriendo.
    if (c[P.LUZ_MODO] === 1) {
      const h = m => (m / 60).toFixed(m % 60 ? 1 : 0).replace(".", ",");
      return "superciclo " + h(c[P.LUZ_HORAS_LUZ] || 0) + " h luz / " +
             h(c[P.LUZ_HORAS_OSC] || 0) + " h oscuridad";
    }
    const hhmm = m => String(Math.floor((m % 1440) / 60)).padStart(2, "0") + ":" +
                       String(m % 60).padStart(2, "0");
    return hhmm(c[P.LUZ_ON_MIN] || 0) + "–" + hhmm(c[P.LUZ_OFF_MIN] || 0);
  }
  return "";
}

function pintarControl() {
  const host = $("d-control");
  host.innerHTML = "";

  if (!ultimaConfig) {
    host.appendChild(_p("sub", "Esperando la configuración del equipo…"));
    return;
  }

  if (!puedeOperar()) {
    const c = tarjeta(null);
    c.appendChild(_p("sub", "Tu rol en esta sala es de sólo lectura: podés " +
      "ver todo y no cambiar nada. Para operarla, pedile al dueño de la " +
      "sala que te cambie el rol."));
    host.appendChild(c);
  }

  //  Agrupa cada id no-instalación en su categoría.
  const porCategoria = { clima: [], co2: [], riego: [], luz: [] };
  Object.keys(window.PARAMETROS).forEach(k => {
    const id = +k;
    if (ultimaConfig[id] === undefined) return;
    const p = window.PARAMETROS[id];
    if (p.inst) return;   // instalación vive en Más, no en Control
    const cat = categoriaControl(id, p);
    if (cat) porCategoria[cat].push(id);
  });

  CATEGORIAS.forEach(({ id, nombre, desc }) => {
    const abierta = categoriaAbierta === id;
    const b = document.createElement("button");
    b.className = "tarjeta-control";
    b.setAttribute("aria-expanded", abierta ? "true" : "false");
    b.innerHTML = '<span><span class="tc-nombre"></span>' +
                  '<span class="tc-resumen"></span></span>' +
                  '<span class="tc-flecha" aria-hidden="true"></span>';
    b.querySelector(".tc-nombre").textContent = nombre;
    b.querySelector(".tc-resumen").textContent = resumenCategoria(id);
    b.querySelector(".tc-flecha").textContent = abierta ? "▲" : "▼ Ajustar";
    b.onclick = () => { categoriaAbierta = abierta ? null : id; pintarControl(); };
    host.appendChild(b);

    if (abierta) {
      const det = document.createElement("div");
      det.className = "detalle-control";
      det.appendChild(_p("sub", desc));
      const ids = porCategoria[id];
      if (!ids.length) {
        det.appendChild(_p("sub", "Sin parámetros en esta sección."));
      } else {
        const c = tarjeta(null);
        ids.forEach(pid => c.appendChild(filaControl(pid)));
        det.appendChild(c);
      }
      //  La etapa y lo que sugiere (R1), y el aire en floración (R7).
      if (id === "clima") pintarCultivo(det);
      //  Consumo acumulado de CO2 (A1): estado en vivo, no un parametro
      //  de PARAMETROS -por eso no sale solo del bucle de arriba-, mas
      //  el boton de "cambie el tubo", que es una ACCION igual que
      //  saturar el sustrato: vuelve el acumulado a cero, no fija un
      //  numero que el operador tipeo.
      if (id === "co2") {
        const co = (ultimoEstado && ultimoEstado.d.co2) || {};
        if (co.consumo_g !== undefined) {
          const kg = (co.consumo_g / 1000).toFixed(1);
          const dias = co.dias_restantes;
          const texto = (dias !== undefined && dias >= 0)
              ? kg + " kg consumidos desde el último cambio de tubo · " +
                "quedan ~" + dias + (dias === 1 ? " día" : " días")
              : kg + " kg consumidos desde el último cambio de tubo " +
                "(fijá el caudal y la capacidad del tubo para estimar " +
                "los días que quedan)";
          det.appendChild(_p("sub", texto));
        }
        if (puedeOperar()) {
          const pendiente = enVuelo.has("reset-consumo-co2");
          const b = document.createElement("button");
          b.textContent = pendiente ? "Reiniciando…" : "Cambié el tubo";
          b.disabled = pendiente;
          b.style.marginTop = "8px";
          b.onclick = () => mandar(CMD.RESET_CONSUMO_CO2, 0, 0,
                                   "reset-consumo-co2", "reiniciar el consumo de CO2");
          det.appendChild(b);
        }
      }

      //  Saturar el sustrato es una ACCIÓN, no un parámetro: no tiene
      //  valor que mostrar ni fila en `PARAMETROS`, así que no aparece
      //  solo con el bucle de arriba. Antes de doblar un tallo
      //  (supercropping) hace falta que esté turgente, y para eso el
      //  riego que corresponde es el mismo "satura" del primer riego
      //  del día -no un pulso genérico-, disparado fuera de turno.
      if (id === "riego" && puedeOperar()) {
        const pendiente = enVuelo.has("saturar-sustrato");
        const b = document.createElement("button");
        b.textContent = pendiente ? "Saturando…" : "Saturar antes de entrenar";
        b.disabled = pendiente;
        b.style.marginTop = "8px";
        b.onclick = () => mandar(CMD.SATURAR_SUSTRATO, 0, 0,
                                 "saturar-sustrato", "saturar el sustrato");
        det.appendChild(b);
      }
      host.appendChild(det);
    }
  });
}

function filaControl(id) {
  const p = window.PARAMETROS[id];
  const v = ultimaConfig[id];
  const pendiente = enVuelo.get(id);
  const row = document.createElement("div");
  row.className = "fila" + (pendiente ? " esperando" : "");

  const t = document.createElement("span");
  t.className = "fila-t";
  t.textContent = p.t;
  row.appendChild(t);

  //  Mientras espera confirmación, el control se DESHABILITA de verdad.
  //  Un control gris que igual dispara su acción es peor que uno
  //  habilitado: se ve bloqueado, se toca, y la orden sale igual.
  //
  //  Y además el rol: los de instalación sólo los toca el dueño. La
  //  base ya lo aplica —una orden de `lectura` se rechaza por política
  //  de fila—, pero ofrecer el control y que la base lo rechace después
  //  es peor que no ofrecerlo: el operador no sabe si se rompió algo.
  const permitido = p.inst ? puedeInstalar() : puedeOperar();
  const trabado = !!pendiente || !permitido;

  if (p.k === "llave") {
    const b = document.createElement("button");
    b.className = "llave" + (v ? " on" : "");
    b.setAttribute("role", "switch");
    b.setAttribute("aria-checked", v ? "true" : "false");
    b.setAttribute("aria-label", p.t);
    b.disabled = trabado;
    b.onclick = () => mandar(CMD.PARAMETRO, id, v ? 0 : 1, id,
                             p.t + " → " + fmtValor(v ? 0 : 1, p));
    row.appendChild(b);
  } else if (p.k === "lista") {
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", p.t);
    (p.op || []).forEach((o, i) => {
      const op = document.createElement("option");
      op.value = i; op.textContent = o;
      sel.appendChild(op);
    });
    sel.value = v;
    sel.disabled = trabado;
    sel.onchange = () => mandar(CMD.PARAMETRO, id, +sel.value, id,
                                p.t + " → " + fmtValor(+sel.value, p));
    row.appendChild(sel);
  } else {
    //  El valor es un botón: tocarlo deja ESCRIBIR el número. Con el
    //  «+» de a un paso, llegar lejos son docenas de toques y cada uno
    //  espera la confirmación del equipo (ver `leerValor`).
    const val = document.createElement("button");
    val.className = "fila-v valor-tocable";
    //  Se sigue mostrando el valor CONFIRMADO, no el pedido. Mostrar el
    //  pedido haría creer que ya está aplicado; lo pedido se dice al
    //  lado del nombre, que es donde no se confunde con el estado real.
    val.textContent = fmtValor(v, p);
    val.setAttribute("aria-label", "escribir " + p.t + ", ahora " + fmtValor(v, p));
    val.disabled = trabado;
    val.onclick = () => escribirValor(id, p, v);
    const menos = document.createElement("button");
    menos.textContent = "−"; menos.setAttribute("aria-label", "bajar " + p.t);
    menos.disabled = trabado;
    menos.onclick = () => mandar(CMD.PARAMETRO, id, siguiente(v, p, false), id,
                                 p.t + " → " + fmtValor(siguiente(v, p, false), p));
    const mas = document.createElement("button");
    mas.textContent = "+"; mas.setAttribute("aria-label", "subir " + p.t);
    mas.disabled = trabado;
    mas.onclick = () => mandar(CMD.PARAMETRO, id, siguiente(v, p, true), id,
                               p.t + " → " + fmtValor(siguiente(v, p, true), p));
    row.append(val, menos, mas);
  }

  //  Qué se pidió, con todas las letras. «enviando…» a secas no dice si
  //  lo que viaja es lo que uno quiso: con dos toques seguidos, saber
  //  cuál de los dos valores está en camino es justamente el problema.
  if (pendiente && pendiente.dice) {
    const q = document.createElement("span");
    q.className = "fila-pendiente";
    q.textContent = "Esperando: " + pendiente.dice;
    row.appendChild(q);
  } else if (!permitido && puedeOperar()) {
    //  Sólo cuando el motivo es EL CONTROL y no la persona: si el rol
    //  es de sólo lectura ya lo dice el cartel de arriba, y repetirlo en
    //  sesenta filas es ruido.
    const q = document.createElement("span");
    q.className = "fila-pendiente";
    q.textContent = "Sólo lo cambia el dueño de la sala";
    row.appendChild(q);
  }
  return row;
}

//  Un número en las unidades que se leen, sin las palabras especiales
//  («sin límite», «apagada») que `fmtValor` pone para el cero o para el
//  brillo bajo: acá se describe un RANGO, y «entre sin límite y 50» o
//  «de a apagada» no se entienden.
function numeroLegible(v, p) {
  const f = p.f || 0;
  if (f === 1 || f === 3 || f === 9) return (v / 10).toFixed(1);
  if (f === 5) return (v / 100).toFixed(2);
  if (f === 2 || f === 10) return fmtValor(v, p);
  return String(v);
}

function ayudaRango(p) {
  if ((p.f || 0) === 2) return "Como 08:30.";
  if (p.f === 10) return "Como 08:30. «apagado» apaga este pulso.";
  //  11: minutos respecto de la luz principal, con palabras.
  if (p.f === 11) return "Como «30 antes» o «120 después». " +
                         "«con la luz» lo deja junto a la luz principal.";
  const desde = p.piso || p.min;
  return "Entre " + numeroLegible(desde, p) + " y " + numeroLegible(p.max, p) +
         ", de a " + numeroLegible(p.paso || 1, p) + "." +
         ((p.f === 8 || p.f === 9) ? " 0 es «apagado»." :
          //  El techo de higiene dice «sin techo» en su valor (fmtValor):
          //  la ayuda no puede llamarlo de otra forma (revisor, 2026-10-12).
          p.f === 7 ? " 0 es «sin techo»." :
          p.piso ? " 0 es «sin límite»." : "");
}

async function escribirValor(id, p, actual) {
  const f = p.f || 0;
  const unidades = ayudaRango(p);
  const texto = await dialogo({
    titulo: p.t,
    texto: "Ahora: " + fmtValor(actual, p) + ".",
    campo: "Valor nuevo",
    ayuda: unidades,
    valor: numeroLegible(actual, p),
    teclado: (f === 2 || f === 10) ? "text" : "decimal",
    aceptar: "Mandar",
    validar: t => { const r = leerValor(t, p); return r.error || null; },
  });
  if (texto === null || texto === undefined) return;
  const r = leerValor(texto, p);
  if (r.error || r.v === actual) return;
  mandar(CMD.PARAMETRO, id, r.v, id, p.t + " → " + fmtValor(r.v, p));
}

// ============================================================
//  MÁS — instalación, equipos (relés), conexión
// ============================================================
function pintarMasInstalacion() {
  const host = $("mas-instalacion");
  host.innerHTML = "";
  if (!ultimaConfig) return;
  const instalacion = [];
  Object.keys(window.PARAMETROS).forEach(k => {
    const id = +k;
    if (ultimaConfig[id] === undefined) return;
    if (window.PARAMETROS[id].inst) instalacion.push(id);
  });
  ver($("btn-mas-instalacion"), instalacion.length > 0);
  if (!instalacion.length) return;
  host.appendChild(_p("sub", puedeInstalar()
    ? "Esto describe CÓMO está armada la sala: qué equipo hay en cada " +
      "demanda y en qué dirección del bus responde cada nodo. Se toca en " +
      "la puesta en marcha, no en el día a día — si no coincide con el " +
      "cableado, el equipo acciona el aparato equivocado."
    : "Esto describe cómo está armada la sala y sólo lo cambia el dueño. " +
      "Se muestra para que sepas qué hay configurado."));
  const c = tarjeta("Instalación y servicio");
  instalacion.forEach(id => c.appendChild(filaControl(id)));
  host.appendChild(c);
}

function pintarMasConexion() {
  const host = $("mas-conexion");
  host.innerHTML = "";
  const h = document.createElement("h2");
  h.textContent = "Sala y conexión";
  host.appendChild(h);
  host.appendChild(_p("sub", "Nombre: " + (equipoActual ? equipoActual.nombre : "—") +
    (equipoActual && equipoActual.serie ? " · controlador " + equipoActual.serie : "")));
  //  Por dónde sale el equipo a internet (A4): cable o WiFi, y con
  //  WiFi además la señal traducida a una palabra -el número solo no
  //  le dice nada a quien instala, y la palabra sola no alcanza para
  //  comparar dos posiciones de antena-.
  const rd = (ultimoEstado && ultimoEstado.d.red) || null;
  if (rd) {
    let texto = "Conexión: " + (rd.via === "cable" ? "por cable" :
                rd.via === "wifi" ? "por WiFi" : "sin red (" + rd.motivo + ")");
    if (rd.ip) texto += " · " + rd.ip;
    if (rd.via === "wifi" && rd.senal) texto += " · señal " + rd.senal +
      " (" + rd.rssi + " dBm)";
    host.appendChild(_p("sub", texto));
  }
  //  El huso horario (instalación) vive acá también si está cargado.
  const id = window.PAR.TZ_OFFSET_MIN;
  if (ultimaConfig && ultimaConfig[id] !== undefined) {
    const c = tarjeta(null);
    c.appendChild(filaControl(id));
    host.appendChild(c);
  }
}

//  ── Los relés ──
function pintarEquiposPanel() {
  const host = $("reles");
  if (!ultimoEstado) return;
  host.innerHTML = "";
  const sal = (ultimoEstado.d.salidas || []);
  if (!sal.length) {
    host.innerHTML = '<p class="sub">El equipo todavía no mandó sus salidas.</p>';
    return;
  }
  sal.forEach(o => {
    const row = document.createElement("div");
    //  UNA operación pendiente por canal, sea reasignarlo o sacarlo de
    //  servicio. Son dos órdenes distintas sobre el mismo relé y
    //  dejarlas correr en paralelo permite pedir «este relé pasa a ser
    //  humidificador» y «este relé queda fuera de servicio» a la vez.
    const pendiente = enVuelo.get("rele" + o.ch) || enVuelo.get("fuera" + o.ch) ||
                      enVuelo.get("manual" + o.ch);
    const trabado = !!pendiente;
    row.className = "fila" + (trabado ? " esperando" : "");
    const t = document.createElement("span");
    t.className = "fila-t";
    t.textContent = "Relé " + o.ch;
    const sel = document.createElement("select");
    sel.setAttribute("aria-label", "equipo del relé " + o.ch);
    EQUIPOS.forEach((n, i) => {
      const op = document.createElement("option");
      op.value = i; op.textContent = n;
      sel.appendChild(op);
    });
    sel.value = o.tipo || 0;
    //  R2-001 (reauditoría de Codex, 2026-10-12): cambiar qué equipo
    //  maneja un relé es tocar la INSTALACIÓN, y el equipo ya no lo
    //  acepta por la vía remota — con razón: desasignar la válvula de
    //  CO₂ desde cualquier lado le quitaba su protección de crítica, y
    //  el relé físico de la solenoide quedaba accionable a mano. Se
    //  cambia parado frente al tablero: la pantalla, o la página local
    //  del equipo. El desplegable queda para VER qué hay, deshabilitado
    //  y diciendo por qué — un control que siempre rebota enseña a
    //  ignorar los rechazos.
    sel.disabled = true;
    sel.title = "Se cambia en la sala: pantalla del tablero o página del equipo.";
    sel.setAttribute("aria-label", "relé " + o.ch +
        ": qué equipo maneja. Se cambia en la sala, no desde la app");
    const est = document.createElement("span");
    //  Fuera de servicio gana a todo: si alguien ya anotó que ese relé
    //  no anda, «apagado» no es la noticia, y un «no cumple» sería
    //  mentira porque el control ya dejó de pedírselo.
    est.className = "pill" + (o.fuera ? " warn-pill"
                            : (o.falla ? " mal" : (o.real ? " on" : "")));
    est.textContent = o.fuera ? "fuera de servicio"
                    : (o.falla ? "no cumple" : (o.real ? "encendido" : "apagado"));
    //  Marcarlo lo decide una PERSONA: el fusible quemado, el contactor
    //  pegado, el equipo desenchufado para mantenimiento. No es una
    //  falla que el equipo detecte, es una que alguien ya conoce.
    const b = document.createElement("button");
    //  Los mismos verbos que la pantalla (banco, 2026-10-09): «fuera»
    //  solo no decía fuera de qué.
    b.textContent = o.fuera ? "reponer" : "sacar";
    b.className = "chico" + (o.fuera ? " marcado" : "");
    //  Sin equipo asignado no hay nada que sacar de servicio; y con una
    //  orden en camino sobre este relé, tampoco. Marcar un relé fuera de
    //  servicio SÍ es operación: lo hace quien está arreglando algo, no
    //  quien instaló la sala.
    b.disabled = !o.tipo || trabado || !puedeOperar();
    b.setAttribute("aria-label",
        (o.fuera ? "reponer en servicio el relé " : "sacar de servicio el relé ")
        + o.ch);
    b.onclick = () => mandar(CMD.PARAMETRO, window.PAR.SALIDA_FUERA,
                             (o.ch << 8) | (o.fuera ? 0 : 1), "fuera" + o.ch,
                             "relé " + o.ch + (o.fuera ? " → vuelve a servicio"
                                                       : " → fuera de servicio"));
    row.append(t, sel, est, b);
    //  §2.13 (decisión del propietario, 2026-09-27): encender un equipo
    //  a mano POR UN RATO — ventilar antes de entrar, probar algo recién
    //  reparado —. El controlador lo sabía desde siempre (MANUAL_ON, con
    //  vencimiento obligatorio) y ninguna interfaz lo ofrecía. Vence
    //  solo a los 10 minutos; después vuelve a mandar la lógica de
    //  siempre, así que no hay «me olvidé el extractor prendido».
    //
    //  La VÁLVULA no tiene el botón: el firmware rechaza el mando manual
    //  sobre el canal crítico (su único camino es el control de CO2), y
    //  ofrecer un botón que siempre contesta «rechazado» es enseñar que
    //  los rechazos no significan nada. Fuera de servicio tampoco: ahí
    //  alguien ya anotó «no lo uses». La bomba sí: el firmware la rutea
    //  por el riego, que respeta el tope de un pulso y lo registra.
    if (o.tipo && o.tipo !== 7 && !o.fuera && puedeOperar()) {
      const manual = o.real && o.motivo === "manual";
      const m = document.createElement("button");
      m.textContent = manual ? "apagar ya" : "10 min";
      m.className = "chico" + (manual ? " marcado" : "");
      m.disabled = trabado;
      m.setAttribute("aria-label", (manual ? "apagar el relé "
                                           : "encender 10 minutos el relé ") + o.ch);
      m.onclick = async () => {
        //  El 1 s del OFF: apagar YA y que en un segundo vuelva a mandar
        //  la lógica de siempre, en vez del apagado retenido una hora.
        if (manual) { mandar(CMD.MANUAL_OFF, o.ch, 1, "manual" + o.ch,
                             "relé " + o.ch + " → apagar"); return; }
        //  C-19 (decisión del propietario, 2026-10-12): prender una LUZ
        //  fuera de la fase de luz se puede, pero con esta pregunta. El
        //  equipo igual la exige (MANUAL_ON común contesta «hay que
        //  confirmar»): esto no es la seguridad, es la cortesía de
        //  preguntar ANTES de mandar.
        const esLuz = o.tipo === 9 || o.tipo === 11 || o.tipo === 12 || o.tipo === 13;
        const luz = ultimoEstado && ultimoEstado.d && ultimoEstado.d.luz;
        if (esLuz && luz && luz.fase_de_luz === false) {
          const ok = await dialogo({
            titulo: "Prender la luz en horario nocturno",
            texto: "Está intentando prender las luces de forma manual en " +
                   "horario nocturno. En floración, cortar la noche de las " +
                   "plantas puede afectar el cultivo. ¿Está seguro?",
            aceptar: "Prender igual",
            peligro: true,
          });
          if (!ok) return;
          mandar(CMD.MANUAL_ON_NOCHE, o.ch, 600, "manual" + o.ch,
                 "relé " + o.ch + " → encendido 10 min (de noche, confirmado)");
          return;
        }
        mandar(CMD.MANUAL_ON, o.ch, 600, "manual" + o.ch,
               "relé " + o.ch + " → encendido 10 min");
      };
      row.appendChild(m);
    }
    if (pendiente && pendiente.dice) {
      const q = document.createElement("span");
      q.className = "fila-pendiente";
      q.textContent = "Esperando: " + pendiente.dice;
      row.appendChild(q);
    }
    host.appendChild(row);
  });
  pintarMasInstalacion();
  pintarMasConexion();
}

// ------------------------------------------------------------
//  Lo que el equipo VA A HACER
// ------------------------------------------------------------
//  Un panel de control dice lo que está pasando. Lo que casi nunca dice
//  es lo que VA a pasar, y ahí es donde se esconden los errores de
//  configuración: un fotoperiodo que nunca enciende, una ventana de
//  inyección que no se abre porque la demora más el corte superan las
//  horas de luz, un riego que cae de noche.
//
//  Nada de eso se descubre mirando números. Se descubre a las tres
//  semanas, cuando el cultivo salió mal.
//
//  Esto NO es una simulación física: no predice temperatura ni CO2. Es
//  la AGENDA de lo que está programado, calculada de la configuración
//  que el equipo confirmó. Decirlo importa: un gráfico que pareciera
//  predecir la sala sería peor que no tener ninguno.
function proximas24() {
  const c = ultimaConfig;
  if (!c) return null;
  const P = window.PAR;
  const ev = [];
  const hhmm = m => String(Math.floor((m % 1440) / 60)).padStart(2, "0") + ":" +
                    String(m % 60).padStart(2, "0");

  const luzHab = c[P.LUZ_HABILITADA],
        luzOn  = c[P.LUZ_ON_MIN],
        luzOff = c[P.LUZ_OFF_MIN];
  if (luzHab && luzOn === luzOff) {
    ev.push([0, "El fotoperiodo está encendido pero enciende y apaga a la " +
                "misma hora: la luz no se va a prender nunca", "mal"]);
  } else if (luzHab) {
    ev.push([luzOn,  "Enciende la luz", "luz"]);
    ev.push([luzOff, "Apaga la luz", "luz"]);
    const purga = c[P.PURGA_POST_LUZ] || 0;
    if (purga) {
      ev.push([(luzOff + purga) % 1440,
               "Termina la purga — " + purga + " min extrayendo", "purga"]);
    }

    const duracion = (luzOff - luzOn + 1440) % 1440;

    // La ventana de inyección, cuando cuelga del fotoperiodo.
    if (c[P.CO2_HABILITADO] && c[P.CO2_VENTANA] === 2) {
      const demora = c[P.CO2_DEMORA_MIN] || 0, corte = c[P.CO2_CORTE_ANTES] || 0;
      if (demora + corte >= duracion) {
        ev.push([luzOn, "LA VENTANA DE CO2 NO SE ABRE NUNCA: la demora (" +
                 demora + " min) más el corte (" + corte + " min) superan las " +
                 (duracion / 60).toFixed(1) + " h de luz", "mal"]);
      } else {
        ev.push([(luzOn + demora) % 1440, "Puede empezar a inyectar CO2", "co2"]);
        ev.push([(luzOff - corte + 1440) % 1440, "Corta la inyección de CO2", "co2"]);
      }
    } else if (c[P.CO2_HABILITADO] && c[P.CO2_VENTANA] === 0) {
      ev.push([0, "Inyecta también de noche: sin luz la planta no fotosintetiza " +
                  "y el gas se acumula sin que nadie lo use", "mal"]);
    }

    // R2 y R5 (propietario, 2026-09-26): la consigna se mueve sola dos
    // veces por día, y conviene saber cuándo antes de verlo pasar.
    const anticipo = c[P.HUM_ANTICIPO_MIN] || 0;
    if (c[P.USA_CONSIGNA_NOCHE] && anticipo) {
      ev.push([(luzOff - anticipo + 1440) % 1440,
               "La humedad pasa a la de noche (" + anticipo + " min antes de apagar)",
               "clima"]);
    }
    const dropMin = c[P.DROP_MIN] || 0, dropC10 = c[P.DROP_C10] || 0;
    if (dropMin && dropC10) {
      ev.push([(luzOn + dropMin) % 1440,
               "Termina la bajada del amanecer (" + (dropC10 / 10).toFixed(1) +
               " °C menos de frío)", "clima"]);
    }

    // El riego colgado de la luz: la espera y después el tren.
    if (c[P.RIEGO_HABILITADO] && c[P.RIEGO_VENTANA] === 1) {
      const p0 = c[P.RIEGO_P0] || 0, dur = c[P.RIEGO_P1_DUR] || 0;
      const pausa = c[P.RIEGO_P1_PAUSA] || 0, veces = c[P.RIEGO_P1_REP] || 0;
      //  R6: en los últimos minutos de luz el equipo no arranca riegos.
      //  Un pulso programado ahí es una configuración que se contradice:
      //  se muestra como problema, no como una cita que no va a ocurrir.
      const corte = c[P.RIEGO_CORTE_MIN] || 0;
      if (!veces) {
        ev.push([luzOn, "Riego encendido y sin pulsos cargados", "mal"]);
      } else {
        const durMin = Math.ceil(dur / 60);
        for (let i = 0; i < veces; i++) {
          const desde = p0 + i * (pausa + durMin);
          const t = (luzOn + desde) % 1440;
          const dentro = desde < duracion;
          const cortado = dentro && corte > 0 && desde >= duracion - corte;
          ev.push([t, "Riego " + (i + 1) + " de " + veces + " — " + dur + " s" +
                      (!dentro ? "  ·  CAE FUERA DE LAS HORAS DE LUZ"
                       : cortado ? "  ·  NO ARRANCA: cae en el corte antes de apagar"
                       : ""),
                   dentro && !cortado ? "riego" : "mal"]);
        }
      }
    }
  }

  // El riego por reloj (2026-09-26): cada pulso a su hora, con o sin
  // fotoperiodo. Hasta hoy la agenda no lo mostraba, y no había dónde
  // cargarlo: un riego encendido «por reloj» no regaba y nada lo decía.
  if (c[P.RIEGO_HABILITADO] && (c[P.RIEGO_VENTANA] | 0) === 0) {
    const corte = c[P.RIEGO_CORTE_MIN] || 0;
    const durLuz = (luzOff - luzOn + 1440) % 1440;
    let listos = 0;
    for (let i = 0; i < 10; i++) {
      const hora = c[P.RIEGO_HORA_BASE + i * 2] | 0;
      const dur  = c[P.RIEGO_DUR_BASE + i * 2] | 0;
      if (!(hora & 0x8000)) continue;
      const t = (hora & 0x7FFF) % 1440;
      if (!dur) {
        ev.push([t, "Pulso " + (i + 1) + " con hora y sin duración: no riega", "mal"]);
        continue;
      }
      listos++;
      //  R6 también vale acá: en los últimos minutos de luz no arranca.
      const desde = (t - luzOn + 1440) % 1440;
      const cortado = luzHab && luzOn !== luzOff && corte > 0 &&
                      desde < durLuz && desde >= durLuz - corte;
      ev.push([t, "Riego por reloj — " + dur + " s" +
                  (cortado ? "  ·  NO ARRANCA: cae en el corte antes de apagar" : ""),
               cortado ? "mal" : "riego"]);
    }
    if (!listos) ev.push([0, "Riego encendido «por reloj» y sin pulsos a hora fija cargados", "mal"]);
  }

  if (!ev.length) return null;
  ev.sort((a, b) => a[0] - b[0]);
  return ev.map(e => ({ hora: hhmm(e[0]), texto: e[1], clase: e[2] }));
}

//  En Inicio se muestran sólo los primeros eventos: es un resumen del
//  día, no la agenda completa. El detalle entero -si alguien lo
//  necesita- sigue disponible en el mismo bloque cuando hay pocos.
//
//  Los problemas («mal») se muestran TODOS, sin importar la hora: un
//  recorte puramente cronológico podía dejar un «riego fuera de las
//  horas de luz» de la noche afuera del resumen porque caía después de
//  tres eventos normales más tempranos -exactamente el caso que Inicio
//  existe para mostrar («Atención: sólo anomalías accionables»)-. El
//  resto del cupo se completa con los próximos eventos normales.
const AGENDA_RESUMEN_MAX = 3;

//  El minuto del día EN EL EQUIPO. Los horarios de la configuración son
//  hora local de la sala, y la sala puede estar en otro huso que el
//  teléfono. Sin el huso cargado no se sabe, y se devuelve null.
function minutoDelEquipo(ahoraMs) {
  const P = window.PAR || {};
  const off = ultimaConfig ? ultimaConfig[P.TZ_OFFSET_MIN] : undefined;
  if (off === undefined || off === null) return null;
  const min = Math.floor((ahoraMs === undefined ? Date.now() : ahoraMs) / 60000) + off;
  return ((min % 1440) + 1440) % 1440;
}

function pintarAgenda(ahoraMin) {
  const host = $("agenda");
  if (!host) return;
  const ev = proximas24();
  if (!ev) {
    host.innerHTML = '<p class="sub">Sin fotoperiodo cargado todavía no hay ' +
      'nada programado.</p>';
    return;
  }
  host.innerHTML = "";
  if (ahoraMin === undefined) ahoraMin = minutoDelEquipo();
  const minDe = e => +e.hora.slice(0, 2) * 60 + +e.hora.slice(3, 5);
  const problemas = ev.filter(e => e.clase === "mal");
  //  «Próximo» empieza AHORA: antes se ordenaba por hora del día, y a
  //  las tres de la tarde el primer renglón era el encendido de las ocho
  //  de la mañana, que ya había pasado. Lo que ya pasó hoy vuelve a
  //  ocurrir mañana, y se dice así.
  let normales = ev.filter(e => e.clase !== "mal");
  if (ahoraMin !== null) {
    const hoy = normales.filter(e => minDe(e) >= ahoraMin);
    const manana = normales.filter(e => minDe(e) < ahoraMin)
                           .map(e => Object.assign({}, e, { manana: true }));
    normales = hoy.concat(manana);
  }
  const cupo = Math.max(0, AGENDA_RESUMEN_MAX - problemas.length);
  //  Los problemas primero y todos: son configuraciones rotas, no citas.
  const aMostrar = problemas.concat(normales.slice(0, cupo));
  aMostrar.forEach(e => {
    const r = document.createElement("div");
    r.className = "renglon";
    const h = document.createElement("span");
    h.className = "fila-v";
    h.style.minWidth = "62px";
    h.style.textAlign = "left";
    h.textContent = e.hora;
    const t = document.createElement("span");
    t.textContent = e.manana ? e.texto + " (mañana)" : e.texto;
    if (e.clase === "mal") t.className = "err";
    r.append(h, t);
    host.appendChild(r);
  });
  //  «más hoy» mentía cuando lo que falta ya cae mañana: son las
  //  próximas veinticuatro horas, digan la fecha que digan.
  if (ev.length > aMostrar.length) {
    host.appendChild(_p("sub", "y " + (ev.length - aMostrar.length) +
                               " eventos más en las próximas 24 horas."));
  }
  const n = document.createElement("p");
  n.className = "sub";
  n.style.marginTop = "12px";
  n.textContent = "Es la agenda de lo que está programado, no una predicción de " +
    "la sala: no dice qué temperatura ni qué CO2 va a haber, dice qué va a hacer " +
    "el equipo y cuándo. Las horas son las de la sala" +
    (ahoraMin === null ? " (sin el huso horario cargado no se sabe cuál es " +
                          "el próximo)." : ".");
  host.appendChild(n);
}

//  ── Historial ──
//  Predetermina UNA sola variable -no las cuatro juntas- para lectura
//  rápida; «Comparar variables» superpone todas, como acción aparte.
//  El VPD ya viaja al historial en cada punto (`vpd_centi`, lo manda
//  `Nube::publicarHistorial`) y la app no lo pedía; el documento de
//  estado llegó a decir que la columna no existía. Es el número que mira
//  el agrónomo, así que va con los demás.
//  El quinto campo dice si la variable es del AIRE: esas dependen de
//  `medicion_ok`, y el sustrato tiene su propio «no hay dato» (nulo).
const VARIABLES_HIST = [
  ["co2",    "CO₂",         "co2_ppm",     "#B48AD9", v => v + " ppm", true],
  ["temp",   "Temperatura", "temp_c10",    "#F09A6A", v => (v / 10).toFixed(1) + " °C", true],
  ["hum",    "Humedad",     "hum_pct10",   "#5AA9E6", v => (v / 10).toFixed(1) + " %", true],
  ["vpd",    "VPD",         "vpd_centi",   "#6FC7A8", v => (v / 100).toFixed(2) + " kPa", true],
  ["suelo",  "Sustrato",    "suelo_pct10", "#9A7B5A", v => (v / 10).toFixed(1) + " %", false],
];
let histVarActiva = "co2";
let histComparar = false;
let histFilas = null;

//  Un punto por minuto son 1440 por día, y Supabase entrega como mucho
//  1000 filas por pedido (menos, si el proyecto lo bajó). El pedido de
//  antes era `.limit(600)` en orden ascendente: traía las DIEZ HORAS MÁS
//  VIEJAS de la ventana y nunca las últimas catorce. El gráfico decía
//  «24 horas» y cortaba justo lo que uno abre la app para ver.
//  Ahora se pide de a páginas hasta que una vuelve VACÍA. Cortar cuando
//  vuelve «corta» suponía que el servidor entrega las mil que se piden:
//  con un proyecto que entrega de a 500, la primera ya parecía la
//  última (lo encontró la prueba, sección 18). Una vuelta de más por
//  consulta es el precio de no suponer. Auditoría de interfaz, 2026-09-25.
const HIST_PAGINA = 1000;
const HIST_TOPE = 3000;   // tres días a un punto por minuto: nunca debería llegar
async function leerHistorial(equipoId, desde) {
  const filas = [];
  for (let vuelta = 0; vuelta < 20 && filas.length < HIST_TOPE; vuelta++) {
    const { data, error } = await sb.from("historial")
      .select("momento,temp_c10,hum_pct10,co2_ppm,vpd_centi,suelo_pct10,medicion_ok")
      .eq("equipo_id", equipoId).gte("momento", desde)
      .order("momento", { ascending: true })
      .range(filas.length, filas.length + HIST_PAGINA - 1);
    if (error) return { error };
    if (!data || !data.length) break;
    filas.push(...data);
  }
  return { data: filas };
}

async function pintarHistorial() {
  const host = $("grafico");
  host.innerHTML = '<p class="sub">Buscando…</p>';
  const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await leerHistorial(equipoActual.id, desde);
  if (error) {
    //  El mensaje va por `textContent`, no concatenado en `innerHTML`.
    //  Un texto de error puede reflejar parte de lo que se pidio, y
    //  concatenarlo en HTML lo convierte en un camino para inyectar
    //  marcado. No hace falta que sea explotable hoy: es la forma
    //  equivocada de poner texto ajeno en una pagina.
    host.innerHTML = "";
    host.appendChild(_p("sub err", "No se pudo leer el historial: " +
                                   enCastellano(error.message)));
    return;
  }
  if (!data || data.length < 2) {
    host.innerHTML = '<p class="sub">Todavía no hay historial suficiente. ' +
      'El equipo sube un punto por minuto desde que arranca.</p>';
    return;
  }
  histFilas = data;
  pintarSelectorHistVars(data);
  dibujarCurvas(host, data);
  pintarExportarHist();
}

//  ── Exportar a CSV (C2) ──
//  `histFilas` ya está en memoria -es lo que dibuja el gráfico-, así
//  que exportar es sólo serializarlo. Sin pedido nuevo al servidor, sin
//  tocar el controlador ni el contrato: es trabajo de la app sola.
function filasACsv(filas) {
  const num = (v, decimales) => (v === null || v === undefined) ? ""
             : (decimales === 0 ? String(v) : (v / Math.pow(10, decimales)).toFixed(decimales));
  const lineas = ["hora,co2_ppm,temp_c,hum_pct,vpd_kpa,suelo_pct,medicion_ok"];
  filas.forEach(f => {
    lineas.push([
      f.momento,
      f.co2_ppm ?? "",
      num(f.temp_c10, 1),
      num(f.hum_pct10, 1),
      num(f.vpd_centi, 2),
      num(f.suelo_pct10, 1),
      f.medicion_ok ? "1" : "0",
    ].join(","));
  });
  return lineas.join("\r\n");
}

function pintarExportarHist() {
  const host = $("hist-exportar");
  if (!host) return;
  host.innerHTML = "";
  if (!histFilas || !histFilas.length) return;
  const b = document.createElement("button");
  b.textContent = "Descargar CSV";
  b.style.marginTop = "8px";
  b.onclick = () => {
    //  BOM al principio: sin él, Excel en Windows -el uso más común de
    //  un CSV- interpreta el archivo como Latin-1 y los acentos de las
    //  cabeceras (ninguna hoy, pero es la costumbre del formato) salen
    //  mal. Un archivo que un agrónomo no puede leer bien es tan malo
    //  como no tener exportación.
    const csv = "﻿" + filasACsv(histFilas);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const sala = ((equipoActual && equipoActual.nombre) || "sala")
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-zA-Z0-9-]+/g, "_");
    const a = document.createElement("a");
    a.href = url;
    a.download = "historial-" + sala + "-" + new Date().toISOString().slice(0, 10) + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  host.appendChild(b);
}

function pintarSelectorHistVars(filas) {
  const host = $("hist-vars");
  host.innerHTML = "";
  //  Sólo se ofrecen las variables que de verdad tienen dato en esta
  //  ventana -el sustrato no siempre está instalado-, para no mostrar
  //  una pestaña que va a abrir un gráfico vacío.
  const disponibles = VARIABLES_HIST.filter(([, , campo]) =>
    filas.some(f => f[campo] !== null && f[campo] !== undefined));
  if (!disponibles.some(([id]) => id === histVarActiva) && disponibles.length)
    histVarActiva = disponibles[0][0];

  disponibles.forEach(([id, nombre]) => {
    const b = document.createElement("button");
    b.textContent = nombre;
    b.setAttribute("aria-pressed", (!histComparar && histVarActiva === id) ? "true" : "false");
    b.onclick = () => { histVarActiva = id; histComparar = false; redibujarHist(); };
    host.appendChild(b);
  });
  const cmp = document.createElement("button");
  cmp.textContent = "Comparar variables";
  cmp.setAttribute("aria-pressed", histComparar ? "true" : "false");
  cmp.onclick = () => { histComparar = true; redibujarHist(); };
  host.appendChild(cmp);
}

function redibujarHist() {
  if (!histFilas) return;
  pintarSelectorHistVars(histFilas);
  dibujarCurvas($("grafico"), histFilas);
}

const EJE_ALTO = 34;

function svgEl(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function hhmm(iso) {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" +
         String(d.getMinutes()).padStart(2, "0");
}

//  `comparar` es un parámetro explícito -no sólo el estado de módulo
//  `histComparar`- para que se pueda pedir el modo "las cuatro juntas"
//  sin pasar antes por `pintarHistorial()`/el selector de variable.
function dibujarCurvas(host, filas, comparar = histComparar) {
  //  El ancho del dibujo es el de la PANTALLA, una unidad por píxel. Con
  //  860 fijos, en un teléfono de 390 px todo se achicaba a un tercio:
  //  las horas del eje quedaban en letra de 5 px -ilegibles- y las
  //  curvas en trazo de menos de un píxel. Auditoría de interfaz,
  //  2026-09-25, mirando la app en un navegador de verdad.
  const W = Math.max(300, Math.round(host.clientWidth || 860)), H = 240, PAD = 6;
  const ALTO = H + EJE_ALTO;
  const PISO = H - PAD;                 // dónde termina el área de dibujo
  host.innerHTML = "";
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + ALTO);
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  const leyenda = document.createElement("div");
  leyenda.className = "leyenda";

  //  El eje es de TIEMPO, no de número de punto. Por índice, dos horas
  //  sin datos (un corte de luz, el equipo sin internet) se comían sin
  //  dejar rastro: la curva unía las dos puntas y las marcas de hora
  //  quedaban corridas. Ahora cada punto va en su hora.
  const tiempos = filas.map(f => Date.parse(f.momento));
  const t0 = tiempos[0], span = Math.max(1, tiempos[tiempos.length - 1] - t0);
  const equisT = t => PAD + ((t - t0) / span) * (W - 2 * PAD);
  const equis = i => equisT(tiempos[i]);
  //  Qué cuenta como hueco: más de cinco minutos, o más de tres veces el
  //  paso típico (un punto por minuto hoy, pero no se supone).
  const pasos = [];
  for (let i = 1; i < tiempos.length; i++) pasos.push(tiempos[i] - tiempos[i - 1]);
  pasos.sort((a, b) => a - b);
  const pasoTipico = pasos.length ? pasos[Math.floor(pasos.length / 2)] : 60000;
  const HUECO_MS = Math.max(5 * 60000, 3 * pasoTipico);

  // ── El eje de tiempo ──
  const marcas = [0, 0.25, 0.5, 0.75, 1];
  marcas.forEach((fr, n) => {
    const tm = t0 + fr * span;
    const x = equisT(tm);
    const linea = svgEl("line");
    linea.setAttribute("x1", x); linea.setAttribute("x2", x);
    linea.setAttribute("y1", PAD); linea.setAttribute("y2", PISO);
    linea.setAttribute("stroke", "#2a3a30");
    linea.setAttribute("stroke-width", "1");
    svg.appendChild(linea);

    const t = svgEl("text");
    t.setAttribute("x", x);
    t.setAttribute("y", H + 16);
    t.setAttribute("text-anchor", n === 0 ? "start"
                                : n === marcas.length - 1 ? "end" : "middle");
    t.setAttribute("fill", "#8aa294");
    t.setAttribute("font-size", "13");
    t.textContent = hhmm(new Date(tm));
    svg.appendChild(t);
  });

  //  Comparar muestra todas; si no, sólo la variable elegida.
  const trazos = ["", "7 4", "2 4", "10 4 2 4", "1 3"];
  const aDibujar = comparar ? VARIABLES_HIST
    : VARIABLES_HIST.filter(([id]) => id === histVarActiva);

  //  Un minuto con la medición marcada como mala es un HUECO, no un
  //  valor: el equipo lo guarda así a propósito (`medicion_ok`) para que
  //  «el sensor se cayó» no se dibuje igual que «la sala estuvo quieta».
  //  La app lo dibujaba como un punto más.
  const valorDe = (f, campo, delAire) =>
    (delAire && f.medicion_ok === false) ? null : f[campo];

  const series = [];
  aDibujar.forEach(([, nombre, campo, color, fmt, delAire], n) => {
    const vals = filas.map(f => valorDe(f, campo, delAire))
                      .filter(v => v !== null && v !== undefined);
    if (vals.length < 2) return;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    //  Una variable quieta estirada a todo el alto es ruido del sensor
    //  dibujado como si fuera un evento. Debajo del umbral se dibuja
    //  chata en el medio y la leyenda dice «estable». El umbral depende
    //  de la unidad de cada variable.
    const umbral = campo === "co2_ppm" ? 80 : campo === "hum_pct10" ? 30
                 : campo === "suelo_pct10" ? 20 : 10;
    const estable = (hi - lo) < umbral;
    const trazo = comparar ? trazos[n % trazos.length] : "";
    //  La línea se CORTA en cada hueco: sin dato o con un salto de
    //  tiempo. Unir las dos puntas inventa una recta que nadie midió.
    let d = "", previo = null;
    filas.forEach((f, i) => {
      const v = valorDe(f, campo, delAire);
      if (v === null || v === undefined) { previo = null; return; }
      const x = equis(i);
      const y = estable ? H / 2
              : PISO - ((v - lo) / (hi - lo)) * (PISO - PAD);
      const sigue = previo !== null && tiempos[i] - previo <= HUECO_MS;
      d += (sigue ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      previo = tiempos[i];
    });
    const p = svgEl("path");
    p.setAttribute("d", d); p.setAttribute("fill", "none");
    p.setAttribute("stroke", color); p.setAttribute("stroke-width", "2");
    if (trazo) p.setAttribute("stroke-dasharray", trazo);
    svg.appendChild(p);
    series.push({ nombre, campo, fmt, delAire });

    const li = document.createElement("div");
    li.style.color = color;
    const muestra = svgEl("svg");
    muestra.setAttribute("width", "30");
    muestra.setAttribute("height", "10");
    muestra.setAttribute("aria-hidden", "true");
    muestra.style.marginRight = "6px";
    const ml = svgEl("line");
    ml.setAttribute("x1", "0"); ml.setAttribute("x2", "30");
    ml.setAttribute("y1", "5"); ml.setAttribute("y2", "5");
    ml.setAttribute("stroke", color); ml.setAttribute("stroke-width", "2");
    if (trazo) ml.setAttribute("stroke-dasharray", trazo);
    muestra.appendChild(ml);
    const b = document.createElement("b");
    b.textContent = nombre;
    const s = document.createElement("span");
    s.textContent = estable
      ? " estable en " + fmt(vals[vals.length - 1])
      : " " + fmt(lo) + " a " + fmt(hi);
    li.append(muestra, b, s);
    leyenda.appendChild(li);
  });

  // ── El cursor ──
  const cursor = svgEl("line");
  cursor.setAttribute("y1", PAD); cursor.setAttribute("y2", PISO);
  cursor.setAttribute("stroke", "#e8f0ea");
  cursor.setAttribute("stroke-width", "1");
  cursor.setAttribute("opacity", "0");
  svg.appendChild(cursor);

  const detalle = document.createElement("p");
  detalle.className = "sub detalle-hist";
  detalle.setAttribute("role", "status");
  detalle.setAttribute("aria-live", "polite");
  detalle.textContent = "Tocá el gráfico para ver los valores de un momento.";

  const alSeguir = ev => {
    const caja = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
    if (!caja || !caja.width) return;
    const rel = (ev.clientX - caja.left) / caja.width;   // 0..1
    //  Del dedo a una HORA, y de la hora al punto más cercano: con el eje
    //  de tiempo, el índice ya no es proporcional a la posición.
    const fr = Math.max(0, Math.min(1, (rel * W - PAD) / (W - 2 * PAD)));
    const tm = t0 + fr * span;
    let i = 0;
    for (let k = 1; k < tiempos.length; k++) {
      if (Math.abs(tiempos[k] - tm) < Math.abs(tiempos[i] - tm)) i = k;
    }
    const x = equis(i);
    cursor.setAttribute("x1", x); cursor.setAttribute("x2", x);
    cursor.setAttribute("opacity", "1");
    const partes = series.map(s => {
      const v = valorDe(filas[i], s.campo, s.delAire);
      return s.nombre + " " + (v === null || v === undefined ? "—" : s.fmt(v));
    });
    detalle.textContent = hhmm(filas[i].momento) + " · " + partes.join("  ·  ");
  };
  const alSalir = () => {
    cursor.setAttribute("opacity", "0");
    detalle.textContent = "Tocá el gráfico para ver los valores de un momento.";
  };
  if (svg.addEventListener) {
    svg.addEventListener("pointermove", alSeguir);
    svg.addEventListener("pointerdown", alSeguir);
    svg.addEventListener("pointerleave", alSalir);
  }

  svg.setAttribute("aria-label",
    "Curvas de las ultimas 24 horas, de " + hhmm(filas[0].momento) + " a " +
    hhmm(filas[filas.length - 1].momento) +
    ". Los valores estan en la leyenda de abajo.");
  host.appendChild(svg);
  host.appendChild(detalle);
  host.appendChild(leyenda);
  const nota = document.createElement("p");
  nota.className = "sub";
  //  La hora es la del TELÉFONO. Si el equipo está en otro huso, decirlo
  //  acá evita buscar un pico a una hora que no existió en la sala.
  nota.textContent = "El eje vertical no tiene unidad: cada curva usa su propia " +
    "escala para ocupar todo el alto. Lo que se compara es la forma, no la " +
    "altura. Las horas son las de este dispositivo (" +
    Intl.DateTimeFormat().resolvedOptions().timeZone + ").";
  host.appendChild(nota);
}

// ------------------------------------------------------------
//  Ciclo
// ------------------------------------------------------------
//  ¿El ÚLTIMO pedido falló del lado del teléfono (sin internet, error de
//  red)? Es distinto de «el equipo no publica»: uno manda a revisar el
//  teléfono, el otro la sala (auditoría integral 2026-10-10, CL-012).
let errorRed = false;

async function refrescar() {
  if (!equipoActual) return;
  //  La sala se captura ANTES de esperar: si mientras tanto se cambió de
  //  sala, la respuesta es de la anterior y se tira. Antes se pintaba el
  //  estado de A bajo el nombre de B (auditoría integral 2026-10-10).
  const eq = equipoActual;
  let res;
  try {
    res = await sb.from("estado")
      .select("datos,actualizado").eq("equipo_id", eq.id).maybeSingle();
  } catch (e) {
    res = { data: null, error: e };
  }
  if (equipoActual !== eq) return;
  const { data, error } = res;
  if (error) {
    //  Un pedido fallido NO borra lo que se sabía: se sigue mostrando con
    //  su edad (que la vuelve vieja sola) y la pastilla dice que el que no
    //  tiene conexión es el teléfono. Antes un solo error reemplazaba el
    //  estado por {} y la sala aparecía «sin configurar» por un instante
    //  de red mala.
    errorRed = true;
    if (ultimoEstado && ultimoEstado.cuando) {
      pintarInicio(ultimoEstado.d, ultimoEstado.cuando);
    } else {
      ultimoEstado = { d: {}, cuando: null };
      pintarInicio({}, null);
    }
    return;
  }
  errorRed = false;
  if (!data) {
    ultimoEstado = { d: {}, cuando: null };
    pintarInicio({}, null);
    return;
  }
  ultimoEstado = { d: data.datos || {}, cuando: new Date(data.actualizado) };
  //  La configuración viaja DENTRO del estado, en la misma foto. Si
  //  fueran por separado, la app podría quedarse con una configuración
  //  de hace media hora sobre un estado de ahora.
  const cfg = ultimoEstado.d.config;
  if (cfg && cfg.par) {
    ultimaConfig = {};
    for (const k in cfg.par) ultimaConfig[+k] = cfg.par[k];
  }
  pintarTodo();
}

async function abrirSala(eq) {
  equipoActual = eq;
  ver($("equipos"), false);
  ver($("sala"), true);
  document.body.classList.add("con-navinf");
  $("sala-nombre").textContent = eq.nombre;

  //  El rol se pide ANTES de pintar. Pintar con el rol de la sala
  //  anterior mostraría, por un instante, controles que esta persona no
  //  puede usar acá — y ese instante alcanza para que alguien toque.
  rolActual = null;
  const { data } = await sb.from("miembros")
    .select("rol").eq("equipo_id", eq.id).maybeSingle();
  //  Sin respuesta se asume lo MENOS permisivo. Al revés, un error de
  //  red dejaría la instalación abierta.
  rolActual = (data && data.rol) || "lectura";

  categoriaAbierta = null;
  destinoActual = "inicio";
  pestana("inicio");
  //  «Más» recuerda su última sub-sección abierta (conexion/equipos/
  //  gente/instalacion/cuenta) entre una sala y la siguiente, porque
  //  vive en el DOM y nadie la vuelve a ocultar al cambiar de sala. Sin
  //  este reset, alguien con varias salas que entró a "Personas y
  //  permisos" en la sala A, volvió al índice y abrió la sala B, ve los
  //  nombres y correos de LOS MIEMBROS DE A superpuestos en el contexto
  //  de B en cuanto toca el ícono «Más» -sin pasar por ninguna fila-.
  //  Se vuelve siempre a "conexion", que no expone datos de otra sala.
  if (typeof _abrirSubMas === "function") _abrirSubMas("conexion");
  refrescar();
  clearInterval(timer);
  timer = setInterval(refrescar, 10000);
}

//  Al volver de segundo plano (o recuperar la red) la app decía «en vivo»
//  con números de hace dos horas hasta que llegaba el próximo pedido.
//  Ahora, en el acto: se repinta con la edad REAL de lo que hay -que la
//  vuelve vieja si lo es- y se pide de nuevo (auditoría integral
//  2026-10-10, CL-012).
function alVolver() {
  if (!equipoActual || document.hidden) return;
  if (ultimoEstado) pintarInicio(ultimoEstado.d, ultimoEstado.cuando);
  refrescar();
}
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("visibilitychange", alVolver);
}
if (typeof window !== "undefined" && window.addEventListener) {
  window.addEventListener("online", alVolver);
}

//  Volver a la lista de salas. Hay que apagar el reloj: si no, el
//  refresco sigue pidiendo el estado de la sala que se acaba de dejar,
//  y al abrir otra quedan dos relojes pisándose.
function cerrarSala() {
  clearInterval(timer);
  timer = null;
  //  Las órdenes en vuelo son de ESTA sala: sus claves («rele1»,
  //  «ack-alarmas») se repiten en la próxima, que mostraría como
  //  «esperando» un control que no pidió nada (revisor, 2026-10-11).
  //  Las órdenes siguen en el servidor; `vigilar` ya no avisa fuera de
  //  su sala.
  enVuelo.clear();
  equipoActual = null;
  ultimoEstado = null;
  ultimaConfig = null;
  ver($("sala"), false);
  ver($("equipos"), true);
}

//  Cambia de destino en la barra inferior. `sub`, si se da, abre una
//  fila puntual de «Más» (por ejemplo, venir de la tarjeta de puesta en
//  marcha directo a «Equipos» sin pasar por la lista intermedia).
function pestana(cual, sub) {
  destinoActual = cual;
  ["inicio", "control", "hist", "mas"].forEach(id =>
    ver($("d-" + id), id === cual));
  document.querySelectorAll("#navinf button").forEach(b =>
    b.setAttribute("aria-pressed", b.dataset.d === cual ? "true" : "false"));
  if (cual === "hist") pintarHistorial();
  if (cual === "mas" && sub) {
    const btn = $("btn-mas-" + sub);
    if (btn) btn.click();
  }
}

window.LuxApp = { init(cliente) { sb = cliente; }, abrirSala, cerrarSala,
                  pestana, mandar, CMD, refrescar, dialogo,
                  reconocerSeguridad, silenciarSirena, enCastellano,
                  //  La sala actualmente abierta, para «Más → Personas y
                  //  permisos» y para actualizar el encabezado al
                  //  renombrar: vive acá y no en otra variable, para no
                  //  duplicar el mismo dato en dos scripts separados.
                  equipoActual: () => equipoActual };
