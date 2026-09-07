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
const PAR_SALIDA_FUERA = 96;

const EQUIPOS = ["libre", "extraccion", "ventilacion interna",
  "aire acondicionado", "calefaccion", "deshumidificador", "humidificador",
  "VALVULA DE CO2", "bomba de riego", "luminarias", "sirena",
  "luz UV", "luz roja", "luz far red"];

// Con datos más viejos que esto, el número desaparece.
const VIEJO_S = 90;

let sb = null, equipoActual = null, timer = null;
let ultimoEstado = null, ultimaConfig = null;
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
async function mandar(codigo, arg1, arg2, claveVuelo) {
  if (!equipoActual) return;
  if (claveVuelo !== undefined) enVuelo.set(claveVuelo, Date.now());
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
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const { data } = await sb.from("comandos")
      .select("estado,resultado").eq("id", id).maybeSingle();
    if (!data) continue;
    if (data.estado === "aplicado") {
      if (claveVuelo !== undefined) enVuelo.delete(claveVuelo);
      aviso("Hecho.", "ok"); refrescar(); return;
    }
    if (data.estado === "rechazado" || data.estado === "vencido") {
      if (claveVuelo !== undefined) enVuelo.delete(claveVuelo);
      aviso(data.resultado || "El equipo lo rechazó.", "err");
      pintarTodo(); return;
    }
  }
  if (claveVuelo !== undefined) enVuelo.delete(claveVuelo);
  //  Ni aplicado ni rechazado en un minuto: el equipo no lo tomó. NO se
  //  reintenta solo — repetir a ciegas una orden que puede haberse
  //  ejecutado es peor que no mandarla.
  aviso("El equipo no contestó. No se reintenta solo: verificá antes de repetir.",
        "err");
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
  Object.keys(window.PARAMETROS).forEach(k => {
    const id = +k;
    if (ultimaConfig[id] === undefined) return;
    const s = window.PARAMETROS[id].s || "Otros";
    if (!porSeccion.has(s)) porSeccion.set(s, []);
    porSeccion.get(s).push(id);
  });

  host.innerHTML = "";
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

  if (!host.children.length)
    host.innerHTML = '<p class="sub">El equipo todavía no mandó su configuración.</p>';
}

function filaControl(id) {
  const p = window.PARAMETROS[id];
  const v = ultimaConfig[id];
  const row = document.createElement("div");
  row.className = "fila" + (enVuelo.has(id) ? " esperando" : "");

  const t = document.createElement("span");
  t.className = "fila-t";
  t.textContent = p.t;
  row.appendChild(t);

  if (p.k === "llave") {
    const b = document.createElement("button");
    b.className = "llave" + (v ? " on" : "");
    b.setAttribute("role", "switch");
    b.setAttribute("aria-checked", v ? "true" : "false");
    b.setAttribute("aria-label", p.t);
    b.onclick = () => mandar(CMD.PARAMETRO, id, v ? 0 : 1, id);
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
    sel.onchange = () => mandar(CMD.PARAMETRO, id, +sel.value, id);
    row.appendChild(sel);
  } else {
    const val = document.createElement("span");
    val.className = "fila-v";
    val.textContent = fmtValor(v, p);
    const menos = document.createElement("button");
    menos.textContent = "−"; menos.setAttribute("aria-label", "bajar " + p.t);
    menos.onclick = () => mandar(CMD.PARAMETRO, id, siguiente(v, p, false), id);
    const mas = document.createElement("button");
    mas.textContent = "+"; mas.setAttribute("aria-label", "subir " + p.t);
    mas.onclick = () => mandar(CMD.PARAMETRO, id, siguiente(v, p, true), id);
    row.append(val, menos, mas);
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
    row.className = "fila";
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
    sel.onchange = () => mandar(CMD.ASIGNAR_SALIDA, o.ch, +sel.value, "rele" + o.ch);
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
    b.disabled = !o.tipo;
    b.setAttribute("aria-label",
        (o.fuera ? "volver a servicio el relé " : "marcar fuera de servicio el relé ")
        + o.ch);
    b.onclick = () => mandar(CMD.PARAMETRO, PAR_SALIDA_FUERA,
                             (o.ch << 8) | (o.fuera ? 0 : 1), "fuera" + o.ch);
    row.append(t, sel, est, b);
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
  const ev = [];
  const hhmm = m => String(Math.floor((m % 1440) / 60)).padStart(2, "0") + ":" +
                    String(m % 60).padStart(2, "0");

  const luzHab = c[21], luzOn = c[22], luzOff = c[23];
  if (luzHab && luzOn === luzOff) {
    ev.push([0, "El fotoperiodo está encendido pero enciende y apaga a la " +
                "misma hora: la luz no se va a prender nunca", "mal"]);
  } else if (luzHab) {
    ev.push([luzOn,  "Enciende la luz", "luz"]);
    ev.push([luzOff, "Apaga la luz", "luz"]);
    const purga = c[47] || 0;
    if (purga) {
      ev.push([(luzOff + purga) % 1440,
               "Termina la purga — " + purga + " min extrayendo", "purga"]);
    }

    const duracion = (luzOff - luzOn + 1440) % 1440;

    // La ventana de inyección, cuando cuelga del fotoperiodo.
    if (c[2] && c[7] === 2) {
      const demora = c[5] || 0, corte = c[6] || 0;
      if (demora + corte >= duracion) {
        ev.push([luzOn, "LA VENTANA DE CO2 NO SE ABRE NUNCA: la demora (" +
                 demora + " min) más el corte (" + corte + " min) superan las " +
                 (duracion / 60).toFixed(1) + " h de luz", "mal"]);
      } else {
        ev.push([(luzOn + demora) % 1440, "Puede empezar a inyectar CO2", "co2"]);
        ev.push([(luzOff - corte + 1440) % 1440, "Corta la inyección de CO2", "co2"]);
      }
    } else if (c[2] && c[7] === 0) {
      ev.push([0, "Inyecta también de noche: sin luz la planta no fotosintetiza " +
                  "y el gas se acumula sin que nadie lo use", "mal"]);
    }

    // El riego colgado de la luz: la espera y después el tren.
    if (c[20] && c[68] === 1) {
      const p0 = c[69] || 0, dur = c[70] || 0;
      const pausa = c[71] || 0, veces = c[72] || 0;
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
  if (error) { host.innerHTML = '<p class="sub err">' + error.message + "</p>"; return; }
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

function dibujarCurvas(host, filas) {
  const W = 860, H = 240, PAD = 6;
  host.innerHTML = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("width", "100%");
  svg.setAttribute("role", "img");
  const leyenda = document.createElement("div");
  leyenda.className = "leyenda";

  CURVAS.forEach(([nombre, campo, color, umbral, fmt]) => {
    const vals = filas.map(f => f[campo]).filter(v => v !== null && v !== undefined);
    if (vals.length < 2) return;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    //  Una variable quieta estirada a todo el alto es ruido del sensor
    //  dibujado como si fuera un evento. Debajo del umbral se dibuja
    //  chata en el medio y la leyenda dice «estable».
    const estable = (hi - lo) < umbral;
    let d = "";
    filas.forEach((f, i) => {
      const v = f[campo];
      if (v === null || v === undefined) return;
      const x = PAD + (i / (filas.length - 1)) * (W - 2 * PAD);
      const y = estable ? H / 2
              : H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
      d += (d ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
    });
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d); p.setAttribute("fill", "none");
    p.setAttribute("stroke", color); p.setAttribute("stroke-width", "2");
    svg.appendChild(p);

    const li = document.createElement("div");
    li.style.color = color;
    li.innerHTML = "<b></b><span></span>";
    li.querySelector("b").textContent = nombre;
    li.querySelector("span").textContent = estable
      ? " estable en " + fmt(vals[vals.length - 1])
      : " " + fmt(lo) + " a " + fmt(hi);
    leyenda.appendChild(li);
  });

  svg.setAttribute("aria-label",
    "Curvas de las últimas 24 horas. Los valores están en la leyenda de abajo.");
  host.appendChild(svg);
  host.appendChild(leyenda);
  const nota = document.createElement("p");
  nota.className = "sub";
  nota.textContent = "El eje vertical no tiene unidad: cada curva usa su propia " +
    "escala para ocupar todo el alto. Lo que se compara es la forma, no la altura.";
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

function abrirSala(eq) {
  equipoActual = eq;
  ver($("equipos"), false);
  ver($("sala"), true);
  $("sala-nombre").textContent = eq.nombre;
  refrescar();
  clearInterval(timer);
  timer = setInterval(refrescar, 10000);
}

function pestana(cual) {
  ["vista", "config", "reles-panel", "hist"].forEach(id =>
    ver($(id), id === cual));
  document.querySelectorAll("#pestanas button").forEach(b =>
    b.setAttribute("aria-pressed", b.dataset.p === cual ? "true" : "false"));
  if (cual === "hist") pintarHistorial();
}

window.LuxApp = { init(cliente) { sb = cliente; }, abrirSala, pestana,
                  mandar, CMD, refrescar };
