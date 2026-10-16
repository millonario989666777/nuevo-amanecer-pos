/* Asistente del POS (PROTOTIPO AISLADO): burbuja animada + panel de chat.
   - Nunca ejecuta nada sin «Confirmar»; la ejecución pasa por NA_ASISTENTE_CORE.createGate.
   - Ventas: solo llena el carrito con posAdd (el cobro sigue por Cobrar, el outbox y su operation_id).
   - Compras: abre «Nueva compra» (NA_PURCHASES) con las líneas; registra la persona.
   - Precio: abre la ficha del producto (editProd) con el precio nuevo; guarda la persona (pide PIN si toca).
   - Sin internet: «Asistente no disponible sin internet». */
(function (root) {
  'use strict';
  var doc = root.document, C = root.NA_ASISTENTE_CORE;
  if (!doc || !C || root.NA_ASISTENTE) return;
  var ASSET = 'assets/asistente/';
  var history = [], state = 'idle', quality = 'high', lowBattery = false, slowFrames = false, stateTimer = null, busy = false;

  // ---------- Personaje ----------
  function bits() { var a = ''; for (var i = 0; i < 16; i++) { for (var k = 0; k < 18; k++) a += Math.random() > .5 ? '1' : '0'; a += '<br>'; } return a; }
  function charHtml() {
    var orbit = '', conf = '', colors = ['#22c55e', '#facc15', '#38bdf8', '#f472b6', '#a3e635'];
    for (var i = 0; i < 12; i++) orbit += '<i style="transform:translate(-50%,-50%) rotate(' + (i * 30) + 'deg) translateY(calc(var(--asst-size) * -.62)) rotate(-' + (i * 30) + 'deg)">' + (i % 3 ? (i % 2) : '01') + '</i>';
    for (var j = 0; j < 10; j++) { var a = j / 10 * Math.PI * 2; conf += '<b style="--dx:' + Math.round(Math.cos(a) * 46) + 'px;--dy:' + Math.round(Math.sin(a) * 46 - 18) + 'px;background:' + colors[j % 5] + '"></b>'; }
    return '<div class="na-asst-char" data-state="idle" data-q="high"><div class="na-asst-shadow"></div><div class="na-asst-hop"><div class="na-asst-squash">' +
      '<div class="na-asst-orbit" aria-hidden="true">' + orbit + '</div>' +
      '<div class="na-asst-sphere"><div class="na-asst-bits"><div>' + bits() + bits() + '</div></div>' +
      '<svg class="na-asst-face" viewBox="0 0 100 100" aria-hidden="true"><defs>' +
      '<radialGradient id="naAsstIris" cx="40%" cy="35%"><stop offset="0" stop-color="#bbf7d0"/><stop offset=".45" stop-color="#22c55e"/><stop offset="1" stop-color="#14532d"/></radialGradient>' +
      '<radialGradient id="naAsstIrisB" cx="40%" cy="35%"><stop offset="0" stop-color="#bfdbfe"/><stop offset=".5" stop-color="#2563eb"/><stop offset="1" stop-color="#1e3a8a"/></radialGradient>' +
      '<clipPath id="naAsstEyeL"><ellipse cx="33" cy="45" rx="13.5" ry="15.5"/></clipPath><clipPath id="naAsstEyeR"><ellipse cx="67" cy="45" rx="13.5" ry="15.5"/></clipPath></defs>' +
      '<ellipse cx="22" cy="63" rx="6" ry="3.2" fill="#bbf7d0" opacity=".45"/><ellipse cx="78" cy="63" rx="6" ry="3.2" fill="#bbf7d0" opacity=".45"/>' +
      eye('L', 33) + eye('R', 67) +
      '<path class="brow" d="M21 27 L42 32 M58 32 L79 27" stroke="#052e16" stroke-width="3" stroke-linecap="round"/>' +
      '<path class="m m-smile" d="M43 66 Q50 72 57 66" fill="none" stroke="#052e16" stroke-width="2.6" stroke-linecap="round"/>' +
      '<g class="m m-open"><path d="M40 64 Q50 82 60 64 Z" fill="#7f1d1d" stroke="#052e16" stroke-width="1.5"/><ellipse cx="50" cy="73" rx="5.5" ry="3.2" fill="#fb7185"/></g>' +
      '<ellipse class="m m-talk" cx="50" cy="69" rx="6" ry="5" fill="#7f1d1d" stroke="#052e16" stroke-width="1.5"/>' +
      '<path class="m m-worry" d="M42 72 Q50 65 58 72" fill="none" stroke="#052e16" stroke-width="2.6" stroke-linecap="round"/></svg>' +
      '<div class="na-asst-gloss"></div><div class="na-asst-gloss2"></div><div class="na-asst-rim"></div></div></div></div>' +
      '<div class="na-asst-confetti">' + conf + '</div><div class="na-asst-badge" aria-hidden="true"></div></div>';
  }
  function eye(s, cx) {
    return '<g clip-path="url(#naAsstEye' + s + ')"><ellipse cx="' + cx + '" cy="45" rx="13.5" ry="15.5" fill="#f8fafc"/>' +
      '<g class="pupils"><circle cx="' + cx + '" cy="47" r="9.5" fill="url(#naAsstIris)"/><g class="iris-think"><circle cx="' + cx + '" cy="47" r="9.5" fill="url(#naAsstIrisB)"/>' +
      '<text x="' + cx + '" y="50.5" font-size="8.5" font-family="monospace" font-weight="700" text-anchor="middle" fill="#dbeafe">01</text></g>' +
      '<circle cx="' + cx + '" cy="47" r="4.2" fill="#052e16"/><circle cx="' + (cx - 3.4) + '" cy="42.6" r="2.8" fill="#fff"/><circle cx="' + (cx + 3) + '" cy="51" r="1.2" fill="#fff" opacity=".8"/></g>' +
      '<rect class="lid" x="' + (cx - 15) + '" y="29" width="30" height="33" fill="#1fb456"/></g>';
  }

  // ---------- Estados y calidad ----------
  var LABELS = { idle: '', happy: '¡Hola!', thinking: 'Concentrado…', talking: 'Hablando', error: 'Algo falló', done: '¡Listo!' };
  function chars() { return doc.querySelectorAll('.na-asst-char'); }
  function setState(s, ms) {
    state = s; clearTimeout(stateTimer);
    chars().forEach(function (c) { c.dataset.state = s; var b = c.querySelector('.na-asst-badge'); if (b) b.textContent = s === 'error' ? '!' : s === 'done' ? '✓' : ''; });
    if (rootEl) { rootEl.dataset.state = s; tagEl.textContent = LABELS[s] || ''; }
    if (ms) stateTimer = setTimeout(function () { setState('idle'); }, ms);
  }
  function computeQuality() {
    try { if (root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'off'; } catch (_) {}
    var n = root.navigator || {}, weak = (n.hardwareConcurrency && n.hardwareConcurrency <= 4) || (n.deviceMemory && n.deviceMemory <= 2);
    return (weak || lowBattery || slowFrames) ? 'low' : 'high';
  }
  function applyQuality() { quality = computeQuality(); chars().forEach(function (c) { c.dataset.q = quality; }); if (rootEl) rootEl.dataset.q = quality; }
  // Mide el tiempo de cuadro unos 1.5 s; si el aparato no llega a ~45 fps baja la calidad.
  function measureFrames() {
    if (!root.requestAnimationFrame || doc.hidden) return;
    var t = [], last = 0;
    function f(ts) { if (last) t.push(ts - last); last = ts; if (t.length < 90) root.requestAnimationFrame(f); else {
      t.sort(function (a, b) { return a - b; }); var med = t[45], jank = t.filter(function (x) { return x > 34; }).length;
      var was = slowFrames; slowFrames = med > 22 || jank > 9; if (was !== slowFrames) applyQuality(); } }
    root.requestAnimationFrame(f);
  }
  function watchBattery() {
    try { if (!root.navigator.getBattery) return; root.navigator.getBattery().then(function (b) {
      function u() { lowBattery = !b.charging && b.level <= 0.2; applyQuality(); }
      b.addEventListener('levelchange', u); b.addEventListener('chargingchange', u); u(); }).catch(function () {});
    } catch (_) {}
  }
  // Pausa: pestaña oculta o una ventana del POS abierta (cobro, compra, ficha): nunca compite con Cobrar.
  function busyPos() { return !!doc.querySelector('.modal-overlay.open, #naPurchaseDialog, .na-pin-overlay'); }
  function applyPause() { var p = doc.hidden || (busyPos() && panelEl && panelEl.hidden) ? '1' : '0'; chars().forEach(function (c) { c.dataset.paused = p; }); }

  // ---------- Posición: nunca tapar Cobrar ni el carrito ----------
  function visible(el) { if (!el) return null; var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' ? r : null; }
  function place() {
    if (!rootEl) return;
    var vw = root.innerWidth, vh = root.innerHeight, right = 14, bottom = 16;
    var pos = doc.getElementById('pagePOS'), posActive = pos && pos.classList.contains('active');
    if (posActive) {
      var foot = visible(doc.querySelector('#pagePOS .cart-footer')), drawer = visible(doc.getElementById('cartDrawer'));
      if (drawer && drawer.left > vw * 0.45 && drawer.width < vw * 0.9) right = Math.round(vw - drawer.left + 16); // carrito acoplado (PC/tablet)
      else if (foot && foot.top < vh) bottom = Math.round(vh - foot.top + 12); // teléfono: encima de Total/Cobrar
    }
    rootEl.style.setProperty('--asst-right', right + 'px'); rootEl.style.setProperty('--asst-bottom', bottom + 'px');
    if (panelEl) panelEl.style.setProperty('--asst-panel-right', (right > 14 ? right : 16) + 'px');
  }

  // ---------- Red ----------
  function creds() { try { var c = JSON.parse(root.localStorage.getItem('na_cloud_sync_credentials') || 'null'); return c && c.endpoint && c.token ? c : null; } catch (_) { return null; } }
  function protoRole() { try { return root.localStorage.getItem('na_asistente_proto_role') === 'empleado' ? 'empleado' : null; } catch (_) { return null; } }
  function roles() {
    var R = root.NA_ROLES || { role: 'unknown' };
    if (!creds() && protoRole()) return { role: 'empleado', isOwner: function () { return false; } };
    return R;
  }
  async function post(path, body) {
    if (creds() && root.NA_ROLES && root.NA_ROLES.api) {
      try { return await root.NA_ROLES.api(path, body); } catch (e) { if (e && e.status) return Object.assign({ error: e.message, status: e.status }, e.data || {}); throw e; }
    }
    var h = { 'content-type': 'application/json' }; if (protoRole()) h['x-proto-role'] = 'empleado';
    var r = await root.fetch(path, { method: 'POST', headers: h, body: JSON.stringify(body), cache: 'no-store' });
    var d = {}; try { d = await r.json(); } catch (_) {}
    if (!r.ok) d.error = d.error || 'HTTP_' + r.status;
    return d;
  }
  // Confirmación: el MISMO token se reenvía hasta 3 veces si se corta la señal (mismo operation_id).
  async function confirmRemote(p) {
    var clean = JSON.parse(JSON.stringify(p)); delete clean.confirm_token;
    var lastErr;
    for (var i = 0; i < 3; i++) {
      try { var d = await post('/auth/assistant/confirm', { token: p.confirm_token, proposal: clean }); return d.ok ? d : { ok: false, error: d.error }; }
      catch (e) { lastErr = e; await new Promise(function (r) { setTimeout(r, 600 * (i + 1)); }); }
    }
    throw lastErr || new Error('network');
  }

  // ---------- Funciones existentes del POS ----------
  function g(name) { try { return (0, eval)('typeof ' + name + '!=="undefined"?' + name + ':undefined'); } catch (_) { return undefined; } }
  var deps = {
    roles: roles, confirm: confirmRemote, online: function () { return root.navigator.onLine !== false; },
    productos: function () { return g('productos') || []; },
    posAdd: function (id) { var f = g('posAdd'); return typeof f === 'function' ? f(id) : false; },
    navigate: function (id) { try { root.NA_MENU_NAVIGATION.navigate(id); } catch (_) { try { root.goPage(id); } catch (__) {} } },
    openPurchase: function () { if (!root.NA_PURCHASES) return null; root.NA_PURCHASES.open(); return doc.getElementById('naPurchaseDialog'); },
    fillPurchase: function (w, p) {
      var s = w.querySelector('#naPurSupplier'), d = w.querySelector('#naPurDoc');
      if (s && p.proveedor) s.value = p.proveedor; if (d && p.documento) d.value = p.documento;
      var add = w.querySelector('.na-pur-add');
      p.lineas.forEach(function (l, i) {
        if (i > 0 && add) add.click();
        var row = w.querySelectorAll('.na-pur-line')[i]; if (!row) return;
        var prod = l.product_id && deps.productos().find(function (x) { return String(x.id) === String(l.product_id); });
        row.querySelector('.na-pur-prod').value = prod ? (prod.nombre || prod.name) : l.nombre;
        row.querySelector('.na-pur-qty').value = l.cantidad;
        if (l.costo_unitario != null) row.querySelector('.na-pur-cost').value = l.costo_unitario;
        if (!prod) row.querySelector('.na-pur-prod').style.outline = '3px solid #f59e0b';
      });
      w.dispatchEvent(new Event('input', { bubbles: true }));
    },
    openPriceEditor: function (id, price) {
      var f = g('editProd'); if (typeof f !== 'function') return;
      f(id); var i = doc.getElementById('pPrecio'); if (!i) return;
      i.value = Number(price).toFixed(2); i.dispatchEvent(new Event('input', { bubbles: true })); i.style.outline = '3px solid #16a34a'; try { i.focus(); } catch (_) {}
    },
    showDocument: function (html) {
      var o = doc.createElement('div'); o.className = 'na-asst-doc'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true');
      o.innerHTML = '<div><iframe title="Vista previa del documento"></iframe><div class="acts"><button type="button" class="na-asst-no">Cerrar</button><button type="button" class="na-asst-ok">Imprimir / Guardar PDF</button></div></div>';
      o.querySelector('iframe').srcdoc = html; doc.body.appendChild(o);
      o.querySelector('.na-asst-no').onclick = function () { o.remove(); };
      o.querySelector('.na-asst-ok').onclick = function () { try { o.querySelector('iframe').contentWindow.print(); } catch (_) {} };
    },
    businessName: function () { return 'Botica Nuevo Amanecer'; }
  };
  var gate = C.createGate(deps);

  // ---------- Panel ----------
  var rootEl, tagEl, panelEl, msgsEl, inputEl, sendBtn, photoBtn, fileEl, offEl;
  function el(tag, cls, html) { var e = doc.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function scrollEnd() { msgsEl.scrollTop = msgsEl.scrollHeight; }
  function addMsg(kind, text, img) { var m = el('div', 'na-asst-msg ' + kind); m.textContent = text; if (img) { var i = el('img'); i.src = img; i.alt = 'Foto enviada'; m.appendChild(i); } msgsEl.appendChild(m); scrollEnd(); return m; }
  function soles(n) { return C.soles(n); }
  function cardHtml(p) {
    var E = C.esc, rows = '';
    if (p.type === 'pasos') return '<h4>' + E(p.title) + '</h4><ol>' + p.pasos.map(function (s) { return '<li>' + E(s) + '</li>'; }).join('') + '</ol>' +
      (p.pantalla ? '<div class="acts"><button type="button" class="na-asst-ok" data-go>Llévame ahí</button></div>' : '');
    if (p.type === 'venta') { rows = p.lineas.map(function (l) { return '<tr><td>' + E(l.cantidad) + ' × ' + E(l.nombre) + '</td><td class="r">' + soles(l.precio * l.cantidad) + '</td></tr>'; }).join('');
      rows += '<tr><td><b>Total</b></td><td class="r"><b>' + soles(p.total) + '</b></td></tr>'; }
    if (p.type === 'compra') rows = p.lineas.map(function (l) { return '<tr><td>' + E(l.cantidad) + ' × ' + E(l.nombre) + (l.product_id ? '' : ' <b style="color:#b45309">(no registrado)</b>') + '</td><td class="r">' + (l.costo_unitario != null ? soles(l.costo_unitario) : '') + '</td></tr>'; }).join('');
    if (p.type === 'precio') rows = '<tr><td>' + E(p.nombre) + '</td><td class="r">' + soles(p.precio_actual) + ' → <b>' + soles(p.precio_nuevo) + '</b></td></tr>';
    if (p.type === 'documento') rows = p.lineas.map(function (l) { return '<tr><td>' + E(l.cantidad) + ' × ' + E(l.nombre) + '</td><td class="r">' + soles(l.precio) + '</td></tr>'; }).join('');
    var warn = '';
    if (p.type === 'venta' && p.faltan && p.faltan.length) warn += '<div class="warn">No encontré: ' + E(p.faltan.join(', ')) + '</div>';
    if (p.type === 'compra' && p.sinProducto) warn += '<div class="warn">' + p.sinProducto + ' línea(s) sin producto registrado: revísalas.</div>';
    if (p.type === 'precio' && p.cambioGrande) warn += '<div class="warn">Cambio grande (más de 50%). Revisa bien.</div>';
    if (p.type === 'precio' && p.bajoCosto) warn += '<div class="warn">El precio nuevo queda por debajo del costo.</div>';
    var note = { venta: 'Al confirmar, los productos van al carrito. El cobro lo haces tú con Cobrar.', compra: 'Al confirmar, se abre «Nueva compra» llena. El stock sube solo cuando pulses «Registrar compra».',
      precio: 'Al confirmar, se abre la ficha del producto con el precio nuevo. Se aplica cuando pulses Guardar.', documento: 'Documento interno de prueba. NO es comprobante SUNAT.' }[p.type];
    var head = p.type === 'compra' && (p.proveedor || p.documento) ? '<div class="note">' + E([p.proveedor, p.documento, p.fecha].filter(Boolean).join(' · ')) + '</div>' : '';
    return '<h4>' + E(p.title) + '</h4>' + head + '<table>' + rows + '</table>' + warn + '<div class="note">' + E(note) + '</div><div class="res" aria-live="polite"></div>' +
      '<div class="acts"><button type="button" class="na-asst-no" data-no>Cancelar</button><button type="button" class="na-asst-ok" data-ok>Confirmar</button></div>';
  }
  function addCard(p) {
    gate.add(p);
    var c = el('div', 'na-asst-card', cardHtml(p)); c.dataset.type = p.type; c.dataset.st = 'pending'; msgsEl.appendChild(c);
    var res = c.querySelector('.res');
    var go = c.querySelector('[data-go]'); if (go) go.onclick = function () { gate.execute(p.id, { confirmed: true }).then(function () { closePanel(); }); };
    var no = c.querySelector('[data-no]'); if (no) no.onclick = function () { gate.cancel(p.id); c.dataset.st = 'cancelled'; res.textContent = 'Cancelado. No se hizo nada.'; };
    var ok = c.querySelector('[data-ok]');
    if (ok) ok.onclick = function () {
      ok.disabled = true; no.disabled = true; ok.textContent = 'Confirmando…';
      gate.execute(p.id, { confirmed: true }).then(function (r) {
        res.textContent = r.msg; c.dataset.st = gate.state(p.id) || 'pending';
        if (r.ok) { setState('done', 2600); if (p.type !== 'documento') setTimeout(closePanel, 1400); }
        else { setState('error', 2600); if (c.dataset.st === 'pending') { ok.disabled = false; no.disabled = false; ok.textContent = 'Confirmar'; } }
      });
    };
    scrollEnd();
  }
  var ERRORS = { rate_limited: 'Vas muy rápido. Espera un minuto.', daily_limit: 'Llegaste al límite de hoy en este aparato.', monthly_cap: 'Se alcanzó el tope del mes del asistente. Avisa al dueño.',
    image_too_large: 'La foto es muy grande.', bad_image: 'No pude leer esa foto.', upstream_timeout: 'El asistente tardó mucho. Inténtalo otra vez.', upstream_error: 'El asistente no respondió. Inténtalo otra vez.',
    upstream_busy: 'El asistente está ocupado. Inténtalo en un momento.', not_found: 'El asistente no está activado en este servidor.', forbidden_role: 'No tienes permiso para esto.', unauthorized: 'Este aparato no tiene sesión.' };
  async function send(text, image) {
    if (busy) return;
    if (root.navigator.onLine === false) { offline(true); addMsg('sys', 'Asistente no disponible sin internet'); setState('error', 2000); return; }
    text = String(text || '').trim(); if (!text && !image) return;
    addMsg('u', text || 'Foto', image); inputEl.value = ''; busy = true; sendBtn.disabled = true; photoBtn.disabled = true; setState('thinking');
    var thinking = addMsg('a', 'Concentrado…'); thinking.classList.add('na-asst-thinking');
    var screen = (doc.querySelector('.page.active') || {}).id || null;
    var body = { text: C.redactText(text), history: history.slice(-8), context: C.buildContext(deps.productos(), roles().role, screen, text) };
    if (image) body.image = image;
    try {
      var d = await post('/auth/assistant/chat', body); thinking.remove();
      if (!d.ok) { addMsg('a', ERRORS[d.error] || 'No se pudo completar. Inténtalo otra vez.'); setState('error', 2600); return; }
      history.push({ role: 'user', content: body.text || 'Foto' }, { role: 'assistant', content: d.reply });
      addMsg('a', d.reply); if (d.mode === 'mock') { var m = el('div', 'na-asst-mode'); m.textContent = 'Modo demostración (sin clave de DeepSeek)'; msgsEl.appendChild(m); }
      (d.proposals || []).forEach(addCard);
      setState('talking', Math.min(4000, 900 + d.reply.length * 25));
    } catch (e) { thinking.remove(); addMsg('a', root.navigator.onLine === false ? 'Asistente no disponible sin internet' : 'No se pudo conectar. Revisa internet.'); setState('error', 2600); }
    finally { busy = false; sendBtn.disabled = root.navigator.onLine === false; photoBtn.disabled = root.navigator.onLine === false; }
  }
  // Comprime en el aparato: lado mayor 1600 px, JPEG, baja calidad hasta quedar < 1.4 MB.
  function compress(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file), img = new Image();
      img.onload = function () {
        var max = 1600, s = Math.min(1, max / Math.max(img.width, img.height)), cv = doc.createElement('canvas');
        cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
        var ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
        var q = 0.72, out = cv.toDataURL('image/jpeg', q);
        while (out.length > 1400000 && q > 0.35) { q -= 0.1; out = cv.toDataURL('image/jpeg', q); }
        resolve(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('bad_image')); };
      img.src = url;
    });
  }
  function offline(on) { offEl.hidden = !on; sendBtn.disabled = on || busy; photoBtn.disabled = on || busy; if (on && state !== 'error') setState('error', 1800); }
  function openPanel() {
    panelEl.hidden = false; rootEl.hidden = true; place(); applyPause();
    if (!msgsEl.children.length) addMsg('a', '¡Hola! Soy Burbuja. Te ayudo a vender, registrar compras, leer fotos de facturas, preparar documentos y explicarte el sistema. Nada se hace sin que pulses Confirmar.');
    offline(root.navigator.onLine === false); setState('happy', 1300); measureFrames();
    setTimeout(function () { try { inputEl.focus({ preventScroll: true }); } catch (_) {} }, 50);
  }
  function closePanel() { panelEl.hidden = true; rootEl.hidden = false; place(); applyPause(); }

  function mount() {
    rootEl = el('div', 'na-asst-root'); rootEl.dataset.state = 'idle';
    rootEl.innerHTML = '<span class="na-asst-tag" aria-hidden="true"></span><button type="button" class="na-asst-bubble" aria-label="Abrir asistente Burbuja">' + charHtml() + '</button>';
    tagEl = rootEl.querySelector('.na-asst-tag');
    panelEl = el('section', 'na-asst-panel'); panelEl.hidden = true; panelEl.setAttribute('role', 'dialog'); panelEl.setAttribute('aria-label', 'Asistente Burbuja');
    panelEl.innerHTML = '<div class="na-asst-head">' + charHtml() + '<div class="na-asst-head-t"><b>Burbuja</b><small>Asistente · prueba aislada</small></div><button type="button" class="na-asst-x" aria-label="Cerrar asistente">✕</button></div>' +
      '<div class="na-asst-offline" hidden>Asistente no disponible sin internet</div><div class="na-asst-msgs" aria-live="polite"></div>' +
      '<div class="na-asst-chips"><button type="button" data-q="¿Cómo cobro una venta?">¿Cómo cobro?</button><button type="button" data-photo>Leer factura (foto)</button><button type="button" data-q="Vende 2 paracetamol">Preparar venta</button></div>' +
      '<div class="na-asst-input"><button type="button" class="na-asst-photo" aria-label="Enviar foto">📷</button><input type="file" accept="image/*" capture="environment" hidden>' +
      '<textarea rows="1" placeholder="Escribe aquí…" aria-label="Mensaje para el asistente"></textarea><button type="button" class="na-asst-send" aria-label="Enviar">➤</button></div>';
    doc.body.appendChild(rootEl); doc.body.appendChild(panelEl);
    msgsEl = panelEl.querySelector('.na-asst-msgs'); inputEl = panelEl.querySelector('textarea'); sendBtn = panelEl.querySelector('.na-asst-send');
    photoBtn = panelEl.querySelector('.na-asst-photo'); fileEl = panelEl.querySelector('input[type=file]'); offEl = panelEl.querySelector('.na-asst-offline');
    rootEl.querySelector('.na-asst-bubble').onclick = openPanel;
    panelEl.querySelector('.na-asst-x').onclick = closePanel;
    sendBtn.onclick = function () { send(inputEl.value); };
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(inputEl.value); } });
    photoBtn.onclick = function () { fileEl.click(); };
    fileEl.onchange = function () { var f = fileEl.files && fileEl.files[0]; fileEl.value = ''; if (!f) return;
      compress(f).then(function (img) { send(inputEl.value || 'Lee esta factura de compra', img); }).catch(function () { addMsg('a', 'No pude abrir esa foto.'); setState('error', 2000); }); };
    panelEl.querySelector('.na-asst-chips').addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; if (b.hasAttribute('data-photo')) fileEl.click(); else send(b.dataset.q); });
    root.addEventListener('online', function () { offline(false); setState('idle'); });
    root.addEventListener('offline', function () { offline(true); });
    doc.addEventListener('visibilitychange', applyPause);
    root.addEventListener('resize', place);
    setInterval(function () { place(); applyPause(); }, 1000);
    applyQuality(); watchBattery(); place(); applyPause(); setState('idle');
    setTimeout(measureFrames, 1500);
  }

  root.NA_ASISTENTE = { open: function () { openPanel(); }, close: function () { closePanel(); }, setState: setState, send: send, _gate: gate, _deps: deps, get quality() { return quality; }, place: place };
  if (doc.body) mount(); else doc.addEventListener('DOMContentLoaded', mount);
})(window);
