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
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '1mb' }));

const SECRETO = process.env.SECRETO || '';
const RUTA_CHROMIUM = process.env.CHROMIUM_PATH || '';

/** Anade <base> (para que las rutas relativas de imagenes/fuentes sigan apuntando a la pagina real) y
 * oculta banners de cookies habituales (heuristica generica por id/clase: cookie, consent, gdpr, cmp,
 * onetrust) con CSS, en vez de intentar recortarlos del HTML: un banner real (p. ej. OneTrust) son varios
 * <div> anidados unos dentro de otros, y una regex sin parser de verdad no sabe dónde acaba el de fuera, así
 * que lo dejaba a medias y tapando el formulario real. Ocultarlo con display:none es fiable pase lo que pase
 * con el anidamiento, y el formulario sigue intacto en el HTML por si el refuerzo necesita leerlo. */
function limpiarHtml(html, urlOrigen) {
  var limpio = html;
  if (!/<base\s/i.test(limpio)) {
    limpio = limpio.replace(/<head[^>]*>/i, function (etiqueta) { return etiqueta + '<base href="' + urlOrigen + '">'; });
  }
  var PATRONES_BANNER = ['cookie', 'consent', 'gdpr', 'cmp', 'onetrust'];
  var selector = PATRONES_BANNER.map(function (p) { return '[id*="' + p + '" i],[class*="' + p + '" i]'; }).join(',');
  var estiloOculto = '<style>' + selector + '{display:none !important}</style>';
  limpio = /<\/head>/i.test(limpio) ? limpio.replace(/<\/head>/i, estiloOculto + '</head>') : estiloOculto + limpio;
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
      headless: true,
      executablePath: RUTA_CHROMIUM || undefined
    });
    var pagina = await navegador.newPage();
    // networkidle2 (y no 'load'): algunos logins reales encadenan varias navegaciones del lado del cliente
    // antes de llegar al formulario final (p. ej. el SSO/OIDC de DHL, con varios saltos entre dominios); con
    // 'load' nos quedábamos en la primera parada del camino. El timeout se sube bastante (antes 20s) porque
    // además suele haber trackers/consentimiento de cookies con tráfico de fondo continuo, que retrasan que
    // la red se considere "idle" aunque la página ya esté pintada del todo.
    await pagina.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
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
