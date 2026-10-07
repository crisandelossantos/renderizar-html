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

/**
 * Calcula el color principal real a partir de la página ya pintada: una regex sobre el HTML (lo que hacía
 * detectarColorProbable_ en el núcleo) solo ve estilos en línea o un <meta name="theme-color">, y la mayoría
 * de marcas lo definen en una hoja de estilos externa o con variables CSS (--algo), que una regex no resuelve
 * nunca. Aquí sí: el navegador ya ha aplicado todo el CSS, así que getComputedStyle da el color de verdad.
 *
 * Prioridad (misma filosofía que detectarColorProbable_, no el botón primero): 1) <meta name="theme-color">,
 * ya calculado por si viene en un formato raro; 2) el fondo de la cabecera de la página (header/nav/[role
 * banner]/body) -- este color es el que se usa luego como franja detrás del logo en el correo, así que tiene
 * que ser el fondo "de verdad" de la página, no el de un botón suelto; 3) solo si no hay nada de lo anterior,
 * el botón principal como último recurso. Se probó con un botón primero y falló en páginas con fondo oscuro
 * y botón claro (p. ej. claude.ai): el logo (pensado para ese fondo oscuro) quedaba invisible sobre un fondo
 * claro sacado del botón.
 */
function colorComputadoEnNavegador_() {
  function aHex(rgb) {
    var m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/.exec(rgb || '');
    if (!m) return '';
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return ''; // transparente: no cuenta como "el color"
    var h = function (n) { return ('0' + parseInt(n, 10).toString(16)).slice(-2); };
    return '#' + h(m[1]) + h(m[2]) + h(m[3]);
  }
  function colorVisibleDe(el) {
    if (!el) return '';
    return aHex(getComputedStyle(el).backgroundColor);
  }
  function colorDeValorCss(valor) {
    if (!valor) return '';
    var tmp = document.createElement('div');
    tmp.style.backgroundColor = valor;
    document.body.appendChild(tmp);
    var hex = aHex(getComputedStyle(tmp).backgroundColor);
    document.body.removeChild(tmp);
    return hex;
  }

  var meta = document.querySelector('meta[name="theme-color"]');
  var c1 = meta && colorDeValorCss(meta.getAttribute('content'));
  if (c1) return c1;

  var c2 = colorVisibleDe(document.querySelector('header'))
    || colorVisibleDe(document.querySelector('nav'))
    || colorVisibleDe(document.querySelector('[role="banner"]'))
    || colorVisibleDe(document.body);
  if (c2) return c2;

  var candidatos = document.querySelectorAll('button[type="submit"], input[type="submit"], button, [class*="primary" i][class*="btn" i], [class*="btn" i][class*="primary" i]');
  for (var i = 0; i < candidatos.length; i++) {
    var c3 = colorVisibleDe(candidatos[i]);
    if (c3) return c3;
  }
  return '';
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
    var colorHex = await pagina.evaluate(colorComputadoEnNavegador_);
    res.json({ ok: true, html: limpiarHtml(html, url), colorHex: colorHex || '' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    if (navegador) await navegador.close();
  }
});

app.get('/', function (req, res) { res.send('OK'); });

var PUERTO = process.env.PORT || 3000;
app.listen(PUERTO, function () { console.log('Escuchando en el puerto ' + PUERTO); });
