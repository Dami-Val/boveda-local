// Cifrado (PBKDF2-SHA256 + AES-256-GCM con WebCrypto), lectura de CSV y generador.
// Sin dependencias: lo usan el navegador y test.mjs.
export const ITER = 600000;
export const DIAS_PAPELERA = 30;

// Quita las entradas que llevan más de DIAS_PAPELERA en la papelera.
export const purgarPapelera = (entradas, ahora) => entradas.filter((e) => !e.borrada || ahora - e.borrada < DIAS_PAPELERA * 864e5);
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// Mismos 256 bits que deriveKey(AES-GCM 256): las bóvedas anteriores siguen abriendo.
async function derivarBits(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, 256));
}
const importar = (bits) => crypto.subtle.importKey('raw', bits, 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function nueva(password, iter = ITER) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { clave: await importar(await derivarBits(password, salt, iter)), salt, iter };
}

// Lanza error si la llave es incorrecta (GCM no autentica).
async function abrirConBits(archivo, bits) {
  const clave = await importar(bits);
  const plano = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(archivo.iv) }, clave, unb64(archivo.data));
  return { clave, salt: unb64(archivo.salt), iter: archivo.iter, datos: JSON.parse(dec.decode(plano)) };
}

export const abrir = async (archivo, password) => abrirConBits(archivo, await derivarBits(password, unb64(archivo.salt), archivo.iter));

// Para Windows Hello: la llave en base64, solo si la contraseña abre la bóveda.
export async function llaveDe(archivo, password) {
  const bits = await derivarBits(password, unb64(archivo.salt), archivo.iter);
  await abrirConBits(archivo, bits);
  return b64(bits);
}
export const abrirConLlave = (archivo, llave) => abrirConBits(archivo, unb64(llave));

export async function cifrar(datos, { clave, salt, iter }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, clave, enc.encode(JSON.stringify(datos))));
  return { v: 1, iter, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

// CSV según RFC 4180: comillas, comas y saltos de línea dentro de campos.
export function parseCSV(texto) {
  texto = texto.replace(/^﻿/, '');
  const filas = [];
  let fila = [], campo = '', comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') comillas = false;
      else campo += c;
    } else if (c === '"' && campo === '') comillas = true; // una comilla a media palabra es literal

    else if (c === ',') { fila.push(campo); campo = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo); filas.push(fila); fila = []; campo = '';
    } else campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter((f) => f.some((x) => x !== ''));
}

// Encabezados de Bitwarden, Chrome/Edge, Firefox y en español.
const ALIAS = {
  nombre: ['name', 'title', 'nombre'],
  usuario: ['login_username', 'username', 'user', 'usuario', 'email'],
  password: ['login_password', 'password', 'contraseña', 'contrasena', 'pass'],
  url: ['login_uri', 'url', 'uri', 'website', 'sitio'],
  notas: ['notes', 'note', 'notas'],
  carpeta: ['folder', 'grouping', 'carpeta'],
  totp: ['login_totp', 'totp', 'otpauth'],
};

export function importarCSV(texto) {
  const [cabecera, ...filas] = parseCSV(texto);
  if (!cabecera) return [];
  const h = cabecera.map((x) => x.trim().toLowerCase());
  const col = Object.fromEntries(Object.entries(ALIAS).map(([k, al]) => [k, h.findIndex((x) => al.includes(x))]));
  if (col.password < 0 && col.usuario < 0) throw new Error('El CSV no tiene columnas de usuario ni de contraseña.');
  return filas.map((f) => {
    const e = { id: crypto.randomUUID() };
    for (const k in col) e[k] = col[k] >= 0 ? (f[col[k]] ?? '') : '';
    if (!e.nombre) e.nombre = e.url || 'Sin nombre';
    return e;
  });
}

// Exporta en el formato CSV de Bitwarden (lo leen Bitwarden, 1Password, Proton Pass y esta misma app).
const CABECERA_BW = 'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp';
const celda = (v) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function exportarCSV(entradas) {
  const filas = entradas.map((e) => [e.carpeta, '', 'login', e.nombre, e.notas, '', '', e.url, e.usuario, e.password, e.totp]
    .map((v) => celda(String(v ?? ''))).join(','));
  return '﻿' + [CABECERA_BW, ...filas].join('\r\n') + '\r\n'; // BOM: Excel respeta los acentos
}

const CONJUNTOS = {
  mayus: 'ABCDEFGHJKLMNPQRSTUVWXYZ',
  minus: 'abcdefghijkmnopqrstuvwxyz',
  numeros: '23456789',
  simbolos: '!@#$%^&*-_=+?',
};

// Garantiza al menos un carácter de cada conjunto elegido.
export function generar(longitud, opciones) {
  const sets = Object.keys(CONJUNTOS).filter((k) => opciones[k]).map((k) => CONJUNTOS[k]);
  if (!sets.length) throw new Error('Elige al menos un tipo de carácter.');
  if (longitud < sets.length) throw new Error('La longitud es menor que los tipos elegidos.');
  const todos = sets.join('');
  for (;;) {
    // sesgo del módulo despreciable: 2^32 contra menos de 80 caracteres
    const r = crypto.getRandomValues(new Uint32Array(longitud));
    const pw = Array.from(r, (n) => todos[n % todos.length]).join('');
    if (sets.every((s) => [...pw].some((c) => s.includes(c)))) return pw;
  }
}
