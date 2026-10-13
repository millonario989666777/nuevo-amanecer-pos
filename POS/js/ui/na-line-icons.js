/* Íconos de línea (mismo estilo que Configuración v9): SVG dentro del código, sin peticiones,
   tamaño fijo por CSS (.na-li) y color = currentColor, así siguen el modo nocturno. */
(function (root) {
  'use strict';
  var P = {
    trend: '<path d="M22 7 13.5 15.5 8.5 10.5 2 17"/><path d="M16 7h6v6"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    alert: '<path d="m21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z"/><path d="M12 9v4M12 17h.01"/>',
    cart: '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2 2h3l2.7 12.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.7-9h1.8a4.5 4.5 0 1 1 0 9Z"/>',
    save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
    gear: '<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.5a2 2 0 0 1-1 1.8l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.5a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
    clip: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M8 12h8M8 16h5"/>',
    phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    dot: '<circle cx="12" cy="12" r="6" fill="currentColor" stroke="none"/>'
  };
  function icon(name, cls) {
    return '<svg class="na-li' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + (P[name] || '') + '</svg>';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  // Pone ícono + texto en un elemento (el texto se escapa).
  function iconText(el, name, text) { if (el) el.innerHTML = icon(name) + '<span class="na-li-text">' + esc(text) + '</span>'; }
  // Ícono por defecto de un producto sin foto: el 📦 genérico pasa a ícono de línea; un ícono elegido se respeta.
  function isDefaultProductIcon(v) { v = String(v == null ? '' : v).trim(); return !v || v === '📦' || v === 'box'; }
  root.NA_ICON = icon; root.NA_ICON_TEXT = iconText; root.NA_ICON_IS_DEFAULT_PRODUCT = isDefaultProductIcon;
})(window);

/* Emoji que quedaban en Inventario, Gastos, Ventas y Caja: se cambian por íconos de línea en cuanto
   aparecen (MutationObserver corre antes de pintar, así no hay salto). La marca (logo) no se toca. */
(function (root) {
  'use strict';
  var doc = root.document; if (!doc || !root.NA_ICON) return;
  var X = {
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-1"/>',
    bars: '<path d="M3 3v18h18"/><path d="M8 17v-5M13 17V7M18 17v-8"/>',
    down: '<path d="M22 17 13.5 8.5 8.5 13.5 2 7"/><path d="M16 17h6v-6"/>',
    folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    star: '<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1Z"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>',
    ban: '<circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/>',
    swap: '<path d="M16 3h5v5M21 3l-7 7M8 21H3v-5M3 21l7-7"/>',
    in: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
    out: '<path d="M12 15V3M7 8l5-5 5 5M5 21h14"/>',
    pen: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
    hand: '<path d="m11 17 2 2a1 1 0 1 0 3-3"/><path d="m14 14 2.5 2.5a1 1 0 1 0 3-3l-3.9-3.9a3 3 0 0 0-4.2 0l-.9.9a1 1 0 1 1-3-3l2.8-2.8a5.8 5.8 0 0 1 7.1-.9l.5.3a2 2 0 0 0 1.4.3L21 4"/><path d="m21 3 1 11h-2M3 3 2 14l6.5 6.5a1 1 0 1 0 3-3M3 4h8"/>',
    bank: '<path d="M3 21h18M5 21V10M19 21V10M9 21V10M15 21V10M2 10l10-6 10 6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    cashout: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M8 12h8"/>'
  };
  var base = root.NA_ICON;
  function ic(n) { return X[n] ? '<svg class="na-li" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' + X[n] + '</svg>' : base(n); }
  var MAP = {
    '📦': 'box', '⚠️': 'alert', '⚠': 'alert', '🛒': 'cart', '📅': 'cal', '🚫': 'ban', '💰': 'cash', '📊': 'bars',
    '📋': 'clip', '🔒': 'lock', '🔓': 'unlock', '📈': 'trend', '📉': 'down', '🗂️': 'folder', '🗂': 'folder', '🏆': 'star',
    '📑': 'file', '🧾': 'receipt', '🔍': 'search', '👥': 'users', '🤝': 'hand', '💵': 'cash', '💸': 'cashout',
    '📥': 'in', '📤': 'out', '✏️': 'pen', '✏': 'pen', '🟢': 'dot', '🔀': 'swap', '⚙️': 'gear', '📲': 'phone', '✅': 'check', '💚': 'cash', '⏳': 'clock', '⛔': 'ban', '🏦': 'bank'
  };
  var KEYS = Object.keys(MAP).sort(function (a, b) { return b.length - a.length; });
  var SEL = '.top-mod-title,.tab,.mov-ic,.mp,.mbtn,.abp-lbl,.cc-row>span,#difLbl,.na-cash-hist-row>span,.ei,.prod-icon-sm,.bn-title,.btn-abrir-cj,.btn-cerrar-cj,.cjsg-icon,.bci,.btn-act,.mhead-title';
  function lead(t) { t = t.replace(/^\s+/, ''); for (var i = 0; i < KEYS.length; i++) if (t.indexOf(KEYS[i]) === 0) return KEYS[i]; return null; }
  function fix(el) {
    if (!el || el.nodeType !== 1 || el.closest('.pos-module-mark,.g-logo,.brand')) return;
    var n = el.firstChild; while (n && n.nodeType === 3 && !n.nodeValue.trim()) n = n.nextSibling;
    if (!n || n.nodeType !== 3) return;
    var k = lead(n.nodeValue); if (!k) return;
    var rest = n.nodeValue.replace(/^\s+/, '').slice(k.length).replace(/^\uFE0F/, '');
    var tmp = doc.createElement('span'); tmp.innerHTML = '<i class="na-ic na-ic-' + MAP[k] + '" aria-hidden="true"></i>';
    el.insertBefore(tmp.firstChild, n);
    n.nodeValue = rest.trim() ? ' ' + rest.replace(/^\s+/, '') : '';
    el.classList.add('na-li-host');
  }
  function scan(r) { if (r.matches && r.matches(SEL)) fix(r); if (r.querySelectorAll) r.querySelectorAll(SEL).forEach(fix); }
  root.NA_ICON_SWAP = scan;
  // Sin observador: los emoji se quitaron del código fuente. NA_ICON_SWAP queda para uso puntual.
})(window);

/* Ventanas en el celular: altura real visible (visualViewport, no 100vh) en --na-vvh, y al abrir el
   teclado el campo enfocado se desplaza a la vista, así el botón de acción siempre se alcanza. */
(function (root) {
  'use strict';
  var doc = root.document, vv = root.visualViewport; if (!doc) return;
  var MODAL = '.modal-overlay .modal,.na-review-box,.na-pin-box';
  function setH(h) { doc.documentElement.style.setProperty('--na-vvh', h + 'px'); }
  function reveal() {
    var a = doc.activeElement; if (!a || !a.closest || !a.closest(MODAL) || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
    try { a.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (_) {}
  }
  // No se escribe al arrancar (el CSS usa 100dvh por defecto): solo al cambiar el área visible, en rAF y si cambió.
  var last = 0, raf = 0;
  function schedule() { if (raf) return; raf = root.requestAnimationFrame(function () { raf = 0; var h = Math.round(vv ? vv.height : root.innerHeight); if (h !== last) { last = h; setH(h); } }); }
  if (vv) vv.addEventListener('resize', function () { schedule(); setTimeout(reveal, 60); });
  else root.addEventListener('resize', schedule);
  doc.addEventListener('focusin', function () { setTimeout(reveal, 300); });
})(window);
