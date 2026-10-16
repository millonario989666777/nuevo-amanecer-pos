/* Asistente (PROTOTIPO AISLADO): cargador apagado por defecto.
   Solo se activa con ?asistente=1 (queda guardado en este aparato) y se apaga con ?asistente=0.
   Antes de bajar NADA del asistente pregunta al servidor si este aparato lo tiene (POST /auth/assistant/chat {ping:true}, ~100 bytes,
   sin modelo ni cupo). Solo si la respuesta es «sí» (dueño o empleado con nivel encendido) o «aparato sin rol» (para mostrar
   «Registrar este teléfono como dueño») carga asistente.css, asistente-core.js y asistente-ui.js.
   Empleado en Apagado (por defecto): 0 archivos del asistente; su POS arranca igual que hoy.
   Sin internet: se usa lo último que dijo el servidor (solo para que el dueño vea «Asistente no disponible sin internet»).
   Todo pasa DESPUÉS de que el POS abrió y el navegador está libre. */
(function (root) {
  'use strict';
  var on = false;
  try {
    var q = new URLSearchParams(root.location.search).get('asistente');
    if (q === '1') root.localStorage.setItem('na_asistente_proto', '1');
    if (q === '0') { root.localStorage.removeItem('na_asistente_proto'); root.localStorage.removeItem('na_asistente_acc'); }
    on = root.localStorage.getItem('na_asistente_proto') === '1';
  } catch (_) {}
  if (!on) { try { root.document.documentElement.classList.remove('na-asst-owner', 'na-asst-pre'); } catch (_) {} return; }
  var loaded = false, asking = false, lastAsk = 0;
  function ls(k, v) { try { if (v === undefined) return root.localStorage.getItem(k); if (v === null) root.localStorage.removeItem(k); else root.localStorage.setItem(k, v); } catch (_) {} return null; }
  // Tarjeta de Inicio del dueño ARRIBA (debajo del saludo, antes de los totales) con alto FIJO: el hueco se reserva en cuanto corre
  // este archivo SOLO si el último ping dijo «dueño». Empleado o sin dato: no se reserva nada. Las alturas viven aquí y en el margen de
  // <head> (index.html): 321 (<380) / 272 (380-699, valor de Bot 4) / 364 (tableta) / 280 (PC) = alto REAL de la tarjeta (asistente.css fija las líneas por tramo).
  var SLOT_CSS = '#naAsstHero{box-sizing:border-box;flex:none;height:321px;margin:4px 0 16px;border-radius:22px;overflow:hidden;contain:strict}' +
    '#naAsstHero:empty{background:rgba(34,197,94,.07);border:1px solid rgba(21,128,61,.18)}' +
    '@media (min-width:380px) and (max-width:699px){#naAsstHero{height:272px}}@media (min-width:700px){#naAsstHero{height:364px;margin:4px 0 18px}}@media (min-width:1100px){#naAsstHero{height:280px}}' +
    // La tarjeta va en lugar de «Hola, ¿qué quieres hacer hoy?» del celular (como en las maquetas v2); el resto de Inicio no cambia.
    'html.na-asst-owner #naMobileWelcome{display:none!important}' +
    '#naAsstHero.na-asst-gone{display:flex;align-items:center;justify-content:center;padding:16px;background:#f1f5f9;border:1px solid #e2e8f0;color:#334155;font-size:15px;text-align:center}' +
    'body.dark #naAsstHero.na-asst-gone{background:#0f172a;border-color:#334155;color:#cbd5e1}';
  function slotCss() { var d = root.document; if (d.getElementById('naAsstSlotCss')) return; var st = d.createElement('style'); st.id = 'naAsstSlotCss'; st.textContent = SLOT_CSS; d.head.appendChild(st); }
  function reserve() {
    var d = root.document, m = d.getElementById('pageMenu'), host = m && m.querySelector('.main-scroll'); if (!host || d.getElementById('naAsstHero')) return;
    var at = host.querySelector(':scope > .quick-stats'), slot = d.createElement('section'); slot.id = 'naAsstHero'; slot.className = 'na-asst-hero'; slot.setAttribute('aria-label', 'Asistente');
    host.insertBefore(slot, at || host.firstChild); d.documentElement.classList.add('na-asst-owner'); d.documentElement.classList.remove('na-asst-pre'); // el hueco real reemplaza al margen reservado en <head>
    if (root.performance && root.performance.mark) root.performance.mark('na-asst-slot');
  }
  // Ya no es dueño: NADA de la tarjeta queda en el DOM (contenido, atajos, datos) en ese mismo instante. Para no mover la pantalla,
  // el hueco se queda con su alto y un aviso neutro, sin datos del dueño ni botones o enlaces. Se libera al salir de Inicio
  // (o en el próximo arranque, que ya no reserva nada porque el rol guardado se borró).
  var NOTICE = 'El asistente no está disponible en este aparato.';
  function release() { var e = root.document.getElementById('naAsstHero'); if (e) e.remove(); root.document.documentElement.classList.remove('na-asst-owner', 'na-asst-pre'); }
  function unreserve() {
    var d = root.document, e = d.getElementById('naAsstHero'), m = d.getElementById('pageMenu');
    var onInicio = !!(e && m && m.classList && m.classList.contains('active'));
    if (!e || !onInicio) { release(); return; }
    while (e.firstChild) e.removeChild(e.firstChild); // fuera todo: contenido, atajos y escuchas que colgaban de ellos
    var keep = { id: 1 }; Array.prototype.slice.call(e.attributes || []).forEach(function (a) { if (!keep[a.name]) e.removeAttribute(a.name); });
    e.className = 'na-asst-gone'; e.setAttribute('role', 'status');
    var p = d.createElement('p'); p.textContent = NOTICE; e.appendChild(p);
    d.documentElement.classList.remove('na-asst-pre');
    if (e._naGone) return; e._naGone = true;
    var mo = root.MutationObserver ? new root.MutationObserver(function () { if (!m.classList.contains('active')) { mo.disconnect(); release(); } }) : null;
    if (mo) mo.observe(m, { attributes: true, attributeFilter: ['class'] }); else release();
  }
  slotCss();
  if (ls('na_asistente_acc') === 'owner') reserve();
  root.NA_ASISTENTE_SLOT = { reserve: reserve, unreserve: unreserve, release: release, NOTICE: NOTICE };
  function load() {
    if (loaded) return; loaded = true;
    var d = root.document, l = d.createElement('link'); l.rel = 'stylesheet'; l.href = 'css/asistente.css'; d.head.appendChild(l);
    var a = d.createElement('script'); a.src = 'js/modules/asistente/asistente-core.js';
    a.onload = function () { var b = d.createElement('script'); b.src = 'js/modules/asistente/asistente-ui.js'; d.body.appendChild(b); };
    d.body.appendChild(a);
  }
  // Mismo pedido que usa la UI: endpoint y Bearer de la sesión del POS, sin cookies. En el prototipo local, rol simulado.
  function ask() {
    if (loaded || asking || Date.now() - lastAsk < 30000) return; asking = true; lastAsk = Date.now();
    if (root.navigator && root.navigator.onLine === false) { asking = false; if (ls('na_asistente_acc') === 'owner') load(); return; }
    var url = '/auth/assistant/chat', h = { 'content-type': 'application/json' }, init = { method: 'POST', cache: 'no-store', body: '{"ping":true}' };
    var c = null; try { c = JSON.parse(ls('na_cloud_sync_credentials') || 'null'); } catch (_) {}
    if (c && c.endpoint && c.token) { url = String(c.endpoint).replace(/\/+$/, '') + url; h.authorization = 'Bearer ' + c.token; init.credentials = 'omit'; init.redirect = 'error'; }
    else { var pr = ls('na_asistente_proto_role'), pl = ls('na_asistente_proto_level'); if (pr === 'empleado' || pr === 'sinrol') h['x-proto-role'] = pr; if (pl) h['x-proto-level'] = pl; }
    init.headers = h;
    var ctl = root.AbortController ? new root.AbortController() : null, t = ctl ? setTimeout(function () { ctl.abort(); }, 8000) : 0; if (ctl) init.signal = ctl.signal;
    root.fetch(url, init).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { st: r.status, d: d || {} }; }); }).then(function (x) {
      clearTimeout(t); asking = false;
      if (x.st === 200 && x.d.ok) { ls('na_asistente_acc', x.d.role === 'owner' ? 'owner' : 'on'); if (x.d.role !== 'owner') unreserve(); load(); return; }
      if (x.st === 403 && x.d.reason === 'sin_rol') { ls('na_asistente_acc', null); unreserve(); load(); return; }
      if (x.st === 401 || x.st === 403 || x.st === 404) { ls('na_asistente_acc', null); unreserve(); } // apagado: no se baja nada y el hueco (si lo había) se quita
    }, function () { clearTimeout(t); asking = false; if (ls('na_asistente_acc') === 'owner') load(); });
  }
  root.NA_ASISTENTE_LOADER = { ask: ask, loaded: function () { return loaded; } };
  function idle() { if (root.requestIdleCallback) root.requestIdleCallback(ask, { timeout: 2500 }); else setTimeout(ask, 800); }
  if (root.document.readyState === 'complete') idle(); else root.addEventListener('load', idle, { once: true });
  // Si el dueño lo enciende con la app abierta: se vuelve a preguntar al volver a la app (máx. una vez cada 30 s).
  root.document.addEventListener('visibilitychange', function () { if (!root.document.hidden) ask(); });
  root.addEventListener('online', ask);
})(window);
