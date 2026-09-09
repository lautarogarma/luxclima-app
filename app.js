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
"use strict";

const $ = id => document.getElementById(id);
const ver = (el, s) => el && el.classList.toggle("oculto", !s);

const CMD = { ACK_SEGURIDAD: 1, ALARMA_ACK: 2, PARAMETRO: 9, ASIGNAR_SALIDA: 10 };
//  El canal va en el byte alto y el estado en el bajo, como todo
//  parámetro que habla de un canal.

const EQUIPOS = ["libre", "extraccion", "ventilacion interna",
  "aire acondicionado", "calefaccion", "deshumidificador", "humidificador",
  "VALVULA DE CO2", "bomba de riego", "luminarias", "sirena",
  "luz UV", "luz roja", "luz far red"];

// Con datos más viejos que esto, el número desaparece.
const VIEJO_S = 90;

let sb = null, equipoActual = null, timer = null;
let ultimoEstado = null, ultimaConfig = null;

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
  if (f === 1) return (v / 10).toFixed(1);
  if (f === 2) return String(Math.floor(v / 60)).padStart(2, "0") + ":" +
                      String(v % 60).padStart(2, "0");
  return String(v);
}

function pasoDe(p, subir) {
  // El «piso útil»: bajar de 18 grados a «sin límite» de a medio grado
  // son treinta y seis toques. Con el piso, el cero queda pegado al
  // valor más bajo con sentido.
  return { paso: p.paso || 1, piso: p.piso || 0, subir };
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
//  Se inserta en `comandos` y el equipo la busca. No se dispara nada
//  hacia el equipo: no acepta conexiones entrantes, y no debe. Un
//  puerto abierto hacia un controlador que maneja una válvula de gas lo
//  encuentran los buscadores de dispositivos expuestos en horas.
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

  const { data, error } = await sb.from("comandos").insert({
    equipo_id: equipoActual.id, codigo, arg1: arg1 | 0, arg2: arg2 | 0,
  }).select("id").maybeSingle();

  if (error) {
    if (claveVuelo !== undefined) enVuelo.delete(claveVuelo);
    aviso("No se pudo enviar: " + error.message, "err");
    pintarTodo();
    return;
  }
  vigilar(data.id, claveVuelo);
}

//  Se sigue el comando hasta que el equipo lo resuelve, y se muestra su
//  resultado CON LA CAUSA. Un «no se pudo» mudo manda a buscar cinco
//  cosas distintas a mano.
async function vigilar(id, claveVuelo) {
  let ultimo = "pendiente";
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const { data } = await sb.from("comandos")
      .select("estado,resultado").eq("id", id).maybeSingle();
    if (!data) continue;
    ultimo = data.estado;
    if (data.estado === "aplicado") {
      if (claveVuelo !== undefined) enVuelo.delete(claveVuelo);
      aviso("Hecho.", "ok"); refrescar(); return;
    }
    //  `indeterminado` es terminal y NO es un rechazo: el equipo se
    //  llevó la orden y nunca dijo qué pasó. Mezclarlo con «rechazado»
    //  haría creer que no se ejecutó, que es justo lo contrario de lo
    //  que hay que asumir.
    if (data.estado === "rechazado" || data.estado === "vencido" ||
        data.estado === "indeterminado") {
      if (claveVuelo !== undefined) enVuelo.delete(claveVuelo);
      aviso(data.resultado ||
            (data.estado === "indeterminado"
              ? "El equipo la tomó y no dijo qué pasó: pudo haberse ejecutado."
              : "El equipo lo rechazó."), "err");
      pintarTodo(); return;
    }
  }
  if (claveVuelo !== undefined) enVuelo.delete(claveVuelo);
  //  Un minuto sin resolución. Lo que se dice depende de dónde quedó, y
  //  la diferencia es la que importa: si el equipo NO la tomó, no pasó
  //  nada y se puede repetir; si LA TOMÓ y no contestó, la acción pudo
  //  haber ocurrido y repetirla a ciegas es peor que no mandarla.
  aviso(ultimo === "entregado"
        ? "El equipo la recibió pero no dijo qué pasó. Pudo haberse " +
          "ejecutado: verificá la sala antes de repetir."
        : "El equipo no la tomó: no se ejecutó. Revisá el enlace y " +
          "volvé a intentar.", "err");
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
//  Devuelve una promesa: `null` si se cancela; el texto escrito si pide
//  campo, o `true` si es sólo confirmar.
function dialogo(o) {
  return new Promise(resolve => {
    const fondo = document.createElement("div");
    fondo.className = "modal-fondo";
    const caja = document.createElement("div");
    caja.className = "modal";
    caja.setAttribute("role", "dialog");
    caja.setAttribute("aria-modal", "true");

    const h = document.createElement("h3");
    h.textContent = o.titulo;
    caja.appendChild(h);

    if (o.texto) {
      const p = document.createElement("p");
      p.className = "sub";
      p.textContent = o.texto;
      caja.appendChild(p);
    }

    let campo = null;
    if (o.campo !== undefined) {
      const lab = document.createElement("label");
      lab.className = "sub";
      lab.textContent = o.campo;
      lab.setAttribute("for", "modal-campo");
      campo = document.createElement("input");
      campo.id = "modal-campo";
      campo.type = "text";
      campo.value = o.valor || "";
      campo.autocomplete = "off";
      caja.append(lab, campo);
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

    const cerrar = r => {
      document.removeEventListener("keydown", tecla);
      if (fondo.remove) fondo.remove();
      resolve(r);
    };
    const tecla = e => {
      if (e.key === "Escape") cerrar(null);
      if (e.key === "Enter" && campo) aceptar.onclick();
    };
    cancelar.onclick = () => cerrar(null);
    aceptar.onclick = () => {
      if (!campo) return cerrar(true);
      const v = (campo.value || "").trim();
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
//  Pintado
// ------------------------------------------------------------
function edadSegundos(cuando) {
  return cuando ? (Date.now() - cuando.getTime()) / 1000 : null;
}

function pintarTodo() {
  if (!ultimoEstado) return;
  pintarSala(ultimoEstado.d, ultimoEstado.cuando);
  pintarConfig();
  pintarEquipos();
  pintarAgenda();
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

function medida(nombre, valor, unidad, clase) {
  const d = document.createElement("div");
  d.innerHTML = '<div class="sub" style="margin:0"></div>' +
                '<div class="val"><span class="num"></span><span class="uni"></span></div>';
  d.querySelector(".sub").textContent = nombre;
  d.querySelector(".num").textContent = valor;
  d.querySelector(".uni").textContent = " " + unidad;
  if (clase) d.querySelector(".val").classList.add(clase);
  return d;
}

//  ── La sala ──
function pintarSala(d, cuando) {
  const seg = edadSegundos(cuando);
  const viejo = seg === null || seg > VIEJO_S;

  const p = $("sala-edad");
  p.className = "pill" + (viejo ? "" : " on");
  p.textContent = seg === null ? "sin contacto"
                : viejo ? "hace " + Math.round(seg / 60) + " min" : "en vivo";

  //  El banner: lo que hay que atender antes que ningún número, y con
  //  la misma prioridad explícita que la pantalla. Apilar tres carteles
  //  hace que no se lea ninguno.
  const sg = d.seguridad || {};
  const b = $("banner");
  let tit = null, sub = null;
  if (sg.purga && sg.purgaOk) {
    tit = "PURGA ACTIVA — NO ENTRAR";
    sub = "Extracción forzada.";
  } else if (sg.purga) {
    tit = "PURGA NO CONFIRMADA — NO ENTRAR";
    sub = "Se ordenó y la extracción no respondió. Verificarla.";
  } else if (sg.parada) {
    tit = "PARADA DE EMERGENCIA ACCIONADA";
    sub = "La inyección está cortada. Rearmar en el tablero.";
  } else if (sg.puerta) {
    tit = "PUERTA ABIERTA";
    sub = "La inyección queda bloqueada mientras esté abierta.";
  }
  ver(b, !!tit);
  if (tit) { $("banner-tit").textContent = tit; $("banner-sub").textContent = sub; }

  // ── Medidas ──
  const m = d.medicion || {};
  const su = d.suelo || {};
  const host = $("medidas");
  host.innerHTML = "";
  host.classList.toggle("viejo", viejo);
  const n = x => (viejo || x === undefined || x === null) ? "—" : x;
  host.appendChild(medida("CO₂", n(m.co2), "ppm"));
  host.appendChild(medida("Temperatura", n(m.temp), "°C"));
  host.appendChild(medida("Humedad", n(m.hum), "%"));
  host.appendChild(medida("VPD", n(m.vpd), "kPa"));
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
  if (m.temp_cons) partes.push("consigna " + (m.temp_cons / 10).toFixed(1) + " °C");
  if (m.hum_cons)  partes.push((m.hum_cons / 10).toFixed(1) + " %");
  if (m.nodos !== undefined) partes.push(m.nodos + " sensores");
  if (su.discrepan) partes.push("las macetas no coinciden: riega por reloj");
  det.textContent = partes.join(" · ");
  det.className = "sub" + (su.discrepan ? " warn" : "");

  // ── Equipos ──
  const s = $("salidas");
  s.innerHTML = "";
  (d.salidas || []).forEach(o => {
    if (!o.tipo) return;
    const row = document.createElement("div");
    row.className = "renglon";
    const nom = document.createElement("span");
    nom.textContent = o.equipo || EQUIPOS[o.tipo] || "?";
    const est = document.createElement("span");
    est.className = "pill" + (o.falla ? " mal" : (o.real ? " on" : ""));
    est.textContent = o.falla ? "no cumple" : (o.real ? "encendido" : "apagado");
    const por = document.createElement("span");
    por.className = "sub por";
    por.textContent = o.motivo || "";
    row.append(nom, est, por);
    s.appendChild(row);
  });
  if (!s.children.length) s.innerHTML = '<p class="sub">Sin equipos asignados.</p>';

  // ── Alarmas ──
  const a = $("alarmas");
  const al = d.alarmas || [];
  a.innerHTML = "";
  if (!al.length) {
    a.innerHTML = '<p class="sub">Sin avisos.</p>';
  } else {
    al.forEach(x => {
      const r = document.createElement("div");
      r.className = "renglon";
      const t = document.createElement("span");
      t.textContent = x.texto || ("alarma " + x.id);
      t.className = x.sev >= 2 ? "err" : "warn";
      r.appendChild(t);
      a.appendChild(r);
    });
  }
  $("btn-ack").disabled = !d.sin_ver;
  $("btn-ack-seg").disabled = !(sg.enganchado);
}

//  ── Configuración ──
//  Las secciones tampoco se escriben aca: vienen en `parametros.js`,
//  puestas por el generador segun a que pantalla del tablero pertenece
//  cada fila.
//
//  Escribirlas a mano fue un error concreto y medido: puse «Minutos
//  respecto de UTC» dentro de CO2 y «Banda muerta» tomo el valor de
//  otro parametro, porque adivine los identificadores en vez de
//  leerlos. La app mostraba etiquetas con numeros que no les
//  correspondian, que es exactamente lo peor que puede hacer.
//
//  El orden es el de la pantalla, para que quien conoce el tablero
//  encuentre las cosas donde las tiene.
const ORDEN = ["CO2", "Temperatura y humedad de sala", "Riego y sustrato",
               "Fotoperiodo", "Mezcla de espectro", "Que atiende cada demanda",
               "Avisos", "Conexion", "Otros"];

function pintarConfig() {
  const host = $("config");
  if (!ultimaConfig) {
    host.innerHTML = '<p class="sub">Esperando la configuración del equipo…</p>';
    return;
  }
  const porSeccion = new Map();
  //  Los de instalación salen de su sección y se juntan al final, en su
  //  propia tarjeta. Un operador que entra a ajustar riego o humedad
  //  compartía pantalla con direcciones de bus y ruteos de equipo:
  //  palabras técnicas, cambios que no se deshacen de forma obvia, y
  //  presentados igual que un objetivo de humedad. Cuando todo se ve
  //  igual de seguro de tocar, todo se toca.
  const instalacion = [];
  Object.keys(window.PARAMETROS).forEach(k => {
    const id = +k;
    if (ultimaConfig[id] === undefined) return;
    if (window.PARAMETROS[id].inst) { instalacion.push(id); return; }
    const s = window.PARAMETROS[id].s || "Otros";
    if (!porSeccion.has(s)) porSeccion.set(s, []);
    porSeccion.get(s).push(id);
  });

  host.innerHTML = "";

  //  Si esta persona no puede ordenar, se dice UNA vez y arriba, en vez
  //  de repetirlo en cada fila.
  if (!puedeOperar()) {
    const c = tarjeta(null);
    c.appendChild(_p("sub", "Tu rol en esta sala es de sólo lectura: podés " +
      "ver todo y no cambiar nada. Para operarla, pedile al dueño de la " +
      "sala que te cambie el rol."));
    host.appendChild(c);
  }
  ORDEN.forEach(nombre => {
    const ids = porSeccion.get(nombre);
    if (!ids || !ids.length) return;
    const c = tarjeta(nombre);
    ids.forEach(id => c.appendChild(filaControl(id)));
    host.appendChild(c);
    porSeccion.delete(nombre);
  });
  //  Cualquier seccion que el generador invente y este orden no
  //  contemple va igual al final. Perder un control por no haberlo
  //  listado seria peor que mostrarlo fuera de lugar.
  porSeccion.forEach((ids, nombre) => {
    const c = tarjeta(nombre);
    ids.forEach(id => c.appendChild(filaControl(id)));
    host.appendChild(c);
  });

  //  ── Instalación y servicio ──
  //  Va al final, aparte, y con el motivo escrito. No se ESCONDE: quien
  //  no puede tocarla tiene que ver que existe y por qué no le
  //  corresponde, o va a buscarla creyendo que la aplicación no la
  //  tiene.
  if (instalacion.length) {
    const c = tarjeta("Instalación y servicio");
    c.appendChild(_p("sub", puedeInstalar()
      ? "Esto describe CÓMO está armada la sala: qué equipo hay en cada " +
        "demanda y en qué dirección del bus responde cada nodo. Se toca en " +
        "la puesta en marcha, no en el día a día — si no coincide con el " +
        "cableado, el equipo acciona el aparato equivocado."
      : "Esto describe cómo está armada la sala y sólo lo cambia el dueño. " +
        "Se muestra para que sepas qué hay configurado."));
    instalacion.forEach(id => c.appendChild(filaControl(id)));
    host.appendChild(c);
  }

  if (!host.children.length)
    host.innerHTML = '<p class="sub">El equipo todavía no mandó su configuración.</p>';
}

//  Un párrafo con texto puesto por `textContent`, que es la única forma
//  correcta de meter texto en la página.
function _p(clase, texto) {
  const e = document.createElement("p");
  e.className = clase;
  e.textContent = texto;
  return e;
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
    const val = document.createElement("span");
    val.className = "fila-v";
    //  Se sigue mostrando el valor CONFIRMADO, no el pedido. Mostrar el
    //  pedido haría creer que ya está aplicado; lo pedido se dice al
    //  lado del nombre, que es donde no se confunde con el estado real.
    val.textContent = fmtValor(v, p);
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

//  ── Los relés ──
function pintarEquipos() {
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
    const pendiente = enVuelo.get("rele" + o.ch) || enVuelo.get("fuera" + o.ch);
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
    sel.disabled = trabado || !puedeInstalar();
    //  Cambiar qué equipo maneja un relé NO es un ajuste de operación:
    //  es tocar la instalación. Un toque accidental en una pantalla que
    //  se abrió para mirar horas de uso puede dejar la extracción
    //  conectada al humidificador, y eso no se nota hasta que hace
    //  falta extraer. Por eso se pregunta, y la pregunta dice el antes
    //  y el después con las palabras del operador.
    sel.onchange = async () => {
      const nuevo = +sel.value;
      const antes = EQUIPOS[o.tipo || 0], despues = EQUIPOS[nuevo];
      const ok = await dialogo({
        titulo: "Cambiar qué maneja el relé " + o.ch,
        texto: "Ahora maneja «" + antes + "» y pasaría a manejar «" +
               despues + "». Esto cambia la instalación, no un ajuste " +
               "del día: si el cableado no acompaña, el equipo va a " +
               "accionar el aparato equivocado.",
        aceptar: "Cambiar",
        peligro: true,
      });
      //  Se vuelve a lo que hay DE VERDAD, no a lo elegido: el
      //  desplegable no puede quedar mostrando algo que nadie confirmó.
      if (!ok) { sel.value = o.tipo || 0; return; }
      mandar(CMD.ASIGNAR_SALIDA, o.ch, nuevo, "rele" + o.ch,
             "relé " + o.ch + " → " + despues);
    };
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
    b.textContent = o.fuera ? "volver" : "fuera";
    b.className = "chico" + (o.fuera ? " marcado" : "");
    //  Sin equipo asignado no hay nada que sacar de servicio; y con una
    //  orden en camino sobre este relé, tampoco. Marcar un relé fuera de
    //  servicio SÍ es operación: lo hace quien está arreglando algo, no
    //  quien instaló la sala.
    b.disabled = !o.tipo || trabado || !puedeOperar();
    b.setAttribute("aria-label",
        (o.fuera ? "volver a servicio el relé " : "marcar fuera de servicio el relé ")
        + o.ch);
    b.onclick = () => mandar(CMD.PARAMETRO, window.PAR.SALIDA_FUERA,
                             (o.ch << 8) | (o.fuera ? 0 : 1), "fuera" + o.ch,
                             "relé " + o.ch + (o.fuera ? " → vuelve a servicio"
                                                       : " → fuera de servicio"));
    row.append(t, sel, est, b);
    if (pendiente && pendiente.dice) {
      const q = document.createElement("span");
      q.className = "fila-pendiente";
      q.textContent = "Esperando: " + pendiente.dice;
      row.appendChild(q);
    }
    host.appendChild(row);
  });
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

    // El riego colgado de la luz: la espera y después el tren.
    if (c[P.RIEGO_HABILITADO] && c[P.RIEGO_VENTANA] === 1) {
      const p0 = c[P.RIEGO_P0] || 0, dur = c[P.RIEGO_P1_DUR] || 0;
      const pausa = c[P.RIEGO_P1_PAUSA] || 0, veces = c[P.RIEGO_P1_REP] || 0;
      if (!veces) {
        ev.push([luzOn, "Riego encendido y sin pulsos cargados", "mal"]);
      } else {
        const durMin = Math.ceil(dur / 60);
        for (let i = 0; i < veces; i++) {
          const desde = p0 + i * (pausa + durMin);
          const t = (luzOn + desde) % 1440;
          const dentro = desde < duracion;
          ev.push([t, "Riego " + (i + 1) + " de " + veces + " — " + dur + " s" +
                      (dentro ? "" : "  ·  CAE FUERA DE LAS HORAS DE LUZ"),
                   dentro ? "riego" : "mal"]);
        }
      }
    }
  }

  if (!ev.length) return null;
  ev.sort((a, b) => a[0] - b[0]);
  return ev.map(e => ({ hora: hhmm(e[0]), texto: e[1], clase: e[2] }));
}

function pintarAgenda() {
  const host = $("agenda");
  if (!host) return;
  const ev = proximas24();
  if (!ev) {
    host.innerHTML = '<p class="sub">Sin fotoperiodo cargado todavía no hay ' +
      'nada programado.</p>';
    return;
  }
  host.innerHTML = "";
  ev.forEach(e => {
    const r = document.createElement("div");
    r.className = "renglon";
    const h = document.createElement("span");
    h.className = "fila-v";
    h.style.minWidth = "62px";
    h.style.textAlign = "left";
    h.textContent = e.hora;
    const t = document.createElement("span");
    t.textContent = e.texto;
    if (e.clase === "mal") t.className = "err";
    r.append(h, t);
    host.appendChild(r);
  });
  const n = document.createElement("p");
  n.className = "sub";
  n.style.marginTop = "12px";
  n.textContent = "Es la agenda de lo que está programado, no una predicción de " +
    "la sala: no dice qué temperatura ni qué CO2 va a haber, dice qué va a hacer " +
    "el equipo y cuándo.";
  host.appendChild(n);
}

//  ── Historial ──
async function pintarHistorial() {
  const host = $("grafico");
  host.innerHTML = '<p class="sub">Buscando…</p>';
  const desde = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data, error } = await sb.from("historial")
    .select("momento,temp_c10,hum_pct10,co2_ppm,suelo_pct10,medicion_ok")
    .eq("equipo_id", equipoActual.id).gte("momento", desde)
    .order("momento", { ascending: true }).limit(600);
  if (error) {
    //  El mensaje va por `textContent`, no concatenado en `innerHTML`.
    //  Un texto de error puede reflejar parte de lo que se pidio, y
    //  concatenarlo en HTML lo convierte en un camino para inyectar
    //  marcado. No hace falta que sea explotable hoy: es la forma
    //  equivocada de poner texto ajeno en una pagina.
    host.innerHTML = "";
    const e = document.createElement("p");
    e.className = "sub err";
    e.textContent = "No se pudo leer el historial: " + error.message;
    host.appendChild(e);
    return;
  }
  if (!data || data.length < 2) {
    host.innerHTML = '<p class="sub">Todavía no hay historial suficiente. ' +
      'El equipo sube un punto por minuto desde que arranca.</p>';
    return;
  }
  dibujarCurvas(host, data);
}

//  Cada curva se escala a SU propio rango. Las unidades no se parecen
//  en nada -24 grados, 65 por ciento, 1200 ppm- y sobre un eje común la
//  temperatura es una raya pegada al piso. Lo que se compara es la
//  forma, y por eso el eje NO lleva números: sería una unidad inventada.
const CURVAS = [
  ["Temp", "temp_c10", "#F09A6A", 10, v => (v / 10).toFixed(1) + " °C"],
  ["Hum sala", "hum_pct10", "#5AA9E6", 30, v => (v / 10).toFixed(1) + " %"],
  ["CO₂", "co2_ppm", "#B48AD9", 80, v => v + " ppm"],
  ["Sustrato", "suelo_pct10", "#9A7B5A", 20, v => (v / 10).toFixed(1) + " %"],
];

//  El ancho de la banda de abajo, donde viven las horas. Sin ella el
//  gráfico mostraba una forma pero no dejaba responder «¿a qué hora
//  empezó el pico?», que es para lo único que uno abre el historial
//  cuando algo salió mal.
const EJE_ALTO = 34;

//  Cada serie lleva ADEMÁS de su color un trazo distinto. Con el color
//  solo, quien no lo distingue bien —o mira la pantalla con poca luz—
//  no puede asociar cada línea con su variable, y la leyenda de al lado
//  no ayuda si las cuatro líneas se ven iguales.
const TRAZOS = ["", "7 4", "2 4", "10 4 2 4"];

function svgEl(tag) {
  return document.createElementNS("http://www.w3.org/2000/svg", tag);
}

function hhmm(iso) {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" +
         String(d.getMinutes()).padStart(2, "0");
}

function dibujarCurvas(host, filas) {
  const W = 860, H = 240, PAD = 6;
  const ALTO = H + EJE_ALTO;
  const PISO = H - PAD;                 // dónde termina el área de dibujo
  host.innerHTML = "";
  const svg = svgEl("svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + ALTO);
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  const leyenda = document.createElement("div");
  leyenda.className = "leyenda";

  const equis = i => PAD + (i / (filas.length - 1)) * (W - 2 * PAD);

  // ── El eje de tiempo ──
  //  Cinco marcas: el principio, el final y tres en el medio. Menos no
  //  alcanza para ubicar nada; más satura una banda de 34 px.
  const marcas = [0, 0.25, 0.5, 0.75, 1]
    .map(f => Math.round(f * (filas.length - 1)));
  marcas.forEach((idx, n) => {
    const x = equis(idx);
    const linea = svgEl("line");
    linea.setAttribute("x1", x); linea.setAttribute("x2", x);
    linea.setAttribute("y1", PAD); linea.setAttribute("y2", PISO);
    linea.setAttribute("stroke", "#2a3a30");
    linea.setAttribute("stroke-width", "1");
    svg.appendChild(linea);

    const t = svgEl("text");
    t.setAttribute("x", x);
    t.setAttribute("y", H + 16);
    //  Las de las puntas se corren hacia adentro: centradas se salen
    //  del dibujo y el navegador las recorta.
    t.setAttribute("text-anchor", n === 0 ? "start"
                                : n === marcas.length - 1 ? "end" : "middle");
    t.setAttribute("fill", "#8aa294");
    t.setAttribute("font-size", "13");
    t.textContent = hhmm(filas[idx].momento);
    svg.appendChild(t);
  });

  const series = [];
  CURVAS.forEach(([nombre, campo, color, umbral, fmt], n) => {
    const vals = filas.map(f => f[campo]).filter(v => v !== null && v !== undefined);
    if (vals.length < 2) return;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    //  Una variable quieta estirada a todo el alto es ruido del sensor
    //  dibujado como si fuera un evento. Debajo del umbral se dibuja
    //  chata en el medio y la leyenda dice «estable».
    const estable = (hi - lo) < umbral;
    const trazo = TRAZOS[n % TRAZOS.length];
    let d = "";
    filas.forEach((f, i) => {
      const v = f[campo];
      if (v === null || v === undefined) return;
      const x = equis(i);
      const y = estable ? H / 2
              : PISO - ((v - lo) / (hi - lo)) * (PISO - PAD);
      d += (d ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    });
    const p = svgEl("path");
    p.setAttribute("d", d); p.setAttribute("fill", "none");
    p.setAttribute("stroke", color); p.setAttribute("stroke-width", "2");
    if (trazo) p.setAttribute("stroke-dasharray", trazo);
    svg.appendChild(p);
    series.push({ nombre, campo, fmt });

    const li = document.createElement("div");
    li.style.color = color;
    //  El trazo se repite en la leyenda: si la línea del gráfico es de
    //  puntos, la muestra de la leyenda también, y así se pueden
    //  emparejar sin depender del color.
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
  //  Una línea que sigue el dedo y una fila de valores debajo. Es lo
  //  que convierte «se ve un pico» en «el pico fue a las 14:20 con 1400
  //  ppm», que es la diferencia entre mirar y diagnosticar.
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
    const i = Math.max(0, Math.min(filas.length - 1,
                                   Math.round(rel * (filas.length - 1))));
    const x = equis(i);
    cursor.setAttribute("x1", x); cursor.setAttribute("x2", x);
    cursor.setAttribute("opacity", "1");
    const partes = series.map(s => {
      const v = filas[i][s.campo];
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
async function refrescar() {
  if (!equipoActual) return;
  const { data, error } = await sb.from("estado")
    .select("datos,actualizado").eq("equipo_id", equipoActual.id).maybeSingle();
  if (error || !data) {
    ultimoEstado = { d: {}, cuando: null };
    pintarSala({}, null);
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

  refrescar();
  clearInterval(timer);
  timer = setInterval(refrescar, 10000);
}

//  Volver a la lista de salas. Hay que apagar el reloj: si no, el
//  refresco sigue pidiendo el estado de la sala que se acaba de dejar,
//  y al abrir otra quedan dos relojes pisándose.
function cerrarSala() {
  clearInterval(timer);
  timer = null;
  equipoActual = null;
  ultimoEstado = null;
  ultimaConfig = null;
  ver($("sala"), false);
  ver($("equipos"), true);
}

function pestana(cual) {
  ["vista", "config", "reles-panel", "hist"].forEach(id =>
    ver($(id), id === cual));
  document.querySelectorAll("#pestanas button").forEach(b =>
    b.setAttribute("aria-pressed", b.dataset.p === cual ? "true" : "false"));
  if (cual === "hist") pintarHistorial();
}

window.LuxApp = { init(cliente) { sb = cliente; }, abrirSala, cerrarSala,
                  pestana, mandar, CMD, refrescar, dialogo };
