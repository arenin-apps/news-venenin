/**
 * Crea borradores en VENenIN a partir de la cola de notas que genera ARenIN.
 *
 * news-pipeline (ARenIN) deja la URL fuente de cada nota nueva en data/cola-venenin.json.
 * Este script lee esa cola, y para cada URL que todavia no se proceso corre
 * scripts/generar-post-manual.mjs (que escribe la version en castellano neutro
 * y la deja como BORRADOR en venenin.uk, nunca publicada).
 *
 * Uso: node scripts/generar-desde-cola.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOG = join(RAIZ, 'data', 'cola-procesada.json');
const SCRIPT = join(RAIZ, 'scripts', 'generar-post-manual.mjs');
const COLA_URL = 'https://raw.githubusercontent.com/arenin-apps/news-pipeline/main/data/cola-venenin.json';

const MAX_POR_CORRIDA = 6;
const MAX_INTENTOS = 3;
const NL = String.fromCharCode(10);

async function leerLog() {
  try {
    return JSON.parse(await readFile(LOG, 'utf8'));
  } catch {
    return {};
  }
}

async function guardarLog(log) {
  await writeFile(LOG, JSON.stringify(log, null, 2) + NL, 'utf8');
}

async function main() {
  const faltantes = ['GEMINI_API_KEY', 'PEXELS_API_KEY', 'WP_APP_USER', 'WP_APP_PASSWORD']
    .filter(v => !process.env[v]);
  if (faltantes.length) {
    console.error('Faltan variables de entorno: ' + faltantes.join(', ') + '. No se procesa nada.');
    process.exit(1);
  }

  const res = await fetch(COLA_URL + '?t=' + Date.now(), { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) {
    console.error('No se pudo leer la cola de ARenIN (HTTP ' + res.status + ').');
    process.exit(1);
  }
  const cola = await res.json();
  const log = await leerLog();

  // Se descartan del registro las URLs que ya salieron de la cola (ARenIN conserva las ultimas 60).
  const enCola = new Set(cola.map(e => e.url));
  for (const url of Object.keys(log)) {
    if (!enCola.has(url)) delete log[url];
  }

  const pendientes = cola.filter(e => {
    if (!e || !e.url) return false;
    const previo = log[e.url];
    return !(previo && (previo.estado === 'ok' || previo.intentos >= MAX_INTENTOS));
  });
  console.log('En cola: ' + cola.length + '. Pendientes: ' + pendientes.length + '.');

  let creados = 0;
  let fallosSeguidos = 0;
  for (const e of pendientes.slice(0, MAX_POR_CORRIDA)) {
    const tipo = e.tipo || 'noticia';
    console.log('Procesando ' + e.url + ' (' + tipo + ')');
    const r = spawnSync(process.execPath, [SCRIPT], {
      env: { ...process.env, POST_URL: e.url, POST_TIPO: tipo },
      stdio: 'inherit'
    });
    const intentos = ((log[e.url] && log[e.url].intentos) || 0) + 1;
    const ok = r.status === 0;
    log[e.url] = { estado: ok ? 'ok' : 'error', intentos, fecha: new Date().toISOString(), arenin: e.arenin };
    await guardarLog(log);
    if (ok) {
      creados++;
      fallosSeguidos = 0;
    } else {
      fallosSeguidos++;
      console.error('Fallo al procesar ' + e.url + ' (intento ' + intentos + ' de ' + MAX_INTENTOS + ').');
      if (fallosSeguidos >= 2) {
        console.error('Dos fallos seguidos: se corta la corrida (puede ser la cuota de Gemini). Se reintenta en la proxima.');
        break;
      }
    }
  }

  await guardarLog(log);
  console.log('Listo. ' + creados + ' borrador(es) creado(s) en VENenIN.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
