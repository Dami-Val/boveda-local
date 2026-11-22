import { nueva, abrir, cifrar, importarCSV, exportarCSV, generar, purgarPapelera, DIAS_PAPELERA, llaveDe, abrirConLlave } from './vault.js';
import { ELEGIBLES, UI } from './iconos.js';

// Comandos nativos de Tauri (src-tauri/src/lib.rs). Los errores llegan como texto (p. ej. el motivo de Windows Hello).
const { invoke } = window.__TAURI__.core;
const helloActivo = () => invoke('hello_estado').catch(() => false);
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...hijos) => { const n = Object.assign(document.createElement(tag), props); n.append(...hijos); return n; };

const PAPELERA = '\u0000papelera'; // valor de vista que no puede chocar con un nombre de carpeta
const DIA = 864e5;
const TONOS = ['Azul', 'Verde', 'Ámbar', 'Ciruela', 'Petróleo', 'Violeta', 'Rojo', 'Gris'];
const ACENTOS = { pelicula: 'Película', musica: 'Música', avion: 'Avión', maletin: 'Maletín', codigo: 'Código', corazon: 'Corazón', tele: 'Televisión', mundo: 'Internet' };
const nombreIcono = (k) => ACENTOS[k] || k[0].toUpperCase() + k.slice(1);

// Ícono Phosphor (peso regular, como en Cuentas Claras).
function svg(d, tam = 18) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 256 256', width: tam, height: tam, fill: 'currentColor', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
}
const botonIcono = (icono, etiqueta, onclick, clase = '') =>
  el('button', { type: 'button', className: `icono-boton ${clase}`, title: etiqueta, ariaLabel: etiqueta, onclick }, svg(UI[icono]));
for (const b of document.querySelectorAll('[data-icono]')) b.prepend(svg(UI[b.dataset.icono]));

// Las preferencias visuales no son secretas: van en localStorage para verse ya en la pantalla de bloqueo.
// acento '' = el del tema (la tinta azul de Papel de vidrio cambia entre claro y oscuro).
const DEF = { tema: 'vidrio', acento: '', letra: 15, radio: 8, bloqueoMin: 10, portapapelesSeg: 30, orden: 'nombre', genLong: 20, mayus: true, minus: true, numeros: true, simbolos: true };
const CLAVE_AJUSTES = 'ajustes-vidrio';
let ajustes = { ...DEF };
try { Object.assign(ajustes, JSON.parse(localStorage.getItem(CLAVE_AJUSTES)) || {}); } catch { /* sin almacenamiento: valores por defecto */ }

let archivo = null;   // bóveda cifrada tal como está en disco
let sesion = null;    // { clave, salt, iter } mientras está desbloqueada
let entradas = [];
let carpetas = [];
let estilos = {};     // ícono y color por carpeta: { nombre: { icono, color } }
let vista = null;     // null = todas, PAPELERA o el nombre de una carpeta
let editando = null;
let temporizador;

function aplicarAjustes() {
  const r = document.documentElement;
  r.dataset.tema = ajustes.tema;
  if (ajustes.acento) r.style.setProperty('--acento', ajustes.acento);
  else r.style.removeProperty('--acento');
  r.style.setProperty('--radio', ajustes.radio + 'px');
  r.style.fontSize = ajustes.letra + 'px';
}

function avisar(texto) {
  const a = $('#aviso');
  a.textContent = texto; a.hidden = false;
  clearTimeout(avisar.t); avisar.t = setTimeout(() => { a.hidden = true; }, 3500);
}


const MOTIVOS_HELLO = {
  Canceled: 'Cancelaste la verificación de Windows Hello.',
  DeviceNotPresent: 'Este equipo no tiene Windows Hello.',
  NotConfiguredForUser: 'Configura un PIN, huella o cara en Configuración de Windows → Cuentas → Opciones de inicio de sesión.',
  DisabledByPolicy: 'Windows Hello está desactivado por una directiva del equipo.',
  RetriesExhausted: 'Demasiados intentos fallidos de Windows Hello.',
  DeviceBusy: 'Windows Hello está ocupado; intenta de nuevo.',
};
const motivoHello = (e) => MOTIVOS_HELLO[e] || 'No se pudo usar Windows Hello.';

async function guardar() {
  try {
    archivo = await cifrar({ entradas, carpetas, estilos }, sesion);
    await invoke('guardar_boveda', { contenido: JSON.stringify(archivo) });
  } catch (e) {
    avisar('No se pudo guardar: ' + (e.message || e) + '. Revisa que la carpeta de Bóveda no sea de solo lectura.');
    throw e;
  }
}

// Botón destructivo que pide un segundo clic. Con ícono, el segundo paso muestra el texto.
function botonPeligro(texto, accion, icono) {
  const b = icono ? botonIcono(icono, texto, null, 'peligro') : el('button', { className: 'peligro chico', textContent: texto });
  b.onclick = () => {
    if (b.dataset.confirmar) return accion();
    b.dataset.confirmar = '1';
    b.className = 'peligro chico';
    b.replaceChildren('¿Seguro? Clic otra vez');
  };
  return b;
}

// ---------- ícono con color (avatar) ----------
// Como el Avatar de Cuentas Claras: tono determinista por nombre salvo que el usuario elija otro.
function tonoAuto(nombre) {
  let h = 0;
  for (const ch of nombre) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 6;
}
function avatar(nombre, { icono = '', color = '' } = {}, clase = '') {
  const tono = color === '' || color === undefined ? tonoAuto(nombre) : color;
  const iniciales = nombre.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0].toUpperCase()).join('') || '?';
  return el('span', { className: `avatar tono-${tono} ${clase}`, ariaHidden: 'true' }, ELEGIBLES[icono] ? svg(ELEGIBLES[icono]) : iniciales);
}

// Selector de ícono y color con vista previa; lo comparten el editor de entradas y el de carpetas.
function crearSelector(contenedor, grupo, nombreActual) {
  let previa = el('span');
  const radio =(name, value, etiqueta) => el('input', { type: 'radio', name, value, ariaLabel: etiqueta });
  const iconos = el('div', { className: 'iconos' },
    ...['', ...Object.keys(ELEGIBLES)].map((k) => el('label', { className: 'icono', title: k ? nombreIcono(k) : 'Iniciales' },
      radio(`${grupo}-icono`, k, k ? nombreIcono(k) : 'Iniciales'),
      k ? svg(ELEGIBLES[k]) : el('span', { textContent: 'Aa', ariaHidden: 'true' }))));
  const colores = el('div', { className: 'colores' },
    el('label', { className: 'muestra auto', title: 'Color automático' }, radio(`${grupo}-color`, '', 'Color automático'), el('span', { textContent: 'Auto', ariaHidden: 'true' })),
    ...TONOS.map((t, i) => el('label', { className: `muestra tono-${i}`, title: t }, radio(`${grupo}-color`, String(i), t))));
  contenedor.replaceChildren(el('div', { className: 'selector' }, previa, el('div', {}, iconos, colores)));

  const leer = () => {
    const v = (n) => contenedor.querySelector(`input[name=${grupo}-${n}]:checked`)?.value || '';
    const color = v('color');
    return { icono: v('icono'), color: color === '' ? '' : Number(color) };
  };
  const actualizar = () => previa.replaceWith(previa = avatar(nombreActual() || '?', leer(), 'grande'));
  contenedor.addEventListener('change', actualizar);
  return {
    poner({ icono = '', color = '' } = {}) {
      const icon = ELEGIBLES[icono] ? icono : ''; // los emojis de versiones anteriores quedan como iniciales
      for (const r of contenedor.querySelectorAll(`input[name=${grupo}-icono]`)) r.checked = r.value === icon;
      for (const r of contenedor.querySelectorAll(`input[name=${grupo}-color]`)) r.checked = r.value === String(color);
      actualizar();
    },
    leer,
    actualizar,
  };
}

// ---------- bloqueo ----------
async function pantallaBloqueo() {
  sesion = null; entradas = []; carpetas = []; estilos = {}; $('#lista').replaceChildren();
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('#app').hidden = true; $('#bloqueo').hidden = false;
  $('#maestra').value = ''; $('#confirmar').value = ''; $('#error-bloqueo').textContent = '';
  try {
    const texto = await invoke('leer_boveda');
    archivo = texto ? JSON.parse(texto) : null;
  } catch (e) { $('#error-bloqueo').textContent = 'No se pudo leer boveda.json: ' + e; return; }
  const crear = !archivo;
  $('#titulo-bloqueo').textContent = crear ? 'Crea tu bóveda' : 'Bóveda bloqueada';
  $('#ayuda-bloqueo').textContent = crear ? 'Elige una contraseña maestra de al menos 12 caracteres. Si la olvidas, no hay forma de recuperar tus datos.' : '';
  $('#grupo-confirmar').hidden = !crear;
  $('#btn-bloqueo').textContent = crear ? 'Crear bóveda' : 'Desbloquear';
  $('#btn-hello').hidden = crear || !(await helloActivo());
  $('#maestra').focus();
}

// Común a contraseña y Windows Hello.
async function entrar({ datos, ...llaves }) {
  sesion = llaves;
  entradas = datos.entradas || [];
  carpetas = [...new Set([...(datos.carpetas || []), ...entradas.map((e) => e.carpeta).filter(Boolean)])];
  estilos = datos.estilos || {};
  const antes = entradas.length;
  entradas = purgarPapelera(entradas, Date.now());
  if (entradas.length !== antes) { await guardar(); avisar(`Se borraron ${antes - entradas.length} entradas con más de ${DIAS_PAPELERA} días en la papelera.`); }
  $('#bloqueo').hidden = true; $('#app').hidden = false;
  vista = null; reiniciarTemporizador(); render(); $('#buscar').focus();
}

$('#form-bloqueo').onsubmit = async (ev) => {
  ev.preventDefault();
  const pw = $('#maestra').value, error = $('#error-bloqueo'), btn = $('#btn-bloqueo');
  error.textContent = '';
  btn.disabled = true;
  try {
    if (archivo) {
      let abierta;
      try { abierta = await abrir(archivo, pw); } catch { error.textContent = 'Contraseña incorrecta.'; return; }
      await entrar(abierta);
    } else {
      if (pw.length < 12) { error.textContent = 'Debe tener al menos 12 caracteres.'; return; }
      if (pw !== $('#confirmar').value) { error.textContent = 'Las contraseñas no coinciden.'; return; }
      sesion = await nueva(pw); entradas = []; carpetas = []; estilos = {};
      await guardar();
      await entrar({ ...sesion, datos: { entradas: [], carpetas: [], estilos: {} } });
    }
  } finally { btn.disabled = false; }
};

$('#btn-hello').onclick = async () => {
  const error = $('#error-bloqueo'), btn = $('#btn-hello');
  error.textContent = ''; btn.disabled = true;
  try {
    const llave = await invoke('hello_desbloquear');
    let abierta;
    try { abierta = await abrirConLlave(archivo, llave); } catch {
      await invoke('hello_borrar');
      btn.hidden = true;
      error.textContent = 'Windows Hello ya no corresponde a esta bóveda. Entra con tu contraseña y actívalo de nuevo en Ajustes.';
      return;
    }
    await entrar(abierta);
  } catch (e) { error.textContent = motivoHello(e); }
  finally { btn.disabled = false; }
};

function reiniciarTemporizador() {
  clearTimeout(temporizador);
  if (sesion) temporizador = setTimeout(pantallaBloqueo, ajustes.bloqueoMin * 60000);
}
for (const t of ['pointerdown', 'keydown', 'wheel']) addEventListener(t, reiniciarTemporizador, { passive: true });
$('#btn-bloquear').onclick = pantallaBloqueo;

// ---------- lista ----------
const ordenar = (a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' });

function render() {
  const q = $('#buscar').value.trim().toLowerCase();
  const activas = entradas.filter((e) => !e.borrada);
  const enPapelera = entradas.filter((e) => e.borrada);
  carpetas.sort(ordenar);
  if (vista !== null && vista !== PAPELERA && !carpetas.includes(vista)) vista = null;

  const boton = (icono, texto, cuenta, valor, clase = '') => {
    const b = el('button', { className: `nav ${clase}`, onclick: () => { vista = valor; render(); } },
      icono, el('span', { textContent: texto }), el('span', { className: 'cuenta', textContent: cuenta }));
    b.setAttribute('aria-current', String(valor === vista));
    return b;
  };
  const iconoCarpeta = (c) => {
    const { icono, color } = estilos[c] || {};
    const s = svg(ELEGIBLES[icono] || ELEGIBLES.carpeta);
    if (color !== '' && color !== undefined) s.classList.add(`tinta-${color}`);
    return s;
  };
  $('#carpetas').replaceChildren(
    boton(svg(UI.todas), 'Todas', activas.length, null),
    ...carpetas.map((c) => boton(iconoCarpeta(c), c, activas.filter((e) => e.carpeta === c).length, c)),
    boton(svg(UI.papelera), 'Papelera', enPapelera.length, PAPELERA, 'papelera'),
  );
  $('#lista-carpetas').replaceChildren(...carpetas.map((c) => el('option', { value: c })));

  // título y acciones de la vista
  $('#titulo-vista').textContent = vista === null ? 'Todas' : vista === PAPELERA ? 'Papelera' : vista;
  const acciones = [];
  if (vista === PAPELERA && enPapelera.length) {
    acciones.push(botonPeligro('Vaciar papelera', async () => { entradas = activas; render(); await guardar(); avisar('Papelera vaciada.'); }));
  } else if (vista !== null && vista !== PAPELERA) {
    const carpeta = vista;
    acciones.push(botonIcono('editar', 'Editar carpeta', () => dialogoCarpeta(carpeta)), botonPeligro('Eliminar carpeta', () => eliminarCarpeta(carpeta), 'borrar'));
  }
  $('#acciones-vista').replaceChildren(...acciones);

  const base = vista === PAPELERA ? enPapelera : activas.filter((e) => vista === null || e.carpeta === vista);
  const visibles = base
    .filter((e) => [e.nombre, e.usuario, e.url, e.notas].some((x) => (x || '').toLowerCase().includes(q)))
    .sort(vista === PAPELERA ? (a, b) => b.borrada - a.borrada
      : ajustes.orden === 'reciente' ? (a, b) => (b.editada || 0) - (a.editada || 0) : (a, b) => ordenar(a.nombre, b.nombre));
  $('#lista').replaceChildren(...visibles.map(vista === PAPELERA ? filaPapelera : fila));
  $('#vacio').hidden = visibles.length > 0;
  $('#vacio').textContent = q ? 'Nada coincide con la búsqueda.'
    : vista === PAPELERA ? `La papelera está vacía. Lo que borres se queda aquí ${DIAS_PAPELERA} días.`
      : 'Aún no hay entradas aquí. Crea una o importa un CSV.';
}

function fila(e) {
  const botones = [];
  if (e.usuario) botones.push(botonIcono('copiarUsuario', `Copiar usuario de ${e.nombre}`, () => copiar(e.usuario, 'Usuario copiado')));
  if (e.password) botones.push(botonIcono('copiarPassword', `Copiar contraseña de ${e.nombre}`, () => copiar(e.password, 'Contraseña copiada')));
  const url = abrible(e.url);
  if (url) botones.push(botonIcono('abrir', `Abrir ${e.nombre} en tu navegador`, () => abrirSitio(url)));
  return el('li', {},
    avatar(e.nombre, e),
    el('button', { className: 'info', onclick: () => editar(e) }, el('b', { textContent: e.nombre }), el('small', { textContent: e.usuario || e.url || ' ' })),
    el('span', { className: 'acciones-fila' }, ...botones));
}

function filaPapelera(e) {
  const dias = Math.max(0, Math.ceil((e.borrada + DIAS_PAPELERA * DIA - Date.now()) / DIA));
  return el('li', {},
    avatar(e.nombre, e),
    el('div', { className: 'info' }, el('b', { textContent: e.nombre }), el('small', { textContent: `Se borra definitivamente en ${dias} ${dias === 1 ? 'día' : 'días'}` })),
    el('span', { className: 'acciones-fila' },
      botonIcono('restaurar', `Restaurar ${e.nombre}`, async () => {
        delete e.borrada;
        if (e.carpeta && !carpetas.includes(e.carpeta)) carpetas.push(e.carpeta);
        render(); await guardar(); avisar('Entrada restaurada.');
      }),
      botonPeligro(`Borrar ${e.nombre} definitivamente`, async () => { entradas = entradas.filter((x) => x !== e); render(); await guardar(); avisar('Borrada definitivamente.'); }, 'borrar')));
}

// solo http(s): un CSV podría traer "javascript:" en la URL
function abrible(u) {
  if (!u) return null;
  const conEsquema = /^[a-z]+:/i.test(u) ? u : 'https://' + u;
  try { const x = new URL(conEsquema); return ['http:', 'https:'].includes(x.protocol) ? x.href : null; } catch { return null; }
}

async function abrirSitio(url) {
  try { await invoke('abrir_url', { url }); } catch { avisar('No se pudo abrir el sitio.'); }
}

async function copiar(texto, mensaje) {
  try {
    await navigator.clipboard.writeText(texto);
    avisar(`${mensaje}. Se borrará en ${ajustes.portapapelesSeg} s.`);
    clearTimeout(copiar.t);
    // ponytail: el navegador solo deja borrar el portapapeles si la ventana tiene el foco; si no, queda copiado
    copiar.t = setTimeout(() => navigator.clipboard.writeText('').catch(() => {}), ajustes.portapapelesSeg * 1000);
  } catch { avisar('No se pudo copiar.'); }
}

$('#buscar').oninput = render;

// ---------- carpetas ----------
let carpetaEditando = null;
const selectorCarpeta = crearSelector($('#selector-carpeta'), 'carpeta', () => $('#c-nombre').value.trim());
$('#c-nombre').addEventListener('input', () => selectorCarpeta.actualizar());

function dialogoCarpeta(actual) {
  carpetaEditando = actual;
  $('#titulo-carpeta').textContent = actual ? 'Editar carpeta' : 'Nueva carpeta';
  $('#c-nombre').value = actual || '';
  selectorCarpeta.poner(estilos[actual] || { icono: 'carpeta' });
  $('#error-carpeta').textContent = '';
  $('#dlg-carpeta').showModal();
}

$('#btn-nueva-carpeta').onclick = () => dialogoCarpeta(null);
$('#btn-cancelar-carpeta').onclick = () => $('#dlg-carpeta').close();
$('#form-carpeta').onsubmit = async (ev) => {
  ev.preventDefault();
  const nombre = $('#c-nombre').value.trim();
  if (!nombre) return;
  if (nombre !== carpetaEditando && carpetas.some((c) => c.toLowerCase() === nombre.toLowerCase())) {
    $('#error-carpeta').textContent = 'Ya existe una carpeta con ese nombre.'; return;
  }
  if (carpetaEditando) {
    for (const e of entradas) if (e.carpeta === carpetaEditando) e.carpeta = nombre;
    carpetas = carpetas.map((c) => (c === carpetaEditando ? nombre : c));
    delete estilos[carpetaEditando];
  } else carpetas.push(nombre);
  estilos[nombre] = selectorCarpeta.leer();
  vista = nombre;
  $('#dlg-carpeta').close(); render();
  await guardar(); avisar(carpetaEditando ? 'Carpeta actualizada.' : 'Carpeta creada.');
};

async function eliminarCarpeta(nombre) {
  const afectadas = entradas.filter((e) => e.carpeta === nombre);
  for (const e of afectadas) e.carpeta = '';
  carpetas = carpetas.filter((c) => c !== nombre);
  delete estilos[nombre];
  vista = null; render();
  await guardar();
  const n = afectadas.length;
  avisar(n ? `Carpeta eliminada. ${n} ${n === 1 ? 'entrada quedó' : 'entradas quedaron'} sin carpeta.` : 'Carpeta eliminada.');
}

// ---------- editor ----------
const CAMPOS = ['nombre', 'usuario', 'password', 'url', 'carpeta', 'totp', 'notas'];
const form = $('#form-entrada');
const selectorEntrada = crearSelector($('#selector-entrada'), 'entrada', () => $('#f-nombre').value.trim());
$('#f-nombre').addEventListener('input', () => selectorEntrada.actualizar());

function mostrarPassword(ver) {
  $('#f-password').type = ver ? 'text' : 'password';
  const etiqueta = ver ? 'Ocultar contraseña' : 'Mostrar contraseña';
  Object.assign($('#btn-ver'), { title: etiqueta, ariaLabel: etiqueta });
  $('#btn-ver').replaceChildren(svg(UI[ver ? 'ocultar' : 'ver']));
}

function editar(e) {
  editando = e;
  $('#titulo-entrada').textContent = e ? 'Editar entrada' : 'Nueva entrada';
  for (const c of CAMPOS) form.elements[c].value = e?.[c] || '';
  if (!e && vista !== null && vista !== PAPELERA) form.elements.carpeta.value = vista;
  selectorEntrada.poner(e || {});
  mostrarPassword(false);
  $('#btn-eliminar').hidden = !e;
  $('#dlg-entrada').showModal();
}

$('#btn-nueva').onclick = () => editar(null);
$('#btn-cancelar').onclick = () => $('#dlg-entrada').close();
$('#btn-ver').onclick = () => mostrarPassword($('#f-password').type === 'password');
$('#btn-generar').onclick = () => {
  try { $('#f-password').value = generar(ajustes.genLong, ajustes); mostrarPassword(true); }
  catch (e) { avisar(e.message + ' Revisa Ajustes.'); }
};

form.onsubmit = async () => {
  const datos = Object.fromEntries(CAMPOS.map((c) => [c, form.elements[c].value.trim()]));
  datos.password = form.elements.password.value; // la contraseña no se recorta: los espacios pueden ser parte de ella
  Object.assign(datos, selectorEntrada.leer(), { editada: Date.now() });
  if (datos.carpeta && !carpetas.includes(datos.carpeta)) carpetas.push(datos.carpeta);
  if (editando) Object.assign(editando, datos);
  else entradas.push({ id: crypto.randomUUID(), ...datos });
  render();
  await guardar(); avisar('Guardado.');
};

$('#btn-eliminar').onclick = async () => {
  editando.borrada = Date.now();
  $('#dlg-entrada').close(); render();
  await guardar(); avisar(`Movida a la papelera. Se borra en ${DIAS_PAPELERA} días.`);
};

// ---------- importar y exportar ----------
$('#btn-importar').onclick = () => $('#archivo-csv').click();
$('#archivo-csv').onchange = async (ev) => {
  const f = ev.target.files[0]; ev.target.value = '';
  if (!f) return;
  try {
    const nuevas = importarCSV(await f.text());
    const clave = (e) => [e.nombre, e.usuario, e.password].join('\u0000');
    const existentes = new Set(entradas.filter((e) => !e.borrada).map(clave));
    const agregar = nuevas.filter((e) => !existentes.has(clave(e)) && existentes.add(clave(e)));
    entradas.push(...agregar.map((e) => ({ ...e, icono: '', color: '', editada: Date.now() })));
    for (const e of agregar) if (e.carpeta && !carpetas.includes(e.carpeta)) carpetas.push(e.carpeta);
    render();
    await guardar();
    const dup = nuevas.length - agregar.length;
    avisar(`Importadas ${agregar.length}${dup ? `, ${dup} duplicadas omitidas` : ''}. Borra el CSV de tu equipo.`);
  } catch (e) { avisar('No se pudo importar: ' + e.message); }
};

const formExportar = $('#form-exportar');
$('#btn-exportar').onclick = () => { formExportar.reset(); $('#error-exportar').textContent = ''; $('#dlg-exportar').showModal(); };
$('#btn-cancelar-exportar').onclick = () => $('#dlg-exportar').close();
formExportar.onsubmit = async (ev) => {
  ev.preventDefault();
  const btn = $('#btn-confirmar-exportar');
  btn.disabled = true;
  try {
    try { await abrir(archivo, $('#x-maestra').value); } catch { $('#error-exportar').textContent = 'Contraseña incorrecta.'; return; }
    const activas = entradas.filter((e) => !e.borrada);
    const hoy = new Date().toLocaleDateString('sv-SE'); // AAAA-MM-DD
    let ruta;
    try { ruta = await invoke('exportar_csv', { contenido: exportarCSV(activas), nombre: `boveda-${hoy}.csv` }); }
    catch (e) { $('#error-exportar').textContent = 'No se pudo guardar el archivo: ' + e; return; }
    formExportar.reset(); $('#dlg-exportar').close();
    avisar(`Exportadas ${activas.length} entradas a ${ruta}. Bórralo cuando ya no lo necesites.`);
  } finally { btn.disabled = false; }
};

// ---------- ajustes ----------
const formAjustes = $('#form-ajustes');
$('#btn-ajustes').onclick = async () => {
  for (const i of formAjustes.elements) if (i.name) i[i.type === 'checkbox' ? 'checked' : 'value'] = ajustes[i.name];
  mostrarAcento();
  const activo = await helloActivo();
  $('#btn-hello-ajustes').textContent = activo ? 'Desactivar Windows Hello' : 'Activar Windows Hello';
  $('#dlg-ajustes').showModal();
};
formAjustes.oninput = (ev) => {
  const i = ev.target;
  if (!i.name) return;
  if (i.type === 'checkbox') ajustes[i.name] = i.checked;
  else if (i.type === 'number') { if (i.value === '' || !i.checkValidity()) return; ajustes[i.name] = Number(i.value); }
  else ajustes[i.name] = i.value;
  if (i.name === 'tema') ajustes.acento = ''; // cada tema trae su propio acento
  try { localStorage.setItem(CLAVE_AJUSTES, JSON.stringify(ajustes)); } catch { /* se aplica solo en esta sesión */ }
  aplicarAjustes(); reiniciarTemporizador(); render();
  if (i.name === 'tema') mostrarAcento();
};

// El selector de color no admite vacío: muestra el acento efectivo del tema.
function mostrarAcento() {
  $('#a-acento').value = ajustes.acento || getComputedStyle(document.documentElement).getPropertyValue('--acento').trim();
}

// ---------- Windows Hello ----------
const formHello = $('#form-hello');
$('#btn-hello-ajustes').onclick = async () => {
  if (await helloActivo()) {
    await invoke('hello_borrar');
    $('#btn-hello-ajustes').textContent = 'Activar Windows Hello';
    avisar('Windows Hello desactivado. Entra con tu contraseña maestra.');
    return;
  }
  $('#dlg-ajustes').close();
  formHello.reset(); $('#error-hello').textContent = '';
  $('#dlg-hello').showModal();
};
$('#btn-cancelar-hello').onclick = () => $('#dlg-hello').close();
formHello.onsubmit = async (ev) => {
  ev.preventDefault();
  const error = $('#error-hello'), btn = $('#btn-activar-hello');
  error.textContent = ''; btn.disabled = true;
  try {
    let llave;
    try { llave = await llaveDe(archivo, $('#h-maestra').value); } catch { error.textContent = 'Contraseña incorrecta.'; return; }
    error.textContent = 'Confirma con Windows Hello en la ventana que aparece…';
    try { await invoke('hello_activar', { llave }); } catch (e) { error.textContent = motivoHello(e); return; }
    formHello.reset(); $('#dlg-hello').close();
    avisar('Windows Hello activado. La próxima vez podrás entrar con él.');
  } finally { btn.disabled = false; }
};

// ---------- contraseña maestra ----------
const formMaestra = $('#form-maestra');
$('#btn-abrir-maestra').onclick = () => {
  $('#dlg-ajustes').close();
  formMaestra.reset(); $('#error-maestra').textContent = '';
  $('#dlg-maestra').showModal();
};
$('#btn-cancelar-maestra').onclick = () => $('#dlg-maestra').close();
formMaestra.onsubmit = async (ev) => {
  ev.preventDefault();
  const error = $('#error-maestra'), btn = $('#btn-cambiar-maestra'), nuevaPw = $('#m-nueva').value;
  error.textContent = '';
  if (nuevaPw.length < 12) { error.textContent = 'La nueva debe tener al menos 12 caracteres.'; return; }
  if (nuevaPw !== $('#m-confirmar').value) { error.textContent = 'Las contraseñas nuevas no coinciden.'; return; }
  btn.disabled = true;
  try {
    try { await abrir(archivo, $('#m-actual').value); } catch { error.textContent = 'La contraseña actual no es correcta.'; return; }
    sesion = await nueva(nuevaPw);
    await guardar();
    await guardar(); // segunda vez: así boveda.json.bak tampoco queda cifrado con la contraseña anterior
    formMaestra.reset(); $('#dlg-maestra').close();
    // la llave de Windows Hello era de la contraseña anterior
    const conHello = await helloActivo();
    if (conHello) await invoke('hello_borrar');
    avisar(conHello ? 'Contraseña maestra cambiada. Vuelve a activar Windows Hello en Ajustes.' : 'Contraseña maestra cambiada.');
  } finally { btn.disabled = false; }
};

aplicarAjustes();
pantallaBloqueo();
