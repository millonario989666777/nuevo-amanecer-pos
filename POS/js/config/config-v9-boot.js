/* Configuración v9 · arranque liviano (siempre cargado).
   Aplica al iniciar el tema y el día/noche guardados (sin parpadeo) y carga la pantalla completa
   de Configuración (config-v9.js + config-v9-screen.css) solo al abrirla, o el selector de formato
   del ticket al abrir un ticket. Ambos archivos están en la caché del service worker: abren sin internet.
   Primero se revisa el rol: si este aparato no puede configurar, se muestra el mismo aviso de siempre
   y no se carga la pantalla. */
(function (root) {
  'use strict';
  var doc = root.document;
  if (!doc || root.NA_CONFIG_V9_BOOT) return;
  var MQ = root.matchMedia ? root.matchMedia('(min-width: 701px)') : { matches: true };
  var AP_KEY = 'na_v9_appearance', THEMES = ['verde', 'naranja', 'azul', 'celeste', 'simple'];
  var JS = 'js/config/config-v9.js', CSS = 'css/config-v9-screen.css';
  function wide() { return !!MQ.matches; }
  function ap() { var d = { theme: 'verde', mode: null }; try { var v = JSON.parse(root.localStorage.getItem(AP_KEY) || '{}'); if (THEMES.indexOf(v.theme) >= 0) d.theme = v.theme; if (/^(claro|noche|auto)$/.test(v.mode)) d.mode = v.mode; } catch (_) {} return d; }
  // Igual que config-v9.js antes de cargarse: en teléfono no se toca nada fuera de Configuración.
  function applyAppearance() {
    var d = ap(), dark = root.NA_THEME.apply();
    doc.documentElement.setAttribute('data-na-theme', d.theme);
    var box = doc.getElementById('naCfgV9');
    if (box) { box.setAttribute('data-na9-theme', d.theme); box.classList.toggle('na9-dk', dark); box.classList.toggle('na9-lt', !dark); }
  }
  function wrapDark() { /* toggleDark already persists through NA_THEME. */ }
  function canEdit() {
    try {
      var R = root.NA_ROLES; if (!R || !R.isOwner()) return false;
      // Aparato del dueño confirmado por el servidor: Configuración abre aunque se cambie el cajero de turno.
      if (R.confirmed) return true;
      if (typeof root._naF10HasPermission !== 'function') return false;
      return !!root._naF10HasPermission('configuration');
    } catch (_) { return false; }
  }
  var cssP = null, jsP = null;
  function loadCss() {
    if (cssP) return cssP;
    cssP = new Promise(function (ok, ko) { var l = doc.createElement('link'); l.rel = 'stylesheet'; l.href = CSS; l.onload = ok; l.onerror = function () { cssP = null; l.remove(); ko(new Error('CFG_CSS')); }; doc.head.appendChild(l); });
    return cssP;
  }
  function loadJs() {
    if (root.NA_CONFIG_V9) return Promise.resolve(true);
    if (jsP) return jsP;
    jsP = new Promise(function (ok, ko) { var s = doc.createElement('script'); s.src = JS; s.async = false; s.onload = function () { ok(true); }; s.onerror = function () { jsP = null; s.remove(); ko(new Error('CFG_JS')); }; doc.body.appendChild(s); });
    return jsP;
  }
  var LOCK = '<svg class="na9-i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
  // Mismo aviso que muestra config-v9.js cuando el aparato no puede configurar.
  function lockShell() {
    var page = doc.getElementById('pageConfig'); if (!page) return;
    var el = doc.getElementById('naCfgV9');
    if (!el) { el = doc.createElement('div'); el.id = 'naCfgV9'; el.className = 'na9'; el.innerHTML = '<nav class="na9-nav" id="na9Nav" aria-label="Configuración"></nav><main class="na9-main" id="na9Main"></main><div class="na9-saved" id="na9Saved" role="status" aria-live="polite"></div>'; page.appendChild(el); }
    var d = ap(), pd = root.NA_THEME.apply();
    el.setAttribute('data-na9-theme', d.theme); el.classList.toggle('na9-dk', pd); el.classList.toggle('na9-lt', !pd); el.classList.toggle('na9-mob', !wide()); el.classList.remove('na9-open');
    var nav = doc.getElementById('na9Nav'), main = doc.getElementById('na9Main');
    nav.innerHTML = ''; nav.hidden = true;
    main.innerHTML = '<div class="na9-card"><div class="na9-lock">' + LOCK + '<h3>Solo el admin puede entrar a Configuración</h3><p class="na9-muted">' + (root.navigator.onLine === false ? 'Sin conexión: Configuración necesita internet para confirmar que eres el admin.' : 'Pide al admin que ingrese en su aparato.') + '</p></div></div>';
  }
  function active() { var p = doc.getElementById('pageConfig'); return !!(p && p.classList.contains('active')); }
  function openConfig() {
    if (root.NA_CONFIG_V9 || !active()) return;
    var css = loadCss().catch(function () {});
    if (!canEdit()) { lockShell(); return; }
    // La pantalla aparece completa: primero estilos y código, después se pinta.
    css.then(loadJs).then(function () { if (root.NA_CONFIG_V9 && active()) root.NA_CONFIG_V9.render(); }).catch(function () {});
  }
  function watch() {
    var page = doc.getElementById('pageConfig');
    if (page && root.MutationObserver && !watch.done) { watch.done = true; new root.MutationObserver(openConfig).observe(page, { attributes: true, attributeFilter: ['class'] }); }
    var tk = doc.getElementById('mTicket');
    if (tk && root.MutationObserver && !watch.tk) { watch.tk = true; var mo = new root.MutationObserver(function () { if (tk.classList.contains('open') && wide()) { mo.disconnect(); loadJs().catch(function () { watch.tk = false; watch(); }); } }); mo.observe(tk, { attributes: true, attributeFilter: ['class'] }); }
    openConfig();
  }
  function boot() { applyAppearance(); wrapDark(); watch(); }
  if (MQ.addEventListener) MQ.addEventListener('change', applyAppearance);
  root.addEventListener('na:role', openConfig);
  root.addEventListener('online', openConfig); root.addEventListener('offline', openConfig);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot); else boot();
  root.addEventListener('load', boot);
  root.NA_CONFIG_V9_BOOT = { load: function () { return loadCss().then(loadJs); }, applyAppearance: applyAppearance, canEdit: canEdit };
})(window);
