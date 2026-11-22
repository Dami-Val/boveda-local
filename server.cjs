// Bóveda: servidor local + ventana de Edge en modo aplicación. Al cerrar la ventana, el proceso termina.
// Nunca ve contraseñas en claro: el cifrado ocurre en la página.
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');

let sea = null;
try { sea = require('node:sea'); if (!sea.isSea()) sea = null; } catch { sea = null; }

const DIR = sea ? path.dirname(process.execPath) : __dirname; // la bóveda vive junto al .exe
const BOVEDA = path.join(DIR, 'boveda.json');
const PUERTO = Number(process.env.BOVEDA_PUERTO) || 4777;
const URL_APP = `http://127.0.0.1:${PUERTO}`;
const HOSTS = [`127.0.0.1:${PUERTO}`, `localhost:${PUERTO}`];
const TOKEN = randomBytes(32).toString('hex'); // cambia en cada arranque; solo lo conoce la página servida
const ARCHIVOS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/vault.js': ['vault.js', 'text/javascript; charset=utf-8'],
  '/iconos.js': ['iconos.js', 'text/javascript; charset=utf-8'],
  '/fuentes/plex-sans.woff2': ['fuentes/plex-sans.woff2', 'font/woff2'],
  '/fuentes/plex-mono-400.woff2': ['fuentes/plex-mono-400.woff2', 'font/woff2'],
  '/fuentes/plex-mono-500.woff2': ['fuentes/plex-mono-500.woff2', 'font/woff2'],
  '/fuentes/newsreader.woff2': ['fuentes/newsreader.woff2', 'font/woff2'],
};
const CABECERAS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
};

// Windows Hello: pide PIN/huella/cara y, si se confirma, protege o recupera la llave con DPAPI (cuenta de Windows).
const LLAVE_HELLO = path.join(DIR, 'hello.dat');
const SCRIPT_HELLO = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
$datos = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('Bóveda: confirma que eres tú')
$tarea = $asTask.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult]).Invoke($null, @($op))
$null = $tarea.Wait(-1)
if ($tarea.Result -ne 'Verified') { [Console]::Out.Write('NO:' + $tarea.Result); exit 1 }
$alcance = [Security.Cryptography.DataProtectionScope]::CurrentUser
if ('__MODO__' -eq 'proteger') { $r = [Security.Cryptography.ProtectedData]::Protect($datos, $null, $alcance) }
else { $r = [Security.Cryptography.ProtectedData]::Unprotect($datos, $null, $alcance) }
[Console]::Out.Write('OK:' + [Convert]::ToBase64String($r))
`;
let helloOcupado = false;

function hello(modo, datosB64) {
  if (helloOcupado) return Promise.resolve({ ok: false, motivo: 'DeviceBusy' });
  helloOcupado = true;
  return new Promise((resolve) => {
    const script = Buffer.from(SCRIPT_HELLO.replace('__MODO__', modo), 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', script], { windowsHide: true });
    let salida = '';
    ps.stdout.on('data', (d) => { salida += d; });
    ps.on('error', () => resolve({ ok: false, motivo: 'SinPowerShell' }));
    ps.on('close', () => resolve(salida.startsWith('OK:') ? { ok: true, datos: salida.slice(3).trim() }
      : { ok: false, motivo: salida.startsWith('NO:') ? salida.slice(3).trim() : 'Error' }));
    ps.stdin.end(datosB64); // por stdin: nunca aparece en la lista de procesos
  }).finally(() => { helloOcupado = false; });
}

const json = (res, codigo, datos) => { res.writeHead(codigo, { ...CABECERAS, 'Content-Type': 'application/json' }); res.end(JSON.stringify(datos)); };

const leerPublico = (archivo) => (sea ? Buffer.from(sea.getAsset(archivo)) : fs.readFileSync(path.join(__dirname, 'public', archivo)));
const fin = (res, codigo) => { res.writeHead(codigo, CABECERAS); res.end(); };

async function leerCuerpo(req, max) {
  let cuerpo = '';
  for await (const trozo of req) {
    cuerpo += trozo;
    if (cuerpo.length > max) return null;
  }
  return cuerpo;
}

const servidor = http.createServer(async (req, res) => {
  try {
    if (!HOSTS.includes(req.headers.host)) return fin(res, 403); // bloquea DNS rebinding
    const ruta = req.url.split('?')[0];

    if (req.method === 'GET' && ARCHIVOS[ruta]) {
      const [archivo, tipo] = ARCHIVOS[ruta];
      let cuerpo = leerPublico(archivo);
      if (archivo === 'index.html') cuerpo = cuerpo.toString('utf8').replace('__TOKEN__', TOKEN);
      res.writeHead(200, { ...CABECERAS, 'Content-Type': tipo });
      return res.end(cuerpo);
    }

    if (!ruta.startsWith('/api/')) return fin(res, 404);
    // la cabecera propia obliga a preflight CORS, así que otra página web no puede llamar aquí
    if (req.headers['x-token'] !== TOKEN) return fin(res, 401);

    if (ruta === '/api/boveda' && req.method === 'GET') {
      if (!fs.existsSync(BOVEDA)) return fin(res, 404);
      res.writeHead(200, { ...CABECERAS, 'Content-Type': 'application/json' });
      return res.end(await fsp.readFile(BOVEDA));
    }

    if (ruta === '/api/boveda' && req.method === 'PUT') {
      const cuerpo = await leerCuerpo(req, 50e6);
      if (cuerpo === null) return fin(res, 413);
      try {
        const v = JSON.parse(cuerpo);
        if (!v.salt || !v.iv || !v.data || !v.iter) throw new Error();
      } catch { return fin(res, 400); }
      if (fs.existsSync(BOVEDA)) await fsp.copyFile(BOVEDA, BOVEDA + '.bak'); // versión anterior por si algo sale mal
      await fsp.writeFile(BOVEDA + '.tmp', cuerpo);
      await fsp.rename(BOVEDA + '.tmp', BOVEDA); // escritura atómica: nunca queda un archivo a medias
      return fin(res, 204);
    }

    // abre un sitio en el navegador normal del usuario (la ventana de la app usa un perfil aislado)
    if (ruta === '/api/abrir' && req.method === 'POST') {
      let url;
      try { url = new URL(JSON.parse(await leerCuerpo(req, 10000)).url); } catch { return fin(res, 400); }
      if (!['http:', 'https:'].includes(url.protocol)) return fin(res, 400);
      spawn('rundll32', ['url.dll,FileProtocolHandler', url.href], { detached: true, stdio: 'ignore' }).unref(); // sin shell: nada que inyectar
      return fin(res, 204);
    }

    if (ruta === '/api/hello' && req.method === 'GET') return json(res, 200, { activo: fs.existsSync(LLAVE_HELLO) });

    if (ruta === '/api/hello' && req.method === 'DELETE') {
      await fsp.rm(LLAVE_HELLO, { force: true });
      return fin(res, 204);
    }

    if (ruta === '/api/hello' && req.method === 'POST') {
      let llave;
      try { llave = JSON.parse(await leerCuerpo(req, 1000)).llave; } catch { return fin(res, 400); }
      if (typeof llave !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(llave)) return fin(res, 400); // 32 bytes en base64
      const r = await hello('proteger', llave);
      if (!r.ok) return json(res, 409, { motivo: r.motivo });
      await fsp.writeFile(LLAVE_HELLO, r.datos);
      return fin(res, 204);
    }

    if (ruta === '/api/hello/desbloquear' && req.method === 'POST') {
      if (!fs.existsSync(LLAVE_HELLO)) return fin(res, 404);
      const r = await hello('desproteger', (await fsp.readFile(LLAVE_HELLO, 'utf8')).trim());
      if (!r.ok) return json(res, 409, { motivo: r.motivo });
      return json(res, 200, { llave: r.datos });
    }

    fin(res, 404);
  } catch (e) {
    console.error(e);
    fin(res, 500);
  }
});

const EDGE = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
  .filter(Boolean)
  .map((d) => path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  .find((p) => fs.existsSync(p));

function abrirVentana(salirAlCerrar) {
  if (!EDGE) {
    // ponytail: sin Edge abre el navegador por defecto y el proceso queda vivo hasta apagar el equipo
    spawn('rundll32', ['url.dll,FileProtocolHandler', URL_APP], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const perfil = process.env.BOVEDA_PERFIL || path.join(process.env.LOCALAPPDATA || DIR, 'Boveda', 'perfil-edge'); // BOVEDA_PERFIL: solo pruebas
  const edge = spawn(EDGE, [`--app=${URL_APP}`, `--user-data-dir=${perfil}`, '--no-first-run', '--window-size=1120,780'], {
    stdio: 'ignore', detached: !salirAlCerrar,
  });
  if (salirAlCerrar) edge.on('exit', () => process.exit(0));
  else edge.unref();
}

servidor
  .on('error', (e) => {
    if (e.code !== 'EADDRINUSE') throw e;
    abrirVentana(false); // ya hay una Bóveda corriendo: solo trae su ventana
    setTimeout(() => process.exit(0), 500);
  })
  .listen(PUERTO, '127.0.0.1', () => abrirVentana(true));
