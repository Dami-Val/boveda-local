// Ejecuta: node test.mjs
import assert from 'node:assert/strict';
import { nueva, abrir, cifrar, parseCSV, importarCSV, generar, purgarPapelera, llaveDe, abrirConLlave, exportarCSV } from './public/vault.js';

// papelera: se queda 29 días, se purga a los 30
const DIA = 864e5, hoy = Date.now();
const purgadas = purgarPapelera([{ n: 'viva' }, { n: 'reciente', borrada: hoy - 29 * DIA }, { n: 'vieja', borrada: hoy - 30 * DIA }], hoy);
assert.deepEqual(purgadas.map((e) => e.n), ['viva', 'reciente']);

// cifrado: ida y vuelta, y contraseña incorrecta rechazada
const s = await nueva('maestra-de-prueba', 1000);
const archivo = await cifrar({ entradas: [{ nombre: 'Gmail', password: 'a"b,c\nd' }] }, s);
const r = await abrir(archivo, 'maestra-de-prueba');
assert.equal(r.datos.entradas[0].password, 'a"b,c\nd');
await assert.rejects(abrir(archivo, 'otra'));

// llave para Windows Hello: abre igual que la contraseña y no se entrega con contraseña incorrecta
const llave = await llaveDe(archivo, 'maestra-de-prueba');
assert.equal((await abrirConLlave(archivo, llave)).datos.entradas[0].nombre, 'Gmail');
await assert.rejects(llaveDe(archivo, 'otra'));
await assert.rejects(abrirConLlave(archivo, btoa('x'.repeat(32))));

// CSV: comillas, comas y saltos dentro de campos, BOM y CRLF
assert.deepEqual(parseCSV('﻿a,b\r\n"x,""y""","1\n2"\r\n'), [['a', 'b'], ['x,"y"', '1\n2']]);

// Bitwarden
const bw = importarCSV('folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n'
  + 'Bancos,,login,BBVA,"nota, con coma",,,https://bbva.mx,yo@x.com,P@ss"1,JBSWY3DP\n');
assert.equal(bw.length, 1);
assert.deepEqual({ ...bw[0], id: undefined }, { id: undefined, nombre: 'BBVA', usuario: 'yo@x.com', password: 'P@ss"1', url: 'https://bbva.mx', notas: 'nota, con coma', carpeta: 'Bancos', totp: 'JBSWY3DP' });

// Chrome/Edge
const ch = importarCSV('name,url,username,password,note\n,https://a.com,u,p,\n');
assert.equal(ch[0].nombre, 'https://a.com');
assert.equal(ch[0].password, 'p');
assert.throws(() => importarCSV('foo,bar\n1,2\n'));

// exportar: ida y vuelta exacta, con comillas, comas, saltos de línea y espacios en las contraseñas
const originales = [
  { nombre: 'BBVA México', usuario: 'yo@x.com', password: ' a"b,c\nd ', url: 'bbva.mx', notas: 'línea 1\r\nlínea 2', carpeta: 'Bancos', totp: 'JBSWY3DP' },
  { nombre: 'Sin carpeta', usuario: '', password: '=SUMA(1)', url: '', notas: '', carpeta: '', totp: '' },
];
const vuelta = importarCSV(exportarCSV(originales)).map(({ id, ...resto }) => resto);
assert.deepEqual(vuelta, originales);

// generador
const pw = generar(24, { mayus: true, minus: true, numeros: true, simbolos: false });
assert.equal(pw.length, 24);
assert.match(pw, /^[A-Za-z0-9]+$/);
assert.match(pw, /[A-Z]/); assert.match(pw, /[a-z]/); assert.match(pw, /[0-9]/);
assert.throws(() => generar(10, {}));

console.log('OK: todas las pruebas pasaron');
