// Genera Boveda.exe (Node Single Executable Application). Ejecuta: node construir.cjs
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

process.chdir(__dirname);
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/sea-config.json', JSON.stringify({
  main: 'server.cjs',
  output: 'dist/sea-prep.blob',
  disableExperimentalSEAWarning: true,
  assets: Object.fromEntries(['index.html', 'app.js', 'vault.js', 'iconos.js', 'fuentes/plex-sans.woff2', 'fuentes/plex-mono-400.woff2',
    'fuentes/plex-mono-500.woff2', 'fuentes/newsreader.woff2'].map((a) => [a, 'public/' + a])),
}));
execFileSync(process.execPath, ['--experimental-sea-config', 'dist/sea-config.json'], { stdio: 'inherit' });

const exe = 'Boveda.exe';
fs.copyFileSync(process.execPath, exe);
execFileSync('npx', ['--yes', 'postject@1.0.0-alpha.6', exe, 'NODE_SEA_BLOB', 'dist/sea-prep.blob',
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit', shell: true });

// Subsistema GUI: así no aparece la ventana negra de consola.
const buf = fs.readFileSync(exe);
const pe = buf.readUInt32LE(0x3c);
if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Encabezado PE inesperado');
buf.writeUInt16LE(2, pe + 0x5c);
fs.writeFileSync(exe, buf);

fs.rmSync('dist', { recursive: true });
console.log('Listo:', path.resolve(exe));
