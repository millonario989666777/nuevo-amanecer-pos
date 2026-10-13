/* Etapa 2 · Configuración v9 (aprobada por el admin) — PC, tablet y teléfono.
   En teléfono (<= 700 px) solo cambia la pantalla de Configuración (lista de temas -> tema a pantalla
   completa con «‹ Configuración»). Tema y modo nocturno: en PC/tablet en toda la app; en teléfono
   solo dentro de Configuración. El resto del teléfono no cambia.
   Cada control usa un ajuste real de la app. Lo que se comparte entre aparatos se guarda en el
   servidor (/settings, solo el admin) con guardado automático; lo de "este aparato" en el aparato.
   Íconos de línea estilo Lucide (https://lucide.dev), licencia ISC. Copyright (c) Lucide Contributors. */
(function (root) {
  'use strict';
  var doc = root.document;
  var MQ = root.matchMedia ? root.matchMedia('(min-width: 701px)') : { matches: true, addEventListener: function () {} };
  function wide() { return !!MQ.matches; }
  var AP_KEY = 'na_v9_appearance';
  /* global appConfig, productos */
  function C() { try { return typeof appConfig !== 'undefined' ? appConfig : null; } catch (_) { return null; } }
  function R() { return root.NA_ROLES; }
  function cloud() { try { return !!(root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.enabled()); } catch (_) { return false; } }
  // Falla cerrada: solo el aparato del admin confirmado por el servidor y con el permiso cargado.
  function canEdit() {
    try {
      if (!R() || !R().isOwner()) return false;
      // Aparato del dueño confirmado por el servidor: Configuración abre aunque se cambie el cajero de turno.
      if (R().confirmed) return true;
      if (typeof root._naF10HasPermission !== 'function') return false;
      return !!root._naF10HasPermission('configuration');
    } catch (_) { return false; }
  }
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function call(name) { var f = root[name]; if (typeof f !== 'function') return undefined; return f.apply(root, [].slice.call(arguments, 1)); }
  function toast(m, k) { try { root.toast(m, k || 'success'); } catch (_) {} }
  async function confirmAction(msg, title, okText) {
    try { if (typeof root._naConfirmAction === 'function') return !!(await root._naConfirmAction(msg, { title: title, danger: true, okText: okText })); } catch (_) {}
    return root.confirm(msg);
  }

  var P = {
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M8 13h8M8 17h5"/>',
    receipt: '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
    store: '<path d="m2 7 4.4-4.4A2 2 0 0 1 7.8 2h8.4a2 2 0 0 1 1.4.6L22 7"/><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M2 7h20v3a2 2 0 0 1-4 0 2 2 0 0 1-4 0 2 2 0 0 1-4 0 2 2 0 0 1-4 0 2 2 0 0 1-2-2Z"/>',
    clip: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M8 12h8M8 16h5"/>',
    box: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.7 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z"/>',
    palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2a10 10 0 0 0 0 20 1.7 1.7 0 0 0 1.7-1.7c0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1a1.7 1.7 0 0 1 1.7-1.7h2A5.6 5.6 0 0 0 22 10.8C22 6 17.5 2 12 2Z"/>',
    db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/>',
    act: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    reset: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    plus: '<path d="M5 12h14M12 5v14"/>', bank: '<path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l8 5H4Z"/>',
    tag: '<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4Z"/><circle cx="7.5" cy="7.5" r=".5"/>',
    save: '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7"/>',
    cash: '<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>', dl: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'
  };
  function I(n) { return '<svg class="na9-i" viewBox="0 0 24 24" aria-hidden="true">' + (P[n] || '') + '</svg>'; }

  var TOP = [
    ['prod', 'Productos e inventario', 'box', 'Stock mínimo, avisos e IGV', [['stock', 'Productos y stock', 'box', 'Valores por defecto de inventario'], ['igv', 'Impuestos (IGV)', 'percent', 'El impuesto en la venta y el ticket']]],
    ['ventas', 'Ventas y cobros', 'store', 'Venta, crédito y días para pagar', [['pv', 'Punto de venta', 'store', 'Comportamiento de la pantalla de venta'], ['cred', 'Crédito y cobranzas', 'clip', 'Reglas de crédito para todos los aparatos']]],
    ['neg', 'Negocio', 'file', 'Datos del negocio y ticket', [['datos', 'Datos del negocio', 'file', 'Aparecen en el ticket y los reportes'], ['ticket', 'Ticket y comprobantes', 'receipt', 'Cómo se imprime el comprobante']]],
    ['pers', 'Personal y seguridad', 'shield', 'PIN, aparatos y permisos', [['pin', 'Usuarios y PIN', 'user', 'PIN del admin y cajeros'], ['devs', 'Aparatos conectados', 'phone', 'Aparatos que usan esta tienda'], ['perm', 'Bloqueos y permisos', 'shield', 'Qué se puede usar y cuándo se pide PIN']]],
    ['sis', 'Sistema', 'palette', 'Apariencia, copia y estado', [['apar', 'Apariencia', 'palette', 'Color, modo y tamaño en este aparato'], ['backup', 'Copia de seguridad', 'db', 'Guarda una copia de tus datos'], ['estado', 'Estado del sistema', 'act', 'Conexión y operaciones pendientes']]]
  ];
  var st = { top: 'prod', tab: {}, tkType: 'ticket', tkSub: 'enc', open: false };
  try { var saved = JSON.parse(root.sessionStorage.getItem('na_v9_nav') || '{}'); if (saved.top) st.top = saved.top; if (saved.tab) st.tab = saved.tab; } catch (_) {}
  function remember() { try { root.sessionStorage.setItem('na_v9_nav', JSON.stringify({ top: st.top, tab: st.tab })); } catch (_) {} }

  // ---------- guardado automático ----------
  var saveTimer = null, hideTimer = null;
  function badge(text, cls) { var el = doc.getElementById('na9Saved'); if (!el) return; el.textContent = text; el.className = 'na9-saved show ' + (cls || ''); clearTimeout(hideTimer); if (cls !== 'wait') hideTimer = setTimeout(function () { el.className = 'na9-saved'; }, 2200); }
  // shared=true: ajuste del negocio (servidor). shared=false: solo este aparato.
  function autosave(shared) {
    badge('Guardando…', 'wait'); clearTimeout(saveTimer);
    saveTimer = setTimeout(async function () {
      try {
        var g = root.NA_CONFIG_G;
        if (shared && g && typeof g.flush === 'function') { var r = await g.flush(); if (r && r.ok === false) { badge('No se guardó en el servidor: revisa internet', 'err'); return; } }
        else if (typeof root.saveAppState === 'function') await root.saveAppState();
        badge(shared ? 'Guardado ✓' : 'Guardado ✓ (este aparato)');
      } catch (_) { badge('No se pudo guardar', 'err'); }
    }, 500);
  }

  // ---------- controles ----------
  function sw(id, on, opts) { return '<label class="na9-sw"><input type="checkbox" data-na9="' + id + '"' + (on ? ' checked' : '') + (opts || '') + '><span></span></label>'; }
  function row(label, sub, ctl, tag) { return '<div class="na9-row' + (/class="na9-sw"/.test(ctl) ? ' na9-row-sw' : '') + '"><div class="na9-t">' + esc(label) + (tag ? ' <em class="na9-tag">' + esc(tag) + '</em>' : '') + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>' + ctl + '</div>'; }
  function num(id, val, min, max, step) { return '<input class="na9-num" type="number" data-na9="' + id + '" value="' + esc(val) + '" min="' + min + '" max="' + max + '" step="' + (step || 1) + '">'; }
  function txt(label, id, val, extra) { return '<label class="na9-f">' + esc(label) + '<input type="text" data-na9="' + id + '" value="' + esc(val) + '"' + (extra || '') + '></label>'; }
  function sel(label, id, val, opts) { return '<label class="na9-f">' + esc(label) + '<select data-na9="' + id + '">' + opts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (String(val) === String(o[0]) ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>'; }
  function note(html, cls) { return '<div class="na9-note ' + (cls || '') + '">' + html + '</div>'; }

  function fs() { try { return call('_naFreeSaleCfg') || {}; } catch (_) { return {}; } }
  function sc() { try { return call('_naScannerCfg') || {}; } catch (_) { return {}; } }
  function cp() { try { return call('_naCreditPolicy') || {}; } catch (_) { return {}; } }
  function canonSale() { try { return !!call('_naCanonSaleMode'); } catch (_) { return false; } }
  function igvLine() { try { return root.localStorage.getItem('na_show_igv_line') !== '0'; } catch (_) { return true; } }
  function biz() { try { return call('_naGetBusiness') || (C() && C().business) || {}; } catch (_) { return {}; } }

  // ---------- Ticket / Boleta / Factura ----------
  var TN = { ticket: 'Ticket de venta', boleta: 'Boleta', factura: 'Factura' };
  var FMT_DEF = {
    boleta: { serie: 'B001', ancho: '80mm', showClient: true, showDoc: true, showIGV: true, showPayment: true, pie: '' },
    factura: { serie: 'F001', ancho: 'A4', showClient: true, showDoc: true, showIGV: true, showPayment: true, pie: '' }
  };
  function fmt(type) { var t = (C() && C().ticket) || {}; var f = (t.formats && t.formats[type]) || {}; var o = {}; Object.keys(FMT_DEF[type]).forEach(function (k) { o[k] = f[k] != null ? f[k] : FMT_DEF[type][k]; }); return o; }
  function setFmt(type, key, val) { var c = C(); c.ticket = c.ticket || {}; c.ticket.formats = c.ticket.formats || {}; c.ticket.formats[type] = Object.assign(fmt(type), c.ticket.formats[type] || {}); c.ticket.formats[type][key] = val; }
  function customerOf(sale) {
    try { var id = sale && (sale.clienteId != null ? sale.clienteId : sale.customer_id); if (id == null || id === '') return null; var list = root.clientes || (typeof clientes !== 'undefined' ? clientes : []); return (list || []).find(function (c) { return String(c.id) === String(id); }) || null; } catch (_) { return null; } // eslint-disable-line no-undef
  }
  function docLabel(d) { d = String(d || '').replace(/\D/g, ''); return d.length === 11 ? 'RUC' : d.length === 8 ? 'DNI' : 'Doc.'; }
  function center(s, w) { s = String(s); if (s.length >= w) return s.slice(0, w); return ' '.repeat(Math.floor((w - s.length) / 2)) + s; }
  // Boleta y Factura usan el mismo constructor real del ticket con sus propias opciones.
  // Solo formato de impresión: no son comprobantes electrónicos SUNAT.
  function buildFormat(base, type, sale) {
    var c = C(), f = fmt(type), saved = c.ticket, out;
    var t = Object.assign({}, saved || {});
    t.ancho = f.ancho === 'A4' ? 'custom' : f.ancho; if (f.ancho === 'A4') t.customMm = 190;
    t.showIGV = !!f.showIGV; t.showPayment = !!f.showPayment; if (f.pie) t.pie = f.pie;
    c.ticket = t;
    try { out = base.call(root, sale, false); } finally { c.ticket = saved; }
    var w = out.width, lines = out.lines.slice(), cust = customerOf(sale), add = [];
    add.push(center((type === 'boleta' ? 'BOLETA DE VENTA' : 'FACTURA') + ' ' + f.serie + '-' + String((sale && sale.id) || '000000'), w));
    add.push(center('Formato de impresion. No es', w)); add.push(center('comprobante electronico SUNAT', w));
    if (f.showClient) add.push(('Cliente: ' + (cust ? (cust.nombre || cust.name || '') : 'Cliente general')).slice(0, w));
    if (f.showDoc) add.push((cust && cust.dni ? docLabel(cust.dni) + ': ' + cust.dni : (type === 'factura' ? 'RUC: ---' : 'DNI: ---')).slice(0, w));
    add.push('-'.repeat(w));
    var at = lines.indexOf(''); if (at < 0) at = 0;
    lines.splice(at + 1, 0, add.join('\n'));
    var text = lines.join('\n');
    return Object.assign({}, out, { lines: text.split('\n'), text: text, naFormat: type });
  }
  var printFormat = 'ticket';
  function installBuilder() {
    var base = root._naBuildThermalTicket;
    if (typeof base !== 'function' || base.__na9) return;
    var wrapped = function (sale, fromDom) {
      if (wide() && (printFormat === 'boleta' || printFormat === 'factura')) return buildFormat(base, printFormat, sale);
      return base.apply(this, arguments);
    };
    wrapped.__na9 = true; wrapped.__na9base = base;
    root._naBuildThermalTicket = wrapped;
  }
  function sampleSale() {
    return { id: 'V-000123', operation: '00000123', fecha: (call('obtenerHoy') || ''), hora: (call('nowT') || ''), cajero: biz().cajero || 'Caja principal', metodo: 'yape', paymentRef: '00451287', __na9sample: true, anulada: false, items: [{ name: 'Arroz 1kg', qty: 2, precio: 4.5 }, { name: 'Aceite 1L', qty: 1, precio: 8 }] };
  }
  function previewText(type) {
    try {
      var b = root._naBuildThermalTicket; var base = b && b.__na9base ? b.__na9base : b; if (typeof base !== 'function') return '';
      // Venta de ejemplo con N° de operación y detalle de crédito, para que esas opciones se vean en la vista previa.
      // NAReceiptShare está congelado: durante la vista previa se usa una copia con datos de crédito de ejemplo.
      var RS = root.NAReceiptShare, swapped = false;
      if (RS) { try { var orig = RS.ticketExtrasForSale; var tmp = Object.assign({}, RS); tmp.ticketExtrasForSale = function (v) { return v && v.__na9sample ? { amount: 17, initial: 5, balance: 12, due: (call('obtenerHoy') || '') } : (orig ? orig.apply(RS, arguments) : null); }; root.NAReceiptShare = tmp; swapped = root.NAReceiptShare === tmp; } catch (_) {} }
      try { return type === 'ticket' ? base.call(root, sampleSale(), false).text : buildFormat(base, type, sampleSale()).text; }
      finally { if (swapped) { try { root.NAReceiptShare = RS; } catch (_) {} } }
    } catch (e) { return 'No se pudo generar la vista previa.'; }
  }
  // Selector de formato en la ventana del ticket de una venta (solo PC y tablet; en teléfono no se ve).
  function installTicketPicker() {
    var head = doc.querySelector('#mTicket .mhead'); if (!head || doc.getElementById('na9TkFormat')) return;
    var s = doc.createElement('select'); s.id = 'na9TkFormat'; s.className = 'na9-tkformat'; s.setAttribute('aria-label', 'Formato de impresión');
    s.innerHTML = '<option value="ticket">Ticket</option><option value="boleta">Boleta (no SUNAT)</option><option value="factura">Factura (no SUNAT)</option>';
    s.addEventListener('change', function () { printFormat = s.value; try { root.renderTicketPreview(); } catch (_) {} });
    var tools = head.querySelector('div[style*="display:flex"]') || head; tools.insertBefore(s, tools.firstChild);
    var modal = doc.getElementById('mTicket');
    if (modal && root.MutationObserver) new root.MutationObserver(function () { if (!modal.classList.contains('open')) { printFormat = 'ticket'; s.value = 'ticket'; } }).observe(modal, { attributes: true, attributeFilter: ['class'] });
  }

  // ---------- legado incrustado (Cajeros, Bloqueos, Importar) ----------
  var legacy = { cat: null, home: null, next: null, obs: null };
  function legacyHome() { var cont = doc.getElementById('cfgContent'); if (cont && !legacy.home) { legacy.home = cont.parentNode; } return cont; }
  function relabel(node) {
    if (!node) return;
    var w = doc.createTreeWalker(node, 4, null), n;
    while ((n = w.nextNode())) { var v = n.nodeValue; if (/due[ñn]o/i.test(v)) n.nodeValue = v.replace(/Dueño/g, 'Admin').replace(/dueño/g, 'admin').replace(/DUEÑO/g, 'ADMIN'); }
    node.querySelectorAll('input[placeholder]').forEach(function (i) { if (/dueño/i.test(i.placeholder)) i.placeholder = i.placeholder.replace(/Dueño/g, 'Admin').replace(/dueño/g, 'admin'); });
  }
  // Paneles antiguos incrustados: los emojis se cambian por los íconos de línea del prototipo v9.
  var EMO = { '📦': 'box', '🔎': 'file', '🔍': 'file', '📄': 'file', '⬇': 'dl', '📥': 'dl', '🌅': 'store', '🏪': 'store', '🧭': 'store', '👤': 'user', '👥': 'user', '🧾': 'receipt', '➕': 'plus',
    '⚡': 'act', '⏱': 'act', '🔔': 'act', '📊': 'act', '📉': 'act', '📈': 'act', '🕘': 'act', '🔒': 'lock', '🔑': 'lock', '🔐': 'lock', '🔢': 'lock', '🧷': 'clip', '📋': 'clip',
    '⚙': 'shield', '👁': 'shield', '🧱': 'shield', '🚫': 'shield', '⚠': 'shield', '🛡': 'shield', '💰': 'cash', '💸': 'cash', '💳': 'card', '🏷': 'tag', '🗑': 'reset', '🔄': 'reset', '🏛': 'bank', '💾': 'save', '📱': 'phone', '🎨': 'palette' };
  var EMO_RE = /(\p{Extended_Pictographic})(\uFE0F|\u20E3)*/gu;
  function iconize(node) {
    if (!node || !doc.createTreeWalker) return;
    var w = doc.createTreeWalker(node, 4, null), list = [], n;
    while ((n = w.nextNode())) { EMO_RE.lastIndex = 0; if (EMO_RE.test(n.nodeValue) && !(n.parentNode && /^(SCRIPT|STYLE|TEXTAREA|OPTION)$/.test(n.parentNode.nodeName))) list.push(n); }
    list.forEach(function (t) {
      var frag = doc.createDocumentFragment(), txt = t.nodeValue, last = 0, m; EMO_RE.lastIndex = 0;
      while ((m = EMO_RE.exec(txt))) {
        if (m.index > last) frag.appendChild(doc.createTextNode(txt.slice(last, m.index)));
        var ic = EMO[m[1]]; if (ic) { var sp = doc.createElement('span'); sp.className = 'na9-li'; sp.innerHTML = I(ic); frag.appendChild(sp); }
        last = m.index + m[0].length;
      }
      var rest = txt.slice(last); if (!ic && /^\s/.test(rest) && last > 0 && frag.childNodes.length === 0) rest = rest.replace(/^\s+/, '');
      frag.appendChild(doc.createTextNode(rest));
      t.parentNode.replaceChild(frag, t);
    });
  }
  function title(p) { var t = p.querySelector('.cfg-panel-title, h3, h4, strong'); return t ? t.textContent : ''; }
  function filterLegacy(cont, only) {
    if (!only) return;
    cont.querySelectorAll(':scope > *').forEach(function (el) {
      // Solo por título del panel: el texto de otros paneles puede mencionar la palabra.
      var keep = false;
      if (el.matches('.cfg-grid-2')) { el.querySelectorAll(':scope > .cfg-panel').forEach(function (p) { var k = only.test(title(p)); p.hidden = !k; if (k) keep = true; }); }
      else if (el.matches('.cfg-panel')) keep = only.test(title(el));
      el.hidden = !keep;
    });
  }
  function mountLegacy(host, cat, only) {
    var cont = legacyHome(); if (!cont || !host) return;
    if (!legacy.next && cont.parentNode === legacy.home) legacy.next = cont.nextSibling;
    host.appendChild(cont); legacy.cat = cat; legacy.capt = cat === 'negocio' && !!only && /Cajeros/.test(only.source);
    try { root.currentCfgCategory = cat; } catch (_) {}
    try { currentCfgCategory = cat; } catch (_) {} // eslint-disable-line no-undef
    cont.classList.add('na9-legacy');
    var paint = function () { if (legacy.obs) legacy.obs.disconnect(); filterLegacy(cont, only); relabel(cont); iconize(cont); cont.querySelectorAll('.na-cfg-save').forEach(function (b) { b.hidden = true; }); if (legacy.obs) legacy.obs.observe(cont, { childList: true, subtree: true, characterData: true }); };
    if (legacy.obs) legacy.obs.disconnect();
    legacy.obs = root.MutationObserver ? new root.MutationObserver(function () { paint(); }) : null;
    try { root.renderCfgContent(cat); } catch (_) {}
    paint();
  }
  function unmountLegacy() {
    var cont = doc.getElementById('cfgContent'); if (!cont || !legacy.home) return;
    if (legacy.obs) { legacy.obs.disconnect(); legacy.obs = null; }
    if (cont.parentNode !== legacy.home) { legacy.home.insertBefore(cont, legacy.next && legacy.next.parentNode === legacy.home ? legacy.next : null); }
    cont.classList.remove('na9-legacy'); cont.innerHTML = ''; legacy.cat = null; legacy.capt = false;
  }

  // ---------- Apariencia (este aparato; solo PC y tablet) ----------
  var THEMES = [['verde', 'Verde esmeralda', 'Como siempre'], ['naranja', 'Naranja', 'Con adornos'], ['azul', 'Azul', 'Con adornos'], ['celeste', 'Celeste', 'Con adornos'], ['simple', 'Simple claro', 'Sin adornos']];
  var ZP = [['Chico', 90], ['Normal', 100], ['Grande', 115], ['Muy grande', 125]];
  function ap() { var d = { theme: 'verde', mode: null }; try { var v = JSON.parse(root.localStorage.getItem(AP_KEY) || '{}'); if (THEMES.some(function (t) { return t[0] === v.theme; })) d.theme = v.theme; if (/^(claro|noche|auto)$/.test(v.mode)) d.mode = v.mode; } catch (_) {} return d; }
  function setAp(k, v) { var d = ap(); d[k] = v; try { root.localStorage.setItem(AP_KEY, JSON.stringify(d)); } catch (_) {} applyAppearance(); }
  function zoom() { try { var e = root.NA_CONFIG_E2 && root.NA_CONFIG_E2.read(); return e ? e.text : 100; } catch (_) { return 100; } }
  function setZoom(v) {
    var e = root.NA_CONFIG_E2; if (!e) return; v = e.clamp(v);
    var all = { text: v, cards: v, cartTitle: v, buttons: v };
    try { root.localStorage.setItem('na_appearance_v1', JSON.stringify(all)); } catch (_) {}
    e.apply(all);
  }
  var darkMQ = root.matchMedia ? root.matchMedia('(prefers-color-scheme: dark)') : null;
  var appliedDark = null;
  function applyAppearance() {
    var html = doc.documentElement, d = ap();
    var box = doc.getElementById('naCfgV9');
    // Celular, tablet y PC: el tema y el día/noche se aplican a toda la app (solo colores).
    // PC/tablet: Configuración usa el mismo tema y el día/noche de la app (estilo del prototipo).
    if (box) { var wd = !!(doc.body && doc.body.classList.contains('dark')); var wdm = d.mode ? (d.mode === 'noche' || (d.mode === 'auto' && !!(darkMQ && darkMQ.matches))) : wd; box.setAttribute('data-na9-theme', d.theme); box.classList.toggle('na9-dk', wdm); box.classList.toggle('na9-lt', !wdm); }
    html.setAttribute('data-na-theme', d.theme);
    if (!d.mode) return; // sin elección guardada: se respeta el día/noche de siempre
    var dark = d.mode === 'noche' || (d.mode === 'auto' && !!(darkMQ && darkMQ.matches));
    if (doc.body && (appliedDark !== null || d.mode !== 'claro' || doc.body.classList.contains('dark') !== dark)) {
      doc.body.classList.toggle('dark', dark); appliedDark = dark;
      try { root.isDark = dark; } catch (_) {}
      try { isDark = dark; } catch (_) {} // eslint-disable-line no-undef
      var b = doc.getElementById('btnDarkMode'); if (b) { if (root.NA_ICON) b.innerHTML = root.NA_ICON(dark ? 'sun' : 'moon'); else b.textContent = dark ? '☀️' : '🌙'; }
    }
  }

  // ---------- pantallas ----------
  function body(id) {
    var c = C() || {}, t = c.ticket || {};
    switch (id) {
      case 'stock':
        return '<label class="na9-f">Stock mínimo por defecto<input class="na9-wide" type="number" data-na9="stockMin" value="' + esc(c.stockMin != null ? c.stockMin : 5) + '" min="0" max="100000" step="1"></label>'
          + row('Avisar cuando el stock esté bajo', 'Se marca en inventario y en el resumen', sw('stockAlertActive', !!c.stockAlertActive))
          + row('Aplicar el mínimo a todo el catálogo', 'Pone el stock mínimo actual en todos los productos', '<button type="button" class="na9-btn sec sm" data-act="stockAll">Aplicar ahora</button>')
          + row('Importar productos', 'Cargar el catálogo desde Excel o CSV', '<button type="button" class="na9-btn sec sm" data-act="imp">' + (st.imp ? 'Cerrar' : 'Abrir') + '</button>')
          + (st.imp ? '<div class="na9-sub"><div class="na9-legacy-host" data-legacy="importar"></div></div>' : '');
      case 'igv':
        return row('Aplicar IGV (18%)', 'Desglosa el impuesto en el punto de venta', sw('igvActive', !!c.igvActive))
          + row('Mostrar la línea "IGV (18%)"', 'En Nueva venta y en el ticket. No cambia el precio.', sw('igvLine', igvLine()));
      case 'pv':
        var f = fs(), s = sc();
        return '<div class="na9-cols2">'
          + row('Impedir ventas bajo costo', 'No deja vender por debajo del costo', sw('margenActive', !!c.margenActive))
          + row('Venta libre / VARIOS', 'Artículo ocasional sin crear producto', sw('freeGeneric', !!f.allowGenericSale), 'este aparato')
          + (canonSale() ? '' : row('Vender producto sin stock', 'Deja el stock en negativo', sw('freeNoStock', !!f.allowRegisteredNoStock), 'este aparato')
            + row('Venta mayorista', 'Modo caja y precios por volumen', sw('mayoristaActive', !!c.mayoristaActive)))
          + row('Acceso rápido a VARIOS', 'F1–F12 o 2 a 4 letras, por ejemplo VS', '<input class="na9-num" type="text" maxlength="4" data-na9="freeShortcut" value="' + esc(f.shortcut || 'F2') + '">', 'este aparato')
          + '</div><div class="na9-sub"><h4>Lector de código de barras <em class="na9-tag">este aparato</em></h4><div class="na9-cols2">'
          + row('Lectura automática', 'Lectores USB o Bluetooth que escriben como teclado', sw('scanEnabled', !!s.enabled))
          + row('Sonido al leer', 'Tono corto al leer un código', sw('scanSound', !!s.sound))
          + row('Tiempo máximo entre teclas (ms)', 'Recomendado: 65', num('scanInterval', s.maxIntervalMs != null ? s.maxIntervalMs : 65, 20, 150))
          + row('Largo mínimo del código', 'Caracteres para tomarlo como lectura', num('scanMin', s.minLength != null ? s.minLength : 6, 1, 32))
          + '</div></div>';
      case 'cred':
        var p = cp();
        return row('Ventas a crédito con reglas', p.enabled ? 'Activas: se revisa la línea de cada cliente' : 'Desactivadas', sw('credEnabled', !!p.enabled))
          + '<div class="na9-cols2">'
          + '<label class="na9-f">Línea de crédito inicial (S/)' + num('cred.initialLine', p.initialLine, 0, 100000, 0.5) + '</label>'
          + '<label class="na9-f">Días para pagar' + num('cred.dueDays', p.dueDays || 30, 1, 365) + '</label>'
          + '<label class="na9-f">Compras mínimas (S/)' + num('cred.minPurchases', p.minPurchases, 0, 100000, 50) + '</label>'
          + '<label class="na9-f">Ganancia real mínima (S/)' + num('cred.minProfit', p.minProfit, 0, 100000, 25) + '</label>'
          + '<label class="na9-f">% cliente puntual' + num('cred.punctualRate', p.punctualRate, 0, 100) + '</label>'
          + '<label class="na9-f">% cliente impuntual' + num('cred.lateRate', p.lateRate, 0, 100) + '</label>'
          + '</div>' + note('Se aplica en todos los aparatos. «Días para pagar» propone la fecha de vencimiento al vender a crédito.');
      case 'datos':
        var b = biz();
        return '<div class="na9-sub"><h4>' + I('file') + 'Datos principales</h4><div class="na9-cols2">' + txt('Nombre del negocio', 'biz.nombre', b.nombre) + txt('RUC', 'biz.ruc', b.ruc, ' inputmode="numeric" maxlength="11"')
          + txt('Dirección', 'biz.direccion', b.direccion) + txt('Teléfono', 'biz.telefono', b.telefono, ' inputmode="tel"') + '</div>'
          + note('La dirección sale en el ticket tal como la escribes (por ejemplo «Puerto Súngaro, Huánuco»).') + '</div>'
          + '<div class="na9-legacy-host" data-legacy="negocio" data-only="Identidad comercial"></div>';
      case 'ticket': return ticketBody();
      case 'pin':
        var r = R() || {}, set = !!r.pinSet;
        return row('Este aparato', '', '<b>' + (r.role === 'empleado' ? 'Empleado' : 'Admin') + '</b>')
          + row('PIN del admin', 'Autoriza anulaciones, ajustes de stock, cambios de precio y el reseteo', '<b>' + (set ? 'Configurado' : 'Todavía no configurado') + '</b>')
          + '<div class="na9-sub"><h4>' + (set ? 'Cambiar PIN del admin' : 'Crear PIN del admin') + '</h4><div class="na9-cols3">'
          + (set ? '<label class="na9-f">PIN actual<input id="naPinCurrent" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>' : '')
          + '<label class="na9-f">PIN nuevo<input id="naPinNew" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>'
          + '<label class="na9-f">Repite el PIN nuevo<input id="naPinNew2" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label></div>'
          + '<button type="button" class="na9-btn" data-act="pin">' + I('lock') + 'Guardar PIN</button>'
          + '<p class="na9-muted">De 4 a 8 dígitos. Se guarda cifrado en el servidor. No lo compartas por chat.</p></div>'
          + '<div class="na9-sub"><h4>Cajeros <em class="na9-tag">este aparato</em></h4><div class="na9-legacy-host" data-legacy="negocio" data-only="^\\W*Cajeros"></div></div>';
      case 'devs':
        return '<div class="na9-sub"><h4>Vincular un aparato de empleado</h4><p class="na9-muted">El código dura 15 minutos y sirve una sola vez. El empleado podrá vender, cobrar y registrar, pero no abrir Configuración ni anular o ajustar sin tu PIN.</p>'
          + '<div class="na9-cols2"><label class="na9-f">Nombre del aparato (opcional)<input id="naPairLabel" maxlength="60" placeholder="Ej. Caja 2, celular de Rosa"></label><div class="na9-end"><button type="button" class="na9-btn" id="naPairCreate">' + I('plus') + 'Crear código</button></div></div><div id="naPairOut"></div></div>'
          + '<div class="na9-sub"><h4>Aparatos</h4><div id="naDevList" class="na-g-devs">Cargando…</div></div>';
      case 'perm':
        return note('Empleado: puede vender, cobrar y registrar. Para anular, ajustar stock o cambiar precios necesita el PIN del admin (lo valida el servidor). Configuración es solo para el admin.')
          + '<div class="na9-legacy-host" data-legacy="control"></div>';
      case 'apar': return aparBody();
      case 'backup':
        return '<p class="na9-muted">' + (cloud() ? 'Tus ventas, abonos y cajas ya se guardan en la nube con respaldo automático. Aquí puedes descargar una copia para guardarla.' : 'Descarga una copia de los datos de este aparato.') + '</p>'
          + '<button type="button" class="na9-btn" data-act="backup">' + I('dl') + 'Descargar copia de seguridad</button>';
      case 'estado': return estadoBody();
    }
    return '';
  }
  function ticketBody() {
    var c = C() || {}, t = c.ticket || {}, ty = st.tkType, sb = st.tkSub, L = '';
    var zs = null; try { zs = root._naF11State ? root._naF11State() : null; } catch (_) {}
    var zone = function (code) { return !zs || !zs.settings[code] || zs.settings[code].enabled !== false; };
    if (ty === 'ticket') {
      if (sb === 'enc') L = row('Mostrar encabezado', 'Líneas arriba y abajo del nombre', sw('tk.showLogo', t.showLogo !== false))
        + '<label class="na9-f">Texto de abajo<input type="text" data-na9="tk.pie" value="' + esc(t.pie || '') + '"><small>Separa líneas con |</small></label>'
        + note('Nombre, RUC, dirección y teléfono se cambian en <b>Datos del negocio</b>.');
      else if (sb === 'campos') L = '<div class="na9-cols2">'
        + [['showNum', 'Número de venta'], ['showOperation', 'N° de operación'], ['showUnitPrice', 'Precio unitario'], ['showCurrency', 'Símbolo S/'], ['showIGV', 'IGV desglosado'], ['showPayment', 'Método de pago'], ['showReceived', 'Recibido y vuelto'], ['showSep', 'Líneas separadoras']]
          .map(function (x) { return row(x[1], '', sw('tk.' + x[0], x[0] === 'showIGV' ? !!t.showIGV : t[x[0]] !== false)); }).join('')
        + row('Detalle del crédito', '', sw('zone.c', zone('c'))) + row('Estado de cuenta (deuda)', '', sw('zone.a', zone('a'))) + '</div>';
      else L = '<div class="na9-cols2">' + sel('Ancho del papel', 'tk.ancho', t.ancho || '80mm', [['58mm', '58 mm'], ['80mm', '80 mm']].concat(/^(58mm|80mm)$/.test(t.ancho || '80mm') ? [] : [[t.ancho, t.ancho === 'custom' ? 'Personalizado' : String(t.ancho).replace('mm', ' mm')]])) + '</div>'
        + row('Imprimir al cobrar', 'Abre el ticket al confirmar una venta', sw('printAuto', !!c.printAuto))
        + '<button type="button" class="na9-btn sec sm" data-act="designer">Abrir diseñador avanzado</button>';
    } else {
      var f = fmt(ty);
      if (sb === 'enc') L = '<div class="na9-cols2">' + txt('Serie', 'fmt.serie', f.serie, ' maxlength="4"') + '<label class="na9-f">Texto de abajo<input type="text" data-na9="fmt.pie" value="' + esc(f.pie) + '" placeholder="Igual que el ticket"></label></div>'
        + note('El número es la serie y el código de la venta (por ejemplo ' + esc(f.serie) + '-V-000123).');
      else if (sb === 'campos') L = '<div class="na9-cols2">' + row('Cliente', '', sw('fmt.showClient', !!f.showClient)) + row('DNI/RUC del cliente', '', sw('fmt.showDoc', !!f.showDoc)) + row('IGV desglosado', '', sw('fmt.showIGV', !!f.showIGV)) + row('Método de pago', '', sw('fmt.showPayment', !!f.showPayment)) + '</div>';
      else L = '<div class="na9-cols2">' + sel('Ancho del papel', 'fmt.ancho', f.ancho, [['58mm', '58 mm'], ['80mm', '80 mm'], ['A4', 'Hoja A4']]) + '</div>'
        + note(wide() ? 'Para imprimir: abre la venta, toca el ticket y elige «' + TN[ty] + '» en la parte de arriba.' : 'Para imprimir ' + TN[ty] + ' usa la PC o la tablet: abre la venta, toca el ticket y elige «' + TN[ty] + '» arriba.');
    }
    return note('<b>Solo formatos de impresión.</b> Boleta y Factura no son comprobantes electrónicos SUNAT; la app no emite comprobantes fiscales.', 'warn')
      + '<div class="na9-tkbar"><div class="na9-seg">' + ['ticket', 'boleta', 'factura'].map(function (x) { return '<button type="button" class="' + (x === ty ? 'on' : '') + '" data-act="tkty" data-t="' + x + '">' + TN[x] + '</button>'; }).join('') + '</div>'
      + '<div class="na9-stabs">' + [['enc', 'Datos y textos'], ['campos', 'Qué se muestra'], ['papel', 'Papel e impresión']].map(function (x) { return '<button type="button" class="' + (x[0] === sb ? 'on' : '') + '" data-act="tksub" data-t="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div></div>'
      + '<div class="na9-split"><div>' + L + '</div><div><div class="na9-pvh">Vista previa: ' + TN[ty] + '</div><div class="na9-pvbox"><pre class="na9-ticket" id="na9Tk">' + esc(previewText(ty)) + '</pre></div></div></div>';
  }
  function aparBody() {
    var d = ap(), z = zoom(), zn = 'Personalizado';
    ZP.forEach(function (x) { if (x[1] === z) zn = x[0]; });
    return '<div class="na9-lbl">Modo de la pantalla</div><div class="na9-seg">' + [['claro', 'Claro'], ['noche', 'Nocturno'], ['auto', 'Automático']].map(function (x) { return '<button type="button" class="' + ((d.mode || (doc.body && doc.body.classList.contains('dark') ? 'noche' : 'claro')) === x[0] ? 'on' : '') + '" data-act="mode" data-t="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>'
      + '<div class="na9-lbl">Color y estilo</div><div class="na9-themes">' + THEMES.map(function (t) { return '<button type="button" class="na9-th na9-th-' + t[0] + (d.theme === t[0] ? ' on' : '') + '" data-act="theme" data-t="' + t[0] + '"><i></i>' + esc(t[1]) + '<small>' + esc(t[2]) + '</small></button>'; }).join('') + '</div>'
      + '<div class="na9-lbl">Tamaño de letra y botones: <b id="na9Zv">' + zn + ' (' + z + '%)</b></div>'
      + '<div class="na9-zbtns"><button type="button" class="na9-btn sec na9-zb" data-act="zdn" aria-label="Más chico">A−</button>' + ZP.map(function (x) { return '<button type="button" class="na9-btn sec na9-zp' + (z === x[1] ? ' on' : '') + '" data-act="zset" data-z="' + x[1] + '">' + x[0] + '</button>'; }).join('') + '<button type="button" class="na9-btn sec na9-zb" data-act="zup" aria-label="Más grande">A+</button></div>'
      + '<label class="na9-zslider"><input type="range" min="85" max="125" step="5" data-na9="zoom" value="' + z + '" aria-label="Tamaño de letra y botones"></label>'
      + samplePreview()
      + '<p class="na9-muted">' + 'Se guarda solo en este aparato. El color, el modo nocturno y el tamaño cambian en toda la app.' + '</p>';
  }
  // Muestra de cómo se ve un producto real con el tamaño elegido (solo lectura).
  function samplePreview() {
    var p = null; try { p = (typeof productos !== 'undefined' && productos && productos[0]) || null; } catch (_) {}
    if (!p) return '';
    var price = Number(p.precio != null ? p.precio : p.price); var st = p.stock != null ? p.stock : '';
    return '<div class="na9-pv"><b>' + esc(p.nombre || p.name || '') + '</b><small>' + (st !== '' ? 'Stock: ' + esc(st) : '') + (p.categoria ? ' · ' + esc(p.categoria) : '') + '</small>' + (isFinite(price) ? '<span>S/ ' + price.toFixed(2) + '</span>' : '') + '</div>';
  }
  function estadoBody() {
    var online = root.navigator.onLine !== false, pend = 0, blocked = 0;
    try { var s = root.NuevoAmanecerStatusBanner && root.NuevoAmanecerStatusBanner.compute(); if (s) { pend = s.retrying || 0; blocked = s.blocked || 0; } } catch (_) {}
    try { if (!pend && root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.pendingSnapshot()) pend = 1; } catch (_) {}
    return row('Conexión', '', '<span class="na9-badge ' + (online ? '' : 'off') + '">' + (online ? 'En línea' : 'Sin conexión') + '</span>')
      + row('Nube', '', '<span>' + (cloud() ? 'Activa' : 'No activa') + '</span>')
      + row('Operaciones pendientes de enviar', '', '<b>' + pend + '</b>')
      + row('Operaciones rechazadas o bloqueadas', '', '<b>' + blocked + '</b>')
      + row('Versión instalada', '', '<span id="na9Ver">…</span>');
  }

  // ---------- armado ----------
  function shell() {
    var page = doc.getElementById('pageConfig'); if (!page) return null;
    var el = doc.getElementById('naCfgV9');
    if (!el) {
      el = doc.createElement('div'); el.id = 'naCfgV9'; el.className = 'na9';
      el.innerHTML = '<nav class="na9-nav" id="na9Nav" aria-label="Configuración"></nav><main class="na9-main" id="na9Main"></main><div class="na9-saved" id="na9Saved" role="status" aria-live="polite"></div>';
      page.appendChild(el);
    }
    return el;
  }
  function topById(id) { for (var i = 0; i < TOP.length; i++) if (TOP[i][0] === id) return TOP[i]; return null; }
  var CHEV = '<svg class="na9-i na9-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
  function render() {
    var el = shell(); if (!el) return;
    var mob = !wide(); el.classList.toggle('na9-mob', mob); el.classList.toggle('na9-open', mob && st.open);
    var nav = doc.getElementById('na9Nav'), main = doc.getElementById('na9Main');
    unmountLegacy();
    if (!canEdit()) {
      nav.innerHTML = ''; nav.hidden = true;
      main.innerHTML = '<div class="na9-card"><div class="na9-lock">' + I('lock') + '<h3>Solo el admin puede entrar a Configuración</h3><p class="na9-muted">' + (root.navigator.onLine === false ? 'Sin conexión: Configuración necesita internet para confirmar que eres el admin.' : 'Pide al admin que ingrese en su aparato.') + '</p></div></div>';
      return;
    }
    nav.hidden = false;
    nav.innerHTML = '<h2>Configuración</h2>' + TOP.map(function (t) { return '<button type="button" class="na9-it' + (t[0] === st.top ? ' on' : '') + '" data-top="' + t[0] + '">' + I(t[2]) + '<span class="na9-tt">' + esc(t[1]) + '<small>' + esc(t[3]) + '</small></span>' + CHEV + '</button>'; }).join('')
      + '<div class="na9-reset"><button type="button" class="na9-it' + (st.top === 'reset' ? ' on' : '') + '" data-top="reset">' + I('reset') + '<span class="na9-tt">Reseteo</span>' + CHEV + '</button></div>';
    var h;
    if (st.top === 'reset') h = '<div class="na9-card"><div class="na9-hd"><h3>Reseteo</h3><p>Volver a descargar los datos de la nube</p></div><div class="na9-bd">' + resetBody() + '</div></div>';
    else {
      var t = topById(st.top) || TOP[0], a = st.tab[t[0]] || t[4][0][0], cur = t[4].filter(function (x) { return x[0] === a; })[0] || t[4][0];
      h = '<div class="na9-card"><div class="na9-hd"><h3>' + esc(t[1]) + '</h3><p>' + esc(cur[3]) + '</p></div><div class="na9-tabs" role="tablist">'
        + t[4].map(function (x) { return '<button type="button" role="tab" aria-selected="' + (x[0] === cur[0]) + '" class="na9-tab' + (x[0] === cur[0] ? ' on' : '') + '" data-tab="' + x[0] + '">' + I(x[2]) + esc(x[1]) + '</button>'; }).join('')
        + '</div><div class="na9-bd" data-sec="' + cur[0] + '">' + body(cur[0]) + '</div></div>';
    }
    if (mob) h = '<button type="button" class="na9-back" data-act="back"><svg class="na9-i" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>Configuración</button>' + h;
    main.innerHTML = h; applyAppearance();
    var host = main.querySelector('.na9-legacy-host');
    if (host) mountLegacy(host, host.dataset.legacy, host.dataset.only ? new RegExp(host.dataset.only) : null);
    if (main.querySelector('#naDevList') && root.NA_CONFIG_G && root.NA_CONFIG_G.loadDevices) Promise.resolve(root.NA_CONFIG_G.loadDevices()).then(function () { relabel(doc.getElementById('na9Main')); });
    if (main.querySelector('#na9Ver')) version();
    relabel(main); fitPreview();
  }
  function resetBody() {
    var keep = 'No se borran ventas, abonos, créditos, cajas, stock, movimientos de inventario, compras aplicadas, fotos de productos ni la Apariencia de este aparato.';
    if (!cloud()) return note(keep) + note('Sin la nube activa no hay nada que volver a descargar. Para empezar de cero, pide ayuda al soporte.');
    return note('<b>Atención:</b> vuelve a traer los datos del servidor a este aparato. Pide el PIN del admin (lo valida el servidor), necesita internet y no funciona si hay ventas, abonos o compras sin confirmar.', 'danger')
      + note(keep) + '<button type="button" class="na9-btn red" data-act="reset">' + I('reset') + 'Volver a descargar</button>';
  }
  function version() {
    var out = doc.getElementById('na9Ver'); if (!out) return;
    if (!root.caches || !root.caches.keys) { out.textContent = '—'; return; }
    root.caches.keys().then(function (ks) { var k = ks.filter(function (x) { return /^nuevo-amanecer-pos-shell-/.test(x); })[0]; out.textContent = k ? k.replace('nuevo-amanecer-pos-shell-', '').slice(0, 12) : '—'; }).catch(function () { out.textContent = '—'; });
  }
  // La vista previa entra completa en su caja (sin cortar a la derecha), como en el prototipo.
  function fitPreview() { var pr = doc.getElementById('na9Tk'); if (!pr || !pr.parentNode) return; pr.style.zoom = 1; var bw = pr.parentNode.clientWidth - 4; if (bw > 0 && pr.scrollWidth > bw) pr.style.zoom = (bw / pr.scrollWidth).toFixed(3); }
  function refreshPreview() { var pr = doc.getElementById('na9Tk'); if (pr) { pr.textContent = previewText(st.tkType); fitPreview(); } }

  // ---------- eventos ----------
  function guard() { if (canEdit()) return true; toast('Solo el admin puede cambiar la configuración.', 'error'); render(); return false; }
  // Error en línea debajo del campo (sin aviso flotante).
  function fieldErr(el, msg) {
    var lab = el && el.closest ? el.closest('label') : null; if (!lab) return;
    var m = lab.querySelector('.na9-err');
    if (!msg) { if (m) m.remove(); el.removeAttribute('aria-invalid'); return; }
    if (!m) { m = doc.createElement('span'); m.className = 'na9-err'; m.setAttribute('role', 'alert'); lab.appendChild(m); }
    m.textContent = msg; el.setAttribute('aria-invalid', 'true');
  }
  // Tocar cualquier parte de la fila de un interruptor lo cambia (no solo el interruptor).
  function onRowTap(e) {
    var t = e.target; if (!t || !t.closest || !t.closest('#naCfgV9')) return;
    if (t.closest('input,button,a,select,textarea,label')) return;
    var r = t.closest('.na9-row-sw'); if (!r) return;
    var cb = r.querySelector('.na9-sw input[type=checkbox]'); if (!cb || cb.disabled) return;
    cb.click();
  }
  function onChange(e) {
    var el = e.target, k = el && el.dataset ? el.dataset.na9 : null; if (!k || !el.closest('#naCfgV9')) return;
    if (k === 'zoom') { setZoom(Number(el.value)); var zv = doc.getElementById('na9Zv'); if (zv) { var zz = Number(el.value), nm = 'Personalizado'; ZP.forEach(function (x) { if (x[1] === zz) nm = x[0]; }); zv.textContent = nm + ' (' + zz + '%)'; } try { doc.querySelectorAll('#naCfgV9 .na9-zp').forEach(function (b) { b.classList.toggle('on', Number(b.dataset.z) === Number(el.value)); }); } catch (_) {} autosave(false); return; }
    if (!guard()) return;
    var c = C(), v = el.type === 'checkbox' ? el.checked : el.value, live = e.type === 'input';
    if (live && (el.type !== 'text' || k === 'freeShortcut')) return; // números, listas y atajo: al confirmar
    if (/^biz\./.test(k)) { var key = k.slice(4), clean = String(v).trim().slice(0, 120); c.business = c.business || {};
      if (key === 'ruc' || key === 'telefono') { var dg = String(v).replace(/\D/g, '').slice(0, key === 'ruc' ? 11 : 15); if (el.value !== dg) el.value = dg; clean = dg; }
      if (key === 'ruc' && clean && clean.length !== 11) { fieldErr(el, live ? '' : 'El RUC tiene 11 dígitos (van ' + clean.length + ').'); return; }
      if (!clean && (key === 'nombre' || key === 'direccion')) { fieldErr(el, live ? '' : (key === 'nombre' ? 'El nombre del negocio no puede quedar vacío.' : 'La dirección no puede quedar vacía.')); return; }
      fieldErr(el, ''); c.business[key] = clean; try { root._naApplyConfigUI(); } catch (_) {} autosave(true); return; }
    if (/^tk\./.test(k)) { var tk = k.slice(3); c.ticket = c.ticket || {}; c.ticket[tk] = v; refreshPreview(); autosave(true); return; }
    if (/^fmt\./.test(k)) { var fk = k.slice(4), fv = fk === 'serie' ? String(v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : v; if (fk === 'serie' && el.value !== fv) el.value = fv; setFmt(st.tkType, fk, fv); refreshPreview(); autosave(true); return; }
    if (/^zone\./.test(k)) { try { var s = root._naF11State(); s.settings[k.slice(5)].enabled = !!v; root._naF11PersistState(s); } catch (_) {} refreshPreview(); autosave(true); return; }
    if (/^cred\./.test(k)) { call('creditPolicySetNumber', k.slice(5), v); autosave(true); return; }
    switch (k) {
      case 'stockMin': call('actualizarStockMinPredeterminado', v); autosave(true); return;
      case 'stockAlertActive': case 'igvActive': case 'margenActive': case 'mayoristaActive': case 'printAuto':
        var ids = { stockAlertActive: 'stockToggle', igvActive: 'igvToggle', margenActive: 'margenToggle', mayoristaActive: 'mayoristaToggle', printAuto: 'printToggle' };
        if (!!c[k] !== !!v) call('toggleCfg', ids[k]);
        el.checked = !!c[k]; if (k === 'igvActive' || k === 'printAuto') refreshPreview(); autosave(true); return;
      case 'igvLine': try { root.localStorage.setItem('na_show_igv_line', v ? '1' : '0'); } catch (_) {} try { root.NA_CONFIG_E2.syncIgvRow(); } catch (_) {} c.ticket = c.ticket || {}; c.ticket.showIGV = !!v; autosave(true); return;
      case 'freeGeneric': if (!!fs().allowGenericSale !== !!v) call('freeSaleToggleSetting', 'allowGenericSale'); el.checked = !!fs().allowGenericSale; autosave(false); return;
      case 'freeNoStock': if (!!fs().allowRegisteredNoStock !== !!v) call('freeSaleToggleSetting', 'allowRegisteredNoStock'); el.checked = !!fs().allowRegisteredNoStock; autosave(false); return;
      case 'freeShortcut': call('freeSaleSetShortcut', v); el.value = fs().shortcut || el.value; autosave(false); return;
      case 'scanEnabled': if (!!sc().enabled !== !!v) call('scannerToggleSetting', 'enabled'); el.checked = !!sc().enabled; autosave(false); return;
      case 'scanSound': if (!!sc().sound !== !!v) call('scannerToggleSetting', 'sound'); el.checked = !!sc().sound; autosave(false); return;
      case 'scanInterval': call('scannerSetNumber', 'maxIntervalMs', v); autosave(false); return;
      case 'scanMin': call('scannerSetNumber', 'minLength', v); autosave(false); return;
      case 'credEnabled': if (!!cp().enabled !== !!v) call('creditPolicyToggleEnabled'); el.checked = !!cp().enabled; autosave(true); return;
    }
  }
  async function onClick(e) {
    var t = e.target; if (!t || !t.closest) return;
    if (!t.closest('#naCfgV9')) return;
    var top = t.closest('[data-top]'); if (top) { st.top = top.dataset.top; st.open = true; remember(); render(); if (!wide()) try { root.scrollTo(0, 0); } catch (_) {} return; }
    var tab = t.closest('[data-tab]'); if (tab) { st.tab[st.top] = tab.dataset.tab; remember(); render(); return; }
    var a = t.closest('[data-act]'); if (!a) return;
    var act = a.dataset.act;
    if (act === 'back') { st.open = false; render(); try { root.scrollTo(0, 0); } catch (_) {} return; }
    if (act === 'tkty') { st.tkType = a.dataset.t; render(); return; }
    if (act === 'tksub') { st.tkSub = a.dataset.t; render(); return; }
    if (act === 'imp') { st.imp = !st.imp; render(); return; }
    if (act === 'theme' || act === 'mode') { setAp(act, a.dataset.t); render(); badge('Guardado ✓ (este aparato)'); return; }
    if (act === 'zup' || act === 'zdn' || act === 'zset') { var z = act === 'zset' ? Number(a.dataset.z) : zoom() + (act === 'zup' ? 5 : -5); setZoom(z); render(); badge('Guardado ✓ (este aparato)'); return; }
    if (!guard()) return;
    if (act === 'stockAll') { await call('aplicarStockMinATodos'); return; }
    if (act === 'designer') { call('abrirDisenadorTicket'); return; }
    if (act === 'backup') { call('exportarRespaldo'); return; }
    if (act === 'pin') {
      var n1 = doc.getElementById('naPinNew'), n2 = doc.getElementById('naPinNew2');
      if (!/^\d{4,8}$/.test(n1.value)) { toast('El PIN debe tener de 4 a 8 dígitos.', 'error'); return; }
      if (n1.value !== n2.value) { toast('Los dos PIN nuevos no coinciden.', 'error'); return; }
      if (!(await confirmAction('¿Cambiar el PIN del admin? Lo necesitarás para anular, ajustar stock y resetear.', 'Cambiar PIN', 'Cambiar PIN'))) return;
      if (root.NA_CONFIG_G && root.NA_CONFIG_G.savePin) { await root.NA_CONFIG_G.savePin('admin'); render(); }
      return;
    }
    if (act === 'reset') {
      if (!(await confirmAction('¿Volver a descargar los datos de la nube en este aparato? Se pedirá el PIN del admin.', 'Reseteo', 'Continuar'))) return;
      await call('resetModule', 'nube'); return;
    }
  }

  function install() {
    installBuilder(); installTicketPicker();
    // En PC/tablet la Configuración nueva es la única que lee y escribe; el panel viejo no captura campos ocultos.
    if (typeof root._naCaptureVisibleConfig === 'function' && !root._naCaptureVisibleConfig.__na9) {
      var cap = root._naCaptureVisibleConfig;
      var w = function () { if (doc.getElementById('naCfgV9') && !legacy.capt) return; return cap.apply(this, arguments); };
      w.__na9 = true; root._naCaptureVisibleConfig = w;
    }
    applyAppearance();
    var page = doc.getElementById('pageConfig');
    if (page && !install.obs && root.MutationObserver) {
      install.obs = true; var was = page.classList.contains('active');
      new root.MutationObserver(function () { var now = page.classList.contains('active'); if (now && !was) { if (!wide()) st.open = false; render(); } if (!now && was) unmountLegacy(); was = now; }).observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    shell(); applyAppearance(); if (page && page.classList.contains('active')) render();
  }
  if (!install.events) {
    install.events = true;
    doc.addEventListener('click', onClick);
    doc.addEventListener('click', onRowTap);
    doc.addEventListener('change', onChange);
    doc.addEventListener('input', onChange);
    var onWidth = function () {
      applyAppearance();
      var p = doc.getElementById('pageConfig'); shell(); if (p && p.classList.contains('active')) render();
    };
    if (MQ.addEventListener) MQ.addEventListener('change', onWidth); else if (MQ.addListener) MQ.addListener(onWidth);
    if (darkMQ && darkMQ.addEventListener) darkMQ.addEventListener('change', applyAppearance);
    root.addEventListener('na:role', function () { var p = doc.getElementById('pageConfig'); if (p && p.classList.contains('active')) render(); });
    root.addEventListener('online', function () { var p = doc.getElementById('pageConfig'); if (p && p.classList.contains('active')) render(); });
    root.addEventListener('offline', function () { var p = doc.getElementById('pageConfig'); if (p && p.classList.contains('active')) render(); });
  }
  // La barra superior de día/noche sigue funcionando: en PC/tablet recuerda la elección.
  function wrapDark() {
    if (typeof root.toggleDark !== 'function' || root.toggleDark.__na9) return;
    var base = root.toggleDark;
    root.toggleDark = function () { var r = base.apply(this, arguments); { var d = ap(); d.mode = doc.body.classList.contains('dark') ? 'noche' : 'claro'; try { root.localStorage.setItem(AP_KEY, JSON.stringify(d)); } catch (_) {} appliedDark = d.mode === 'noche'; } applyAppearance(); return r; };
    root.toggleDark.__na9 = true;
  }
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', function () { install(); wrapDark(); }); else { install(); wrapDark(); }
  root.addEventListener('load', function () { install(); wrapDark(); applyAppearance(); });
  root.NA_CONFIG_V9 = { render: render, wide: wide, canEdit: canEdit, previewText: previewText, setPrintFormat: function (f) { printFormat = f; }, appearance: ap, applyAppearance: applyAppearance };
})(window);
