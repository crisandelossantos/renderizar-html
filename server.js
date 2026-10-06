/**
 * Servicio minimo, de un solo uso: recibe una URL publica, la carga en un navegador real (Chromium
 * headless) y devuelve el HTML ya renderizado por JavaScript. Pensado para cuando el clonado simple de
 * GoPhish (una peticion HTTP normal, sin ejecutar JavaScript) sale vacio -- logins modernos hechos con
 * componentes web (React/Angular/Stencil...).
 *
 * No toca GoPhish ni datos de campanas en ningun momento: solo entra y sale una URL publica y su HTML.
 *
 * Seguridad: si SECRETO esta configurado (variable de entorno), exige la cabecera X-Secreto con ese
 * valor exacto -- para que no sea un proxy abierto que cualquiera pueda usar gratis.
 */
const express = require('express');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '1mb' }));

const SECRETO = process.env.SECRETO || '';

app.get('/diagnostico', function (req, res) {
  var ruta = '';
  var errorRuta = '';
  try { ruta = puppeteer.executablePath(); } catch (e) { errorRuta = e.message; }
  var existe = false, esArchivo = false, stat = null, errorStat = '';
  try { stat = fs.statSync(ruta); existe = true; esArchivo = stat.isFile(); } catch (e) { errorStat = e.message; }
  var permisos = stat ? (stat.mode & 0o777).toString(8) : null;
  res.json({
    PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR || '(no configurada)',
    rutaCalculada: ruta, errorRuta: errorRuta, existe: existe, esArchivo: esArchivo, permisos: permisos, errorStat: errorStat
  });
});

/** Anade <base> (para que las rutas relativas de imagenes/fuentes sigan apuntando a la pagina real) y
 * quita banners de cookies habituales (heuristica generica por id/clase: cookie, consent, gdpr, cmp). */
function limpiarHtml(html, urlOrigen) {
  var limpio = html;
  if (!/<base\s/i.test(limpio)) {
    limpio = limpio.replace(/<head[^>]*>/i, function (etiqueta) { return etiqueta + '<base href="' + urlOrigen + '">'; });
  }
  limpio = limpio.replace(/<([a-z0-9-]+)\b[^>]*(?:id|class)="[^"]*(?:cookie|consent|gdpr|cmp)[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, '');
  return limpio;
}

app.post('/renderizar', async function (req, res) {
  if (SECRETO && req.headers['x-secreto'] !== SECRETO) {
    return res.status(401).json({ ok: false, error: 'No autorizado.' });
  }
  var url = String((req.body || {}).url || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ ok: false, error: 'Indica una URL valida (http:// o https://).' });
  }

  var navegador;
  try {
    navegador = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: true
    });
    var pagina = await navegador.newPage();
    await pagina.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(function (r) { setTimeout(r, 1500); }); // margen extra para componentes lentos en pintarse
    var html = await pagina.evaluate(function () { return document.documentElement.outerHTML; });
    res.json({ ok: true, html: limpiarHtml(html, url) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    if (navegador) await navegador.close();
  }
});

app.get('/', function (req, res) { res.send('OK'); });

var PUERTO = process.env.PORT || 3000;
app.listen(PUERTO, function () { console.log('Escuchando en el puerto ' + PUERTO); });
