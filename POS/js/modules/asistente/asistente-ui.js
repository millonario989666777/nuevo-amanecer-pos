/* Asistente del POS (PROTOTIPO AISLADO, modo admin): burbuja animada + panel de chat + tarjeta en Inicio.
   - Dueño: siempre. Aparato de empleado: solo si el dueño le dio un nivel («Solo consultas» o «Consultas y documentos»).
     Quién puede lo dice el SERVIDOR (ping a /auth/assistant/chat); aquí no se guarda el permiso en ninguna caché.
   - Solo en pantallas de gestión (nunca en Venta ni en Caja: no tapa Cobrar).
   - No vende ni llena el carrito.
   - Nunca ejecuta nada sin «Confirmar» + PIN del dueño; la ejecución pasa por NA_ASISTENTE_CORE.createGate y abre
     pantallas EXISTENTES del POS: Nueva compra, Registrar movimiento, ficha del producto, Nuevo producto.
   - Consultas: números leídos por el Worker (solo lectura). Documentos: internos, armados en el aparato, NO SUNAT.
   - Sin internet: «Asistente no disponible sin internet» (los documentos locales igual se pueden abrir). */
(function (root) {
  'use strict';
  var doc = root.document, C = root.NA_ASISTENTE_CORE;
  if (!doc || !C || root.NA_ASISTENTE) return;
  var history = [], state = 'listo', quality = 'high', lowBattery = false, slowFrames = false, stateTimer = null, busy = false;
  var clockOffset = 0;
  var IDLE_MS = 20000, idleTimer = null, sleeping = false, offscreen = false, adminOff = false;
  // Pantallas de gestión donde vive la burbuja. Nunca Venta (pagePOS) ni Caja (pageCaja).
  var ADMIN_PAGES = ['pageMenu', 'pageInventario', 'pageVentas', 'pageClientes', 'pageGastos', 'pageConfig', 'pageHistorialCompras', 'pageValorizacion', 'pageReporteDeuda', 'pageKardex', 'pageVentasStock', 'pageRotacionAbc', 'pageReporteArqueo', 'pageCodigosDuplicados'];
  // access: lo último que dijo el servidor ({ role: 'owner' | 'empleado', level }). null = todavía no se sabe.
  var access = null;
  function isAdmin() { return !adminOff && !!access && (access.role === 'owner' || access.level === 'consultas' || access.level === 'consultas_documentos'); }
  function isOwnerAccess() { return isAdmin() && access.role === 'owner'; }
  function pageId() { var a = doc.querySelector('.page.active'); return a ? a.id : null; }
  function allowedHere() { return isAdmin() && ADMIN_PAGES.indexOf(pageId()) >= 0; }

  // ---------- Personaje ----------
  function bits() { var a = ''; for (var i = 0; i < 16; i++) { for (var k = 0; k < 18; k++) a += Math.random() > .5 ? '1' : '0'; a += '<br>'; } return a; }
  function charHtml() {
    var orbit = '', conf = '', colors = ['#22c55e', '#facc15', '#38bdf8', '#f472b6', '#a3e635'];
    for (var i = 0; i < 12; i++) orbit += '<i style="transform:translate(-50%,-50%) rotate(' + (i * 30) + 'deg) translateY(calc(var(--asst-size) * -.62)) rotate(-' + (i * 30) + 'deg)">' + (i % 3 ? (i % 2) : '01') + '</i>';
    for (var j = 0; j < 10; j++) { var a = j / 10 * Math.PI * 2; conf += '<b style="--dx:' + Math.round(Math.cos(a) * 46) + 'px;--dy:' + Math.round(Math.sin(a) * 46 - 18) + 'px;background:' + colors[j % 5] + '"></b>'; }
    return '<div class="na-asst-char" data-state="listo" data-q="high"><div class="na-asst-shadow"></div><div class="na-asst-hop"><div class="na-asst-squash">' +
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
      '<path class="m m-worry" d="M42 72 Q50 65 58 72" fill="none" stroke="#052e16" stroke-width="2.6" stroke-linecap="round"/>' +
      '<circle class="m m-o" cx="53" cy="69" r="3.2" fill="none" stroke="#052e16" stroke-width="2.2"/></svg>' +
      '<div class="na-asst-tint"></div><div class="na-asst-gloss"></div><div class="na-asst-gloss2"></div><div class="na-asst-rim"></div></div></div></div>' +
      '<div class="na-asst-dots" aria-hidden="true"><i></i><i></i><i></i></div><div class="na-asst-confetti">' + conf + '</div><div class="na-asst-badge" aria-hidden="true"></div></div>';
  }
  function eye(s, cx) {
    return '<g clip-path="url(#naAsstEye' + s + ')"><ellipse cx="' + cx + '" cy="45" rx="13.5" ry="15.5" fill="#f8fafc"/>' +
      '<g class="pupils"><circle cx="' + cx + '" cy="47" r="9.5" fill="url(#naAsstIris)"/><g class="iris-think"><circle cx="' + cx + '" cy="47" r="9.5" fill="url(#naAsstIrisB)"/>' +
      '<text x="' + cx + '" y="50.5" font-size="8.5" font-family="monospace" font-weight="700" text-anchor="middle" fill="#dbeafe">01</text></g>' +
      '<circle cx="' + cx + '" cy="47" r="4.2" fill="#052e16"/><circle cx="' + (cx - 3.4) + '" cy="42.6" r="2.8" fill="#fff"/><circle cx="' + (cx + 3) + '" cy="51" r="1.2" fill="#fff" opacity=".8"/></g>' +
      '<rect class="lid" x="' + (cx - 15) + '" y="29" width="30" height="33" fill="#1fb456"/></g>';
  }

  // ---------- Estados y calidad ----------
  var LABELS = { listo: '', concentrado: 'Concentrado…', pensando: 'Pensando…', hablando: 'Hablando', feliz: '¡Listo!', error: 'Algo falló', offline: 'Sin internet' };
  function chars() { return doc.querySelectorAll('.na-asst-char'); }
  function setState(s, ms) {
    state = s; clearTimeout(stateTimer);
    chars().forEach(function (c) { c.dataset.state = s; var b = c.querySelector('.na-asst-badge'); if (b) b.textContent = s === 'error' ? '!' : s === 'feliz' ? '✓' : ''; });
    if (rootEl) { rootEl.dataset.state = s; tagEl.textContent = LABELS[s] || ''; }
    if (ms) stateTimer = setTimeout(function () { setState(root.navigator.onLine === false ? 'offline' : 'listo'); }, ms);
    wake();
  }
  // Batería: tras ~20 s quieta en Listo (panel cerrado) las animaciones infinitas se pausan. Tocar o cambiar de estado las reanuda.
  function wake() { sleeping = false; clearTimeout(idleTimer); idleTimer = setTimeout(function () { if (state === 'listo' && (!panelEl || panelEl.hidden)) { sleeping = true; applyPause(); } }, IDLE_MS); applyPause(); }
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
  // Con una ventana del POS abierta (cobro, ficha, compra) la burbuja se oculta: nunca tapa sus botones.
  function applyPause() {
    var busyNow = busyPos() && panelEl && panelEl.hidden, p = doc.hidden || busyNow || offscreen || (sleeping && state === 'listo') ? '1' : '0';
    chars().forEach(function (c) { if (c.dataset.paused !== p) c.dataset.paused = p; });
    if (rootEl && rootEl.dataset.paused !== p) rootEl.dataset.paused = p;
    if (rootEl) rootEl.style.visibility = busyNow ? 'hidden' : '';
    if (rootEl) { var show = allowedHere() && !(heroEl && pageId() === 'pageMenu'); rootEl.style.display = show ? '' : 'none'; // en Inicio la tarjeta hace de lanzador
      // Al entrar a Venta o Caja (o si deja de ser dueño) el panel se cierra: nunca queda sobre Cobrar.
      if (!show && panelEl && !panelEl.hidden && (!isAdmin() || pageId() === 'pagePOS' || pageId() === 'pageCaja')) { panelEl.hidden = true; rootEl.hidden = false; } }
  }

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
  function protoRole() { try { var r = root.localStorage.getItem('na_asistente_proto_role'); return r === 'empleado' || r === 'sinrol' ? r : null; } catch (_) { return null; } }
  function protoLevel() { try { return root.localStorage.getItem('na_asistente_proto_level') || ''; } catch (_) { return ''; } }
  // Para la puerta de ejecución: rol y nivel según el SERVIDOR (último ping), no el rol guardado del POS.
  function roles() {
    if (!access) return { role: 'unknown' };
    return { role: access.role, level: access.level, isOwner: function () { return access.role === 'owner'; } };
  }
  // Mismo pedido que NA_ROLES.api (endpoint, Bearer, sin cookies) pero con límite de tiempo propio del asistente.
  // Un timeout lanza un error (timeout=true); un error HTTP vuelve como { error, status }.
  async function post(path, body, headers, ms) {
    var c = creds(), url = path, h = Object.assign({ 'content-type': 'application/json' }, headers || {});
    var init = { method: 'POST', cache: 'no-store', body: JSON.stringify(body) };
    if (c) { url = c.endpoint.replace(/\/+$/, '') + path; h.authorization = 'Bearer ' + c.token; init.credentials = 'omit'; init.redirect = 'error'; }
    else if (protoRole()) { h['x-proto-role'] = protoRole(); if (protoLevel()) h['x-proto-level'] = protoLevel(); }
    init.headers = h;
    var r = await C.request(root.fetch.bind(root), url, init, ms || C.TIMEOUTS.chat);
    var d = r.data || {}; if (!r.ok) { d.error = d.error || 'HTTP_' + r.status; d.status = r.status; }
    return d;
  }
  // Confirmación: el MISMO token se reenvía hasta 3 veces si se corta la señal (mismo operation_id).
  var approvals = {}; // id de propuesta -> approval_id del dueño (ligado al operation_id de esa tarjeta)
  async function confirmRemote(p, review) {
    var clean = JSON.parse(JSON.stringify(p)); delete clean.confirm_token;
    var hdr = approvals[p.id] ? { 'x-owner-approval': approvals[p.id] } : null;
    var lastErr;
    // Cada intento se corta a los ~12 s; 2 intentos y después «Pulsa Confirmar otra vez» (mismo token y operation_id).
    for (var i = 0; i < (C.CONFIRM_ATTEMPTS || 2); i++) {
      try { var body = { token: p.confirm_token, proposal: clean }; if (review) body.review = review;
        var d = await post('/auth/assistant/confirm', body, hdr, C.TIMEOUTS.confirm); return d.ok ? d : { ok: false, error: d.error, rows: d.rows, retry_after_s: d.retry_after_s, message: typeof d.message === 'string' ? d.message.slice(0, 400) : null }; }
      catch (e) { lastErr = e; if (i === 0) await new Promise(function (r) { setTimeout(r, 600); }); }
    }
    throw lastErr || new Error('network');
  }

  // ---------- Funciones existentes del POS ----------
  // Cálculos EXISTENTES del POS que usan sus pantallas de reportes (el asistente no hace cuentas propias de dinero).
  function reportApi() {
    var V = root.NA_VALORIZACION, D = root.NA_CLIENTES_REPORTE_DEUDA, A = root.NA_REPORTE_ARQUEO, CC = root.NA_CLIENT_CREDIT_ACCOUNTS_V2, canon = root.NuevoAmanecerCanonical;
    var pending = function () { return canon && typeof canon.pendingSnapshot === 'function' ? canon.pendingSnapshot() : null; };
    var catKey = g('_naCategoryKey');
    return {
      valorizacion: V && V.calculate ? function (p) { return V.calculate(p, typeof catKey === 'function' ? { categoryKey: catKey } : {}); } : null,
      totalV: g('totalV'),
      deudaReport: D && D.buildReport && CC ? function () { return D.buildReport(g('clientes') || [], CC, pending(), 'saldo'); } : null,
      summarizeClient: CC && CC.summarizeClient, effectiveBalance: CC && CC.debtFilter && CC.debtFilter.effectiveBalance, pending: pending,
      outstanding: (function (f) { return typeof f === 'function' ? function (c) { return Math.max(0, Number(f(c)) || 0); } : null; })(g('_naCreditOutstanding')),
      // Mismo origen que «Reporte de arqueo»: servidor (/auth/cash-closes) y, si no hay, la copia local de CANON.
      cashCloses: A && A.buildReport ? async function (desde, hasta) {
        var opts = {}; if (desde) opts.desde = desde; if (hasta) opts.hasta = hasta;
        var range = A.buildReport([], opts).range;
        try { if (root.navigator.onLine !== false && root.NA_ROLES && typeof root.NA_ROLES.api === 'function') {
          var r = await root.NA_ROLES.api('/auth/cash-closes?desde=' + encodeURIComponent(range.desde) + '&hasta=' + encodeURIComponent(range.hasta));
          if (r && Array.isArray(r.cash_closes) && r.ready !== false) return { report: A.buildReport(r.cash_closes, range), fromServer: true }; } } catch (_) {}
        return { report: A.buildReport(canon && typeof canon.snapshot === 'function' ? canon.snapshot() : {}, range), fromServer: false };
      } : null
    };
  }
  function mark(i) { i.style.outline = '3px solid #16a34a'; try { i.focus({ preventScroll: true }); } catch (_) {} }
  function g(name) { try { return (0, eval)('typeof ' + name + '!=="undefined"?' + name + ':undefined'); } catch (_) { return undefined; } }
  var deps = {
    roles: roles, confirm: confirmRemote, online: function () { return root.navigator.onLine !== false; },
    productos: function () { return g('productos') || []; },
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
    // Ficha EXISTENTE del producto (editProd) con el campo prellenado. Guarda la persona con «Guardar» (product.update con PIN).
    openProductEditor: function (id, v) {
      var f = g('editProd'); if (typeof f !== 'function') return;
      f(id); var i = doc.getElementById(v.costo != null ? 'pCosto' : 'pPrecio'); if (!i) return;
      i.value = Number(v.costo != null ? v.costo : v.precio).toFixed(2); i.dispatchEvent(new Event('input', { bubbles: true })); mark(i);
    },
    // Ventana EXISTENTE «Registrar movimiento» (abrirMovInv). Guarda la persona (inventory.adjust con PIN).
    // Antes de pedir el PIN: ¿el POS puede abrir «Registrar movimiento» aquí? Devuelve el motivo o null.
    stockMoveReady: function () {
      if (typeof g('abrirMovInv') !== 'function') return 'Este aparato no tiene la pantalla «Registrar movimiento». Ábrela desde Inventario.';
      if (!doc.getElementById('mMovInv')) return 'La ventana «Registrar movimiento» no está cargada. Recarga la página e inténtalo otra vez.';
      return null;
    },
    openStockMove: function (id, tipo, cantidad, motivo) {
      var f = g('abrirMovInv'); if (typeof f !== 'function') return 'Este aparato no tiene la pantalla «Registrar movimiento». Ábrela desde Inventario.';
      f(id, tipo); var m = doc.getElementById('mMovInv'); if (!m) return 'La ventana «Registrar movimiento» no está cargada. Recarga la página e inténtalo otra vez.';
      var b = m.querySelector('.mov-type-btn[data-type="' + tipo + '"]'), st = g('setMovType'); if (b && typeof st === 'function') st(b, tipo);
      var q = doc.getElementById('mMovCant'); if (q) { q.value = cantidad; q.dispatchEvent(new Event('input', { bubbles: true })); mark(q); }
      var r = doc.getElementById('mMovMotivo'); if (r && motivo) { Array.prototype.forEach.call(r.options, function (o) { if (o.text === motivo || o.value === motivo) r.value = o.value; }); mark(r); }
      return m.classList.contains('open') ? true : 'El POS no abrió «Registrar movimiento» (puede que el producto no controle inventario). Revisa la ficha del producto.';
    },
    // Formulario EXISTENTE «Nuevo producto» (abrirModalProd). Guarda la persona (product.create).
    openNewProduct: function (p) {
      var f = g('abrirModalProd'); if (typeof f !== 'function') return false;
      f(); var m = doc.getElementById('mProd'); if (!m) return false;
      function set(id, v) { var i = doc.getElementById(id); if (!i || v == null || v === '') return; if (i.tagName === 'SELECT' && !Array.prototype.some.call(i.options, function (o) { return o.value === String(v); })) return; i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); mark(i); }
      set('pNombre', p.nombre); set('pPrecio', p.precio != null ? Number(p.precio).toFixed(2) : null); set('pCosto', p.costo != null ? Number(p.costo).toFixed(2) : null);
      set('pStock', p.stock_inicial); set('pStockMin', p.stock_minimo); set('pBarcode', p.codigo_barras); set('pCat', p.categoria); set('pUnidad', p.unidad);
      return m.classList.contains('open');
    },
    // Datos que el POS ya tiene en este aparato (para documentos locales, solo lectura).
    data: function () { return { productos: g('productos') || [], ventas: g('ventas') || [], clientes: g('clientes') || [], api: reportApi() }; },
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
    if (p.type === 'consulta') {
      var r = p.result || {};
      return '<h4>' + E(r.titulo || 'Consulta') + '<span class="pill ro">Solo lectura</span></h4>' + (r.error ? '<div class="warn">' + E(r.texto) + '</div>' :
        '<table class="q">' + (r.columnas && r.columnas.length ? '<tr>' + r.columnas.map(function (c, i) { return '<th' + (i ? ' class="r"' : '') + '>' + E(c) + '</th>'; }).join('') + '</tr>' : '') +
        (r.filas || []).map(function (f) { return '<tr>' + f.map(function (c, i) { return '<td' + (i ? ' class="r"' : '') + '>' + E(typeof c === 'number' && !Number.isInteger(c) ? c.toFixed(2) : c) + '</td>'; }).join('') + '</tr>'; }).join('') + '</table>' +
        (r.total != null && r.filas && r.filas.length < r.total ? '<div class="note">Mostrando ' + r.filas.length + ' de ' + E(r.total) + '.</div>' : '')) +
        '<div class="note">Datos leídos del servidor. No cambia nada.</div>';
    }
    if (p.type === 'documento') return '<h4>' + E(p.title) + '<span class="pill ro">Solo lectura</span></h4>' +
      '<div class="note">' + E([p.desde, p.hasta && p.hasta !== p.desde ? p.hasta : null].filter(Boolean).join(' a ') + (p.cliente ? ' · Cliente: ' + p.cliente : '')) + '</div>' +
      '<div class="warn doc">Documento interno. NO es comprobante SUNAT.</div>' +
      '<div class="res" aria-live="polite"></div><div class="acts"><button type="button" class="na-asst-ok" data-open>Abrir documento</button></div>';
    if (p.type === 'compra') rows = '<tr><th>Producto</th><th class="r">Costo actual</th><th class="r">Factura</th></tr>' + p.lineas.map(function (l, i) {
      var flag = l.revisar && l.revisar.length;
      var why = flag ? l.revisar.map(function (k) { return REVIEW_TEXT[k] || k; }).join(', ') : '';
      var diff = l.costo_actual != null && l.costo_unitario != null && Math.abs(l.costo_unitario - l.costo_actual) > Math.max(0.01, l.costo_actual * 0.01);
      return '<tr' + (flag ? ' class="flag" data-row="' + i + '"' : '') + '><td>' + E(l.cantidad) + ' × ' + E(l.nombre) + (l.product_id ? '' : ' <b class="nr">(no registrado)</b>') +
        (l.limite && l.limite.length ? '<div class="flag-t">Fuera del límite: ' + E(why) + '. Corrige la factura o quita la fila.</div><div class="flag-a"><button type="button" data-drop="' + i + '">Quitar fila</button></div>'
          : flag ? '<div class="flag-t">Revisa este dato: ' + E(why) + '</div><div class="flag-a"><button type="button" data-accept="' + i + '">Está bien</button><button type="button" data-drop="' + i + '">Quitar fila</button></div>' : '') +
        '</td><td class="r">' + (l.costo_actual != null ? soles(l.costo_actual) : '-') + '</td><td class="r' + (diff ? ' chg' : '') + '">' + (l.costo_unitario != null ? soles(l.costo_unitario) : '-') + '</td></tr>'; }).join('');
    if (p.type === 'precio') rows = '<tr><td>' + E(p.nombre) + '</td><td class="r">' + soles(p.precio_actual) + ' → <b>' + soles(p.precio_nuevo) + '</b></td></tr>';
    if (p.type === 'costo') rows = '<tr><td>' + E(p.nombre) + '<div class="note">Costo</div></td><td class="r">' + (p.costo_actual != null ? soles(p.costo_actual) : 'sin costo') + ' → <b>' + soles(p.costo_nuevo) + '</b></td></tr>';
    if (p.type === 'ajuste') rows = '<tr><td>' + E(p.nombre) + '<div class="note">' + E(p.motivo) + '</div></td><td class="r">' + (p.tipo === 'entrada' ? '+' : '−') + E(p.cantidad) + '</td></tr>' +
      (p.stock_actual != null ? '<tr><td>Stock</td><td class="r">' + E(p.stock_actual) + ' → <b>' + E(p.stock_despues) + '</b></td></tr>' : '');
    if (p.type === 'producto') rows = [['Nombre', E(p.nombre)], ['Precio', soles(p.precio)], ['Costo', p.costo != null ? soles(p.costo) : '-'], ['Stock inicial', p.stock_inicial != null ? E(p.stock_inicial) : '-'],
      ['Stock mínimo', p.stock_minimo != null ? E(p.stock_minimo) : '-'], ['Categoría', E(p.categoria || '-')], ['Código', E(p.codigo_barras || '-')]].map(function (r) { return '<tr><td>' + r[0] + '</td><td class="r">' + r[1] + '</td></tr>'; }).join('');
    var warn = '';
    if (p.type === 'compra' && p.fueraDeLimite) warn += '<div class="warn">' + p.fueraDeLimite + ' fila(s) fuera del límite: «Está bien» no las deja pasar. Corrige la factura o quítalas.</div>';
    if (p.type === 'compra' && p.omitidas && p.omitidas.length) warn += '<div class="warn">No se incluyó (no controla inventario): ' + p.omitidas.map(function (o) { return E(o.nombre); }).join(', ') + '.</div>';
    if (p.type === 'compra' && p.sinProducto) warn += '<div class="warn">' + p.sinProducto + ' línea(s) sin producto registrado: revísalas.</div>';
    if (p.type === 'precio' && p.cambioGrande) warn += '<div class="warn">Cambio grande (más de 50%). Revisa bien.</div>';
    if ((p.type === 'precio' || p.type === 'producto') && p.bajoCosto) warn += '<div class="warn">El precio queda por debajo del costo.</div>';
    if (p.type === 'ajuste' && p.quedaNegativo) warn += '<div class="warn">El stock quedaría negativo. Revisa la cantidad.</div>';
    if (p.type === 'ajuste' && p.grande) warn += '<div class="warn">Cantidad muy grande. Revisa bien.</div>';
    if (p.type === 'producto' && p.parecidos && p.parecidos.length) warn += '<div class="warn">Ya hay productos parecidos: ' + E(p.parecidos.join(', ')) + '.</div>';
    if (p.type === 'producto' && p.revisar) warn += '<div class="warn">Precio o costo fuera de lo normal. Revisa bien.</div>';
    var note = { compra: 'Al confirmar, se abre «Nueva compra» llena. El stock sube solo cuando pulses «Registrar compra». La compra no cambia el costo del producto: usa las tarjetas «Actualizar costo».',
      precio: 'Al confirmar, se abre la ficha del producto con el precio nuevo. Se aplica cuando pulses Guardar.', costo: 'Al confirmar, se abre la ficha del producto con el costo de la factura. Se aplica cuando pulses Guardar.' + (p.origen ? ' (' + p.origen + ')' : ''),
      ajuste: 'Al confirmar, se abre «Registrar movimiento» lleno. El stock cambia solo cuando pulses Guardar.', producto: 'Al confirmar, se abre «Nuevo producto» lleno. Se crea solo cuando pulses Guardar.' }[p.type];
    var head = p.type === 'compra' && (p.proveedor || p.documento) ? '<div class="note">' + E([p.proveedor, p.documento, p.fecha].filter(Boolean).join(' · ')) + '</div>' : '';
    return '<h4>' + E(p.title) + '<span class="pill">PIN del dueño</span></h4>' + head + '<table>' + rows + '</table>' + warn + '<div class="note">' + E(note) + '</div>' +
      '<div class="meta"><span>Vence en <b data-left>5:00</b></span><span>Se usa una sola vez</span></div>' +
      '<div class="na-asst-pin"><label>Escribe tu PIN de dueño</label><input type="password" inputmode="numeric" maxlength="8" autocomplete="off" aria-label="PIN del dueño"></div>' +
      '<div class="res" aria-live="polite"></div>' +
      '<div class="acts"><button type="button" class="na-asst-ok" data-ok>Confirmar</button><button type="button" class="na-asst-no" data-no>Cancelar</button>' +
      '<button type="button" class="na-asst-again" data-again hidden>Pedir de nuevo</button></div>';
  }
  var APPROVAL = { precio: 'product.update', costo: 'product.update', compra: 'inventory.adjust', ajuste: 'inventory.adjust', producto: 'product.create' };
  var REVIEW_TEXT = { cantidad: 'cantidad fuera de lo normal', costo: 'costo por unidad fuera de lo normal', total: 'total de la fila muy alto', costo_raro: 'costo muy distinto al de tu inventario' };
  function tokenData(p) { try { var b = String(p.confirm_token || '').split('.')[0].replace(/-/g, '+').replace(/_/g, '/'); return JSON.parse(atob(b)) || {}; } catch (_) { return {}; } }
  function tokenExp(p) { return tokenData(p).exp || 0; }
  function tokenOp(p) { var op = tokenData(p).op; return typeof op === 'string' ? op : null; }
  function addDenied(d) { var c = el('div', 'na-asst-card denied'); c.innerHTML = '<h4>No permitido</h4><div>' + C.esc(d.message) + '</div><div class="note">El asistente no puede hacerlo por ti. Pídeselo al dueño.</div>'; msgsEl.appendChild(c); scrollEnd(); }
  // PIN del dueño: va SOLO al servidor (/auth/owner-approval), nunca al modelo ni al historial.
  async function verifyOwnerPin(pin, p) {
    if (!/^\d{4,8}$/.test(pin)) return { ok: false, msg: 'El PIN debe tener de 4 a 8 dígitos.' };
    var op = tokenOp(p); if (!op) return { ok: false, msg: 'Esta tarjeta no se puede confirmar. Pídela otra vez.' };
    // La aprobación queda ligada al operation_id de ESTA tarjeta; el servidor la verifica y la gasta al confirmar.
    var d;
    try { d = await post('/auth/owner-approval', { pin: pin, action: APPROVAL[p.type], operation_id: op }, null, C.TIMEOUTS.approval); }
    catch (e) { return { ok: false, msg: e && e.timeout ? 'No hubo respuesta. Inténtalo otra vez.' : 'No se pudo conectar. Revisa internet e inténtalo otra vez.' }; }
    if (!d || !d.approval_id) {
      var e = String((d && d.error) || '');
      if (/locked|bloque|too_many/i.test(e)) return { ok: false, msg: 'Demasiados intentos. Espera unos minutos.' };
      if (/pin/i.test(e)) return { ok: false, msg: 'PIN incorrecto. Inténtalo otra vez.' };
      if (/owner_only|forbidden/i.test(e)) return { ok: false, msg: 'Solo el dueño puede aprobar esto.' };
      return { ok: false, msg: 'No se pudo verificar el PIN. Inténtalo otra vez.' };
    }
    approvals[p.id] = d.approval_id; return { ok: true };
  }
  function addCard(p, prompt) {
    var key = gate.add(p); if (!key) return;
    var c = el('div', 'na-asst-card', cardHtml(p)); c.dataset.type = p.type; c.dataset.st = 'pending'; msgsEl.appendChild(c);
    var res = c.querySelector('.res');
    var go = c.querySelector('[data-go]'); if (go) go.onclick = function () { gate.execute(key, { confirmed: true }).then(function () { closePanel(); }); };
    // Documento local (solo lectura): se puede abrir varias veces, sin servidor ni PIN.
    var op = c.querySelector('[data-open]'); if (op) op.onclick = function () { var perm = C.canExecute(roles(), p); if (!perm.ok) { c.querySelector('.res').textContent = perm.msg; return; } op.disabled = true; Promise.resolve(C.EXECUTORS.documento(p, deps)).then(function (r) { c.querySelector('.res').textContent = r.msg; }, function () { c.querySelector('.res').textContent = 'No se pudo armar el documento.'; }).then(function () { op.disabled = false; }); };
    var no = c.querySelector('[data-no]'); if (no) no.onclick = function () { gate.cancel(key); c.dataset.st = 'cancelled'; res.textContent = 'Cancelado. No se hizo nada.'; };
    var ok = c.querySelector('[data-ok]'), left = c.querySelector('[data-left]'), pinEl = c.querySelector('.na-asst-pin input');
    var exp = tokenExp(p), timer = null;
    // Filas «Revisa este dato»: Confirmar queda apagado hasta aceptar o quitar cada una (el servidor exige lo mismo).
    var decided = {};
    function pendingRows() { return Array.prototype.filter.call(c.querySelectorAll('tr.flag'), function (tr) { return !decided[tr.dataset.row]; }).length; }
    function review() { if (p.type !== 'compra') return null; var a = [], d = []; Object.keys(decided).forEach(function (k) { (decided[k] === 'drop' ? d : a).push(Number(k)); }); return { op: tokenOp(p), accept: a, drop: d }; }
    function syncOk() { if (!ok || c.dataset.st !== 'pending') return; var n = pendingRows(); ok.disabled = n > 0; ok.textContent = n > 0 ? 'Revisa ' + n + (n === 1 ? ' fila' : ' filas') : (c.dataset.btn || 'Confirmar'); }
    var again = c.querySelector('[data-again]'), pinBox = c.querySelector('.na-asst-pin');
    // Con una aprobación vigente para ESTA tarjeta (422/429/corte) se reenvía igual, sin volver a pedir el PIN.
    function syncPin() { if (pinBox) pinBox.hidden = !!approvals[p.id]; }
    // 422: el servidor dice qué filas faltan revisar; se marcan en rojo «Revisa este dato» (aunque el celular no las hubiera marcado).
    function markRows(idx, limit) {
      var trs = c.querySelectorAll('table tr');
      idx.forEach(function (i) {
        var tr = c.querySelector('tr[data-row="' + i + '"]') || trs[i + 1]; if (!tr) return;
        tr.classList.add('flag'); tr.dataset.row = String(i); tr.removeAttribute('data-decision'); delete decided[i];
        var td = tr.querySelector('td'); if (!td) return;
        var t = tr.querySelector('.flag-t'); if (!t) { t = el('div', 'flag-t'); td.appendChild(t); }
        t.textContent = limit ? 'Fuera del límite: quita la fila o corrige la factura' : 'Revisa este dato';
        var a = tr.querySelector('.flag-a'); if (!a) { a = el('div', 'flag-a'); td.appendChild(a); }
        a.innerHTML = (limit ? '' : '<button type="button" data-accept="' + i + '">Está bien</button>') + '<button type="button" data-drop="' + i + '">Quitar fila</button>';
      });
    }
    // «Pedir de nuevo»: deja esta tarjeta y pide una NUEVA (token, operation_id y PIN nuevos).
    if (again) again.onclick = function () {
      if (!prompt) { res.textContent = 'Escribe otra vez lo que necesitas.'; return; }
      gate.cancel(key); delete approvals[p.id]; c.dataset.st = 'cancelled';
      [ok, no, again].forEach(function (b) { if (b) b.disabled = true; }); if (ok) ok.textContent = 'Reemplazada';
      res.textContent = 'Pidiendo una tarjeta nueva…'; send(prompt);
    };
    c.addEventListener('click', function (e) {
      var b = e.target.closest('[data-accept],[data-drop]'); if (!b || c.dataset.st !== 'pending') return;
      var i = b.getAttribute('data-accept') != null ? b.getAttribute('data-accept') : b.getAttribute('data-drop'), tr = c.querySelector('tr[data-row="' + i + '"]');
      decided[i] = b.hasAttribute('data-drop') ? 'drop' : 'accept';
      if (tr) { tr.dataset.decision = decided[i]; var t = tr.querySelector('.flag-t'); if (t) t.textContent = decided[i] === 'drop' ? 'Fila quitada: no se agregará.' : 'Revisado: lo aceptaste.'; }
      syncOk();
    });
    function tick() {
      if (!left) return; var ms = exp - (Date.now() + clockOffset); if (!exp) { left.textContent = '-'; return; }
      if (ms <= 0 && ok && ok.textContent === 'Confirmando…') { left.textContent = '0:00'; return; } // en curso: el servidor decide (ya usada = mismo id)
      if (ms <= 0) { clearInterval(timer); if (c.dataset.st === 'pending') { gate.cancel(key); c.dataset.st = 'expired'; res.textContent = 'Esta propuesta venció. Pídela otra vez.'; if (ok) { ok.textContent = 'Vencida'; ok.disabled = true; } if (no) no.disabled = true; if (again) { again.hidden = false; again.disabled = false; } } left.textContent = '0:00'; return; }
      var sec = Math.ceil(ms / 1000); left.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    }
    syncOk();
    if (left && p.needsConfirm) { tick(); timer = setInterval(function () { if (c.dataset.st !== 'pending') { clearInterval(timer); return; } tick(); }, 1000); }
    if (ok) ok.onclick = async function () {
      if (c.dataset.st !== 'pending') return;
      ok.disabled = true; no.disabled = true; ok.textContent = 'Confirmando…'; setState('concentrado');
      if (again) again.disabled = true;
      // Antes del PIN: si el POS no puede abrir la pantalla, se dice el motivo real y no se gasta ni el PIN ni la tarjeta.
      var pre = C.precheck ? C.precheck(p, deps) : null;
      if (pre) { res.textContent = pre; no.disabled = false; ok.disabled = false; ok.textContent = c.dataset.btn || 'Confirmar'; if (again) { again.hidden = false; again.disabled = false; } c.dataset.fail = 'precheck'; syncOk(); setState('error', 2000); return; }
      if (pinEl && !approvals[p.id]) {
        var v = await verifyOwnerPin(pinEl.value.trim(), p); pinEl.value = '';
        if (!v.ok) { res.textContent = v.msg; no.disabled = false; ok.textContent = c.dataset.btn || 'Confirmar'; ok.disabled = false; if (again) again.disabled = false; syncOk(); setState('error', 2000); return; }
      }
      syncPin();
      gate.execute(key, { confirmed: true, review: review() }).then(function (r) {
        res.textContent = r.msg; c.dataset.st = gate.state(key) || 'pending';
        if (c.dataset.st !== 'pending') ok.textContent = { done: 'Hecho', denied: 'No disponible', cancelled: 'Cancelada', expired: 'Vencida' }[c.dataset.st] || 'Confirmar';
        if (r.ok) { delete approvals[p.id]; if (again) again.hidden = true; setState('feliz', 2600); setTimeout(closePanel, 1400); return; }
        setState('error', 2600);
        var f = C.confirmFailureView(r) || { kind: 'other', rows: [], button: 'Confirmar', keepApproval: true, again: true };
        c.dataset.fail = f.kind;
        if (!f.keepApproval) delete approvals[p.id];
        if (f.kind === 'review' || f.kind === 'limit') markRows(f.rows, f.kind === 'limit');
        if (again) { again.hidden = !f.again; again.disabled = false; }
        if (c.dataset.st === 'pending') { c.dataset.btn = f.button; ok.disabled = false; no.disabled = false; ok.textContent = f.button; syncOk(); }
        syncPin(); if (f.kind === 'pin' && pinEl) { try { pinEl.focus(); } catch (_) {} }
      });
    };
    scrollEnd();
  }
  var ERRORS = { forbidden_document: 'Ese documento es solo para el dueño. Puedes pedir la lista de precios o la lista de pedido.', rate_limited: 'Vas muy rápido. Espera un minuto.', daily_limit: 'Llegaste al límite de hoy en este aparato.', monthly_cap: 'Se alcanzó el tope del mes del asistente. Avisa al dueño.',
    image_too_large: 'La foto es muy grande.', bad_image: 'No pude leer esa foto.', upstream_timeout: 'El asistente tardó mucho. Inténtalo otra vez.', upstream_error: 'El asistente no respondió. Inténtalo otra vez.',
    upstream_busy: 'El asistente está ocupado. Inténtalo en un momento.', not_found: 'El asistente no está activado en este servidor.', forbidden_role: 'No tienes permiso para esto.', admin_only: 'El asistente es solo para el dueño.', assistant_off: 'El dueño no activó el asistente en este aparato.', unauthorized: 'Este aparato no tiene sesión.' };
  async function send(text, image) {
    if (busy) return;
    if (root.navigator.onLine === false) { offline(true); addMsg('sys', 'Asistente no disponible sin internet'); setState('offline'); return; }
    text = String(text || '').trim(); if (!text && !image) return;
    var chips = panelEl.querySelector('.na-asst-chips'); if (chips) chips.hidden = true; // menos desplazamiento tras el primer mensaje
    addMsg('u', text || 'Foto', image); inputEl.value = ''; busy = true; sendBtn.disabled = true; photoBtn.disabled = true; setState(image ? 'concentrado' : 'pensando');
    var thinking = addMsg('a', image ? 'Concentrado… leyendo la foto' : 'Pensando…'); thinking.classList.add('na-asst-thinking');
    var screen = (doc.querySelector('.page.active') || {}).id || null;
    var body = { text: C.redactText(text), history: history.slice(-8), context: C.buildContext(deps.productos(), roles().role, screen, text) };
    if (image) body.image = image;
    try {
      var d = await post('/auth/assistant/chat', body, null, C.TIMEOUTS.chat); thinking.remove();
      if (typeof d.server_now === 'number') clockOffset = d.server_now - Date.now(); // la cuenta regresiva usa la hora del servidor
      if (!d.ok) { addMsg('a', ERRORS[d.error] || 'No se pudo completar. Inténtalo otra vez.'); setState('error', 2600); if (d.error === 'admin_only' || d.error === 'assistant_off') { access = null; adminOff = true; renderHero(); setTimeout(function () { closePanel(); }, 1500); } return; }
      history.push({ role: 'user', content: body.text || 'Foto' }, { role: 'assistant', content: d.reply });
      addMsg('a', d.reply); if (d.mode === 'mock') { var m = el('div', 'na-asst-mode'); m.textContent = 'Modo demostración (sin clave de DeepSeek)'; msgsEl.appendChild(m); }
      (d.denied || []).forEach(addDenied);
      if (d.proposals && d.proposals.some(function (x) { return x.type === 'consulta'; }) && d.reply) { /* el texto ya resume los números */ }
      (d.proposals || []).forEach(function (x) { addCard(x, text); });
      setState('hablando', Math.min(4000, 900 + d.reply.length * 25));
    } catch (e) { thinking.remove(); addMsg('a', root.navigator.onLine === false ? 'Asistente no disponible sin internet' : e && e.timeout ? 'El asistente tardó mucho. Inténtalo otra vez.' : 'No se pudo conectar. Revisa internet.'); setState('error', 2600); }
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
  function offline(on) { offEl.hidden = !on; sendBtn.disabled = on || busy; photoBtn.disabled = on || busy; if (on) setState('offline'); else if (state === 'offline') setState('listo'); }
  function openPanel() {
    panelEl.hidden = false; rootEl.hidden = true; place(); applyPause();
    if (!msgsEl.children.length) addMsg('a', isOwnerAccess() ? '¡Hola! Soy Burbuja, tu ayudante de gestión. Te digo qué falta reponer y cómo van las ventas, preparo compras y ajustes de stock, cambios de precio y costo, productos nuevos y documentos. Nada se guarda sin tu PIN.'
      : '¡Hola! Soy Burbuja. Te digo el stock y qué falta reponer' + (access && access.level === 'consultas_documentos' ? ', y armo la lista de precios o de pedido' : '') + '. Si propongo un cambio, lo aprueba el dueño con su PIN.');
    var off = root.navigator.onLine === false; offline(off); if (off) setState('offline'); else setState('feliz', 1300); measureFrames();
    setTimeout(function () { try { inputEl.focus({ preventScroll: true }); } catch (_) {} }, 50);
  }
  function closePanel() { panelEl.hidden = true; rootEl.hidden = false; place(); applyPause(); }

  function chipsHtml() {
    if (isOwnerAccess()) return '<button type="button" data-q="¿Qué me falta reponer?">¿Qué falta reponer?</button><button type="button" data-q="¿Cuánto vendimos hoy?">Ventas de hoy</button><button type="button" data-photo>Leer factura (foto)</button><button type="button" data-q="Arma el documento de inventario valorizado">Inventario valorizado</button>';
    return '<button type="button" data-q="¿Qué me falta reponer?">¿Qué falta reponer?</button><button type="button" data-q="¿Cuánto stock hay de paracetamol?">Stock de un producto</button>' +
      (access && access.level === 'consultas_documentos' ? '<button type="button" data-q="Arma la lista de precios">Lista de precios</button><button type="button" data-q="Arma la lista de pedido para el proveedor">Lista de pedido</button>' : '');
  }

  // ---------- Permiso: lo decide el servidor ----------
  // Ping sin costo (no llama a DeepSeek ni gasta cupo). Se repite al volver internet, al volver a la app y al entrar a Inicio.
  var pinging = null;
  function refreshAccess() {
    if (pinging) return pinging;
    if (root.navigator.onLine === false) { renderHero(); return Promise.resolve(access); }
    pinging = post('/auth/assistant/chat', { ping: true }, null, 8000).then(function (d) {
      if (d && d.ok) { access = { role: d.role === 'owner' ? 'owner' : 'empleado', level: d.level }; adminOff = false; }
      else if (d && (d.status === 403 || d.status === 401 || d.status === 404)) { access = null; }
      noRole = !!(d && d.reason === 'sin_rol'); bootstrapOn = !!(d && d.owner_bootstrap);
      try { if (d && d.ok) root.localStorage.setItem('na_asistente_acc', d.role === 'owner' ? 'owner' : 'on'); else if (d && (d.status === 403 || d.status === 401 || d.status === 404)) root.localStorage.removeItem('na_asistente_acc'); } catch (_) {}
      return access;
    }, function () { return access; }).then(function (a) {
      pinging = null;
      if (isAdmin()) { if (!doc.querySelector('.na-asst-root')) mount(); else syncPanelForAccess(); }
      else if (panelEl && !panelEl.hidden) closePanel();
      renderHero(); if (rootEl) applyPause(); decorateConfig(); decorateRegister();
      return a;
    });
    return pinging;
  }
  // Si el nivel cambió con la app abierta: saludo y chips nuevos.
  var shownFor = null;
  function syncPanelForAccess() {
    var key = access ? access.role + ':' + access.level : '';
    if (!panelEl || shownFor === key) return; shownFor = key;
    var ch = panelEl.querySelector('.na-asst-chips'); if (ch) ch.innerHTML = chipsHtml();
    var sm = panelEl.querySelector('.na-asst-head-t small'); if (sm) sm.textContent = isOwnerAccess() ? 'Gestión · dueño · prueba aislada' : 'Consultas · empleado · prueba aislada';
  }

  // ---------- Tarjeta en Inicio ----------
  // Solo se dibuja cuando el SERVIDOR confirmó el permiso. A un empleado sin permiso no se le dibuja nada (ni espacio).
  // Va al FINAL de Inicio: no empuja ni mueve lo que ya está. Sin internet: «Asistente no disponible sin internet»
  // solo si este aparato ya fue confirmado como dueño o el rol guardado del POS es dueño; el resto de Inicio sigue igual.
  var heroEl = null, noRole = false, bootstrapOn = false;
  // Último rol que confirmó el servidor (lo guarda el cargador): solo 'owner' muestra la tarjeta sin internet.
  function cachedOwner() { try { return root.localStorage.getItem('na_asistente_acc') === 'owner'; } catch (_) { return false; } }
  function renderHero() {
    var menu = doc.getElementById('pageMenu'); if (!menu) return;
    var off = root.navigator.onLine === false;
    // Solo el dueño tiene tarjeta en Inicio (la tarjeta reemplaza a la burbuja). El empleado con nivel encendido ve solo la burbuja con sus atajos.
    var mode = isOwnerAccess() ? (off ? 'offline' : 'owner') : (off && cachedOwner() && !adminOff ? 'offline' : null);
    if (!heroEl) heroEl = doc.getElementById('naAsstHero'); // hueco que reservó el cargador (último ping: dueño)
    if (!mode) { if (heroEl) { heroEl.remove(); heroEl = null; } doc.documentElement.classList.remove('na-asst-owner'); return; }
    if (!heroEl) { // sin hueco reservado (primera vez de este dueño en este aparato): se agrega arriba una sola vez; desde el próximo arranque ya está reservado
      var S = root.NA_ASISTENTE_SLOT; if (S) S.reserve(); heroEl = doc.getElementById('naAsstHero');
      if (!heroEl) { heroEl = el('section', 'na-asst-hero'); heroEl.id = 'naAsstHero'; heroEl.setAttribute('aria-label', 'Asistente'); var host = menu.querySelector('.main-scroll') || menu; host.insertBefore(heroEl, host.querySelector(':scope > .quick-stats') || host.firstChild); } }
    if (heroEl.dataset.mode === mode && heroEl.dataset.lvl === String(access && access.level)) return;
    heroEl.dataset.mode = mode; heroEl.dataset.lvl = String(access && access.level);
    // Estilo de las maquetas v2 de Bot 4: píldora, título, subtítulo, la MISMA burbuja CSS (con brillo y órbita), campo con onda de voz y 3 chips.
    // En Inicio esta tarjeta reemplaza a la burbuja flotante (nunca salen las dos). Solo transform/opacity; se pausa con la burbuja.
    var SPARK = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M8 0l1.8 6.2L16 8l-6.2 1.8L8 16l-1.8-6.2L0 8l6.2-1.8z"/></svg>';
    var WAVE = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M3 12h1M7 9v6M11 6v12M15 9v6M19 11v2"/></svg>';
    var SEND = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path stroke="currentColor" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 6l6 6-6 6"/></svg>';
    var DOC = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M7 3h7l4 4v14H7zM10 12h5M10 16h5"/></svg>';
    var BOX = '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10"/></svg>';
    var emp = mode === 'emp', docs = emp && access.level === 'consultas_documentos';
    var chips = mode === 'owner' ? [['Qué me falta reponer', '¿Qué me falta reponer?'], ['Leer factura', null, 'photo'], ['Inventario valorizado', 'Imprime el inventario valorizado']]
      : docs ? [['Qué falta reponer', '¿Qué falta reponer?'], ['Lista de precios', 'Imprime la lista de precios'], ['Lista de pedido', 'Arma la lista de pedido para el proveedor']]
      : [['Qué falta reponer', '¿Qué falta reponer?'], ['Cómo se hace algo', '¿Cómo registro una compra?']];
    var vis = emp ? '' : '<div class="na-asst-hero-v" aria-hidden="true"><span class="h-glow"></span><span class="h-ring back"></span><span class="h-bb">' + charHtml() + '</span><span class="h-ring front"></span>' +
      '<span class="h-card c1">' + BOX + '</span><span class="h-card c2">' + DOC + '</span></div>';
    var txt = '<div class="na-asst-hero-t"><span class="h-pill">' + SPARK + (emp ? 'Asistente' : 'Asistente inteligente') + '</span><h2>' + (emp ? 'Asistente' : 'Asistente Nuevo Amanecer') + '</h2><p>' +
      (emp ? (docs ? 'Puedo ayudarte con stock, precios de venta y listas para imprimir.' : 'Puedo ayudarte con stock y precios de venta.') : 'Puedo ayudarte con stock, compras, precios y documentos.') + '</p></div>';
    if (mode === 'offline') heroEl.innerHTML = txt + vis + '<p class="h-off" role="status">Asistente no disponible sin internet. El resto de Inicio funciona normal.</p>';
    else heroEl.innerHTML = txt + vis + '<form class="h-in" autocomplete="off"><span class="h-wave">' + WAVE + '</span><input type="text" enterkeyhint="send" maxlength="500" aria-label="Pregúntale al asistente" placeholder="¿Qué deseas hacer hoy?"><button type="submit" class="h-send" aria-label="Enviar">' + SEND + '</button></form>' +
      '<div class="h-chips">' + chips.map(function (c) { return '<button type="button" class="h-chip"' + (c[1] ? ' data-hero-q="' + C.esc(c[1]) + '"' : '') + (c[2] ? ' data-hero-photo="1"' : '') + '>' + C.esc(c[0]) + '</button>'; }).join('') + '</div>';
    heroEl.classList.toggle('emp', emp); heroEl.classList.toggle('off', mode === 'offline');
    if (!emp) { var ch = heroEl.querySelector('.na-asst-char'); if (ch) { ch.dataset.state = state; ch.dataset.paused = rootEl ? rootEl.dataset.paused || '0' : '0'; } }
    var form = heroEl.querySelector('.h-in');
    if (form) form.onsubmit = function (e) { e.preventDefault(); var inp = form.querySelector('input'), q = inp.value.trim(); if (!q || !isAdmin() || !panelEl) return; inp.value = ''; openPanel(); send(q); };
    heroEl.onclick = function (e) { var b = e.target.closest('.h-chip'); if (!b || !isAdmin() || !panelEl) return; openPanel(); if (b.dataset.heroQ) send(b.dataset.heroQ); else if (b.dataset.heroPhoto && fileEl) fileEl.click(); };
  }

  // ---------- Configuración > Aparatos: nivel del asistente por aparato de empleado ----------
  // Se agrega DEBAJO de la lista de aparatos que ya existe (no se toca config-g.js). Guarda solo (sin botón Guardar),
  // pidiendo el PIN del dueño en la ventana de PIN del POS. El servidor exige aparato dueño + PIN y lo anota si hay bitácora.
  var LEVELS = [['off', 'Apagado'], ['consultas', 'Solo consultas'], ['consultas_documentos', 'Consultas y documentos']];
  function decorateConfig() {
    if (!isOwnerAccess() || root.navigator.onLine === false) return;
    // Puede haber dos pantallas de Configuración (v9 y la anterior): se decora cada lista visible una sola vez.
    doc.querySelectorAll('#naDevList').forEach(function (list) { var host = list.parentElement; if (host && !host.querySelector('.na-asst-acc')) decorateOne(host); });
  }
  function decorateOne(host) {
    var box = el('div', 'na-asst-acc'); box.innerHTML = '<h4>Asistente en aparatos de empleado</h4><p class="na-asst-acc-n">Apagado por defecto. Al cambiar se pide tu PIN y se guarda solo. Cualquier cambio de stock, precio o compra que proponga el asistente igual necesita tu PIN.</p><div class="na-asst-acc-l">Cargando…</div>';
    host.appendChild(box);
    decorateOwners(host, box);
    get(ACCESS_PATH).then(function (d) { paintAccess(box, d); }, function () { box.querySelector('.na-asst-acc-l').textContent = 'No se pudo cargar. Revisa internet.'; });
  }
  var ACCESS_PATH = '/auth/assistant/employee-access';

  // ---------- Aparatos de dueño y «Pendiente de aprobar» (maquetas v2). Solo si el servidor tiene ASSISTANT_OWNER_BOOTSTRAP=1;
  // si la ruta responde 404 no se muestra nada. Aprobar, rechazar y quitar piden PIN -> aprobación estricta 'assistant.owner_device'.
  var OWNER_DEV_PATH = '/auth/assistant/owner-device';
  function newOp(prefix) { return prefix + '-' + (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)); }
  function pinMsg(e) { e = String(e || ''); return /locked/.test(e) ? 'Demasiados intentos. Espera 15 min.' : /pin/.test(e) ? 'PIN incorrecto.' : ''; }
  // Pide el PIN (ventana de PIN del POS; en el prototipo local, prompt), saca una aprobación de UN uso para esta operación y llama run(op, approvalId).
  function withApproval(title, action, run) {
    var save = async function (pin) {
      var op = newOp('ODV'), apr = await post('/auth/owner-approval', { pin: pin, action: action, operation_id: op }, null, 15000);
      if (!apr || !apr.approval_id) { var ea = String(apr && apr.error || ''); return { msg: pinMsg(ea) || 'No se pudo verificar el PIN.', stop: !/pin_invalid/.test(ea) }; }
      var r = await run(op, apr.approval_id); return r && r.ok ? { ok: true } : { msg: (r && r.msg) || 'No se pudo guardar.', stop: true };
    };
    var R = root.NA_ROLES;
    if (R && typeof R.askPin === 'function' && creds()) return R.askPin(title, 'Escribe tu PIN de dueño.', save);
    var pin = root.prompt ? root.prompt(title + ' — PIN del dueño') : ''; if (!pin) return Promise.resolve(false);
    return save(pin).then(function (r) { return r.ok ? true : (r.msg || false); });
  }
  var PHONE_SVG = '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="7" y="2.5" width="10" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M11 18h2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  var TABLET_SVG = '<svg viewBox="0 0 24 24" width="20" height="20"><rect x="3" y="5" width="18" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  function devIcon(label) { return /tablet|caja|pc|laptop/i.test(label || '') ? TABLET_SVG : PHONE_SVG; }
  function decorateOwners(host, before) {
    var box = el('div', 'na-asst-own'); box.hidden = true; host.insertBefore(box, before);
    var paint = function () {
      get(OWNER_DEV_PATH).then(function (d) {
        if (!d || !d.owners) { box.hidden = true; return; }
        box.hidden = false;
        var own = d.owners.map(function (o) {
          return '<div class="na-asst-own-r" data-dev="' + C.esc(o.device_id) + '"><span class="ic" aria-hidden="true">' + devIcon(o.label) + '</span><div><strong>' + C.esc(o.label || 'Aparato de dueño') +
            (o.this_device ? ' <em>Este teléfono</em>' : '') + '</strong><small class="st" role="status">' + (o.last_seen_at ? 'Último uso: ' + C.esc(String(o.last_seen_at).slice(0, 16).replace('T', ' ')) : '') + '</small></div>' +
            '<button type="button" class="na-asst-quitar" data-quitar="1">Quitar</button></div>'; }).join('');
        var pend = (d.pending || []).map(function (p) {
          return '<div class="na-asst-own-r pend" data-dev="' + C.esc(p.device_id) + '"><span class="ic" aria-hidden="true">' + PHONE_SVG + '</span><div><strong>' + C.esc(p.label || 'Teléfono nuevo') + '</strong><small class="st" role="status">Pidió ser dueño: ' + C.esc(String(p.requested_at || '').slice(0, 16).replace('T', ' ')) + '</small></div></div>' +
            '<div class="na-asst-own-a" data-dev="' + C.esc(p.device_id) + '"><button type="button" class="na-asst-ok" data-decision="approve">Aprobar</button><button type="button" class="na-asst-no" data-decision="reject">Rechazar</button></div>'; }).join('');
        box.innerHTML = '<h4>Aparatos de dueño (' + d.owners.length + ')</h4>' + own +
          '<p class="na-asst-own-w">Un teléfono nuevo de dueño se aprueba solo desde un teléfono de dueño que ya esté en esta lista.</p>' +
          (pend ? '<h4>Pendiente de aprobar (' + d.pending.length + ')</h4>' + pend : '');
      }, function () { box.hidden = true; });
    };
    box.onclick = function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var row = b.closest('[data-dev]'), dev = row && row.dataset.dev; if (!dev) return;
      var stEl = (b.closest('.na-asst-own-a') ? b.closest('.na-asst-own-a').previousElementSibling : row).querySelector('.st');
      if (b.dataset.quitar) {
        // Aviso antes de quitar cualquier aparato dueño. El servidor nunca deja quitar el último (409 last_owner).
        var only = box.querySelectorAll('[data-quitar]').length <= 1;
        if (only) { stEl.textContent = 'Es el único aparato dueño. Registra otro antes de quitarlo.'; return; }
        if (root.confirm && !root.confirm('¿Quitar este aparato como dueño? Deja de ver el asistente de gestión y de aprobar cambios. Puedes volver a registrarlo después.')) return;
        withApproval('Quitar aparato de dueño', 'assistant.owner_device', async function (op, apr) {
          var r = await post(OWNER_DEV_PATH + '/revoke', { device_id: dev, operation_id: op }, { 'x-owner-approval': apr }, 15000);
          if (r && r.ok) { paint(); return { ok: true }; }
          return { msg: r && (r.code === 'last_owner' || r.error === 'last_owner') ? 'Es el único aparato dueño. Registra otro antes de quitarlo.' : 'No se pudo quitar.' };
        }).then(function (ok) { if (ok !== true) stEl.textContent = typeof ok === 'string' ? ok : 'Sin cambios.'; });
        return;
      }
      var dec = b.dataset.decision; if (!dec) return;
      withApproval(dec === 'approve' ? 'Aprobar teléfono de dueño' : 'Rechazar teléfono', 'assistant.owner_device', async function (op, apr) {
        var r = await post(OWNER_DEV_PATH + '/approve', { device_id: dev, operation_id: op, decision: dec }, { 'x-owner-approval': apr }, 15000);
        if (r && r.ok) { paint(); return { ok: true }; } return { msg: 'No se pudo guardar.' };
      }).then(function (ok) { if (ok !== true) stEl.textContent = typeof ok === 'string' ? ok : 'Sin cambios.'; });
    };
    paint();
  }

  // ---------- «Registrar este teléfono como dueño»: solo en un aparato SIN rol (el POS lo trata como dueño pero el asistente no),
  // nunca automático: botón + PIN. Si ya hay dueño queda «esperando aprobación». El servidor decide todo (bandera, 0 dueños, límite de PIN).
  function decorateRegister() {
    if (!bootstrapOn || isOwnerAccess() || root.navigator.onLine === false) return;
    // Teléfono de empleado (con el asistente encendido; uno en Apagado no baja este código): aviso fijo, sin botón ni PIN.
    if (access && access.role === 'empleado') {
      doc.querySelectorAll('#naDevList').forEach(function (list) {
        var host = list.parentElement; if (!host || host.querySelector('.na-asst-reg')) return;
        var box = el('div', 'na-asst-reg'); box.dataset.state = 'emp';
        box.innerHTML = '<h4>Este teléfono</h4><p class="st" role="status">Este teléfono ya es de empleado y no puede pasar a dueño así.</p><p>Si de verdad debe ser del dueño, el dueño lo cambia desde su teléfono en Usuarios y Aparatos.</p>';
        host.insertBefore(box, host.firstChild);
      });
      return;
    }
    if (!noRole) return;
    doc.querySelectorAll('#naDevList').forEach(function (list) {
      var host = list.parentElement; if (!host || host.querySelector('.na-asst-reg')) return;
      var box = el('div', 'na-asst-reg');
      box.innerHTML = '<h4>Registrar este teléfono como dueño</h4><p>Hazlo solo en el teléfono del dueño. Escribe tu PIN de dueño. El PIN no se guarda en el teléfono.</p>' +
        '<label>Escribe tu PIN de dueño<input type="password" inputmode="numeric" autocomplete="off" maxlength="8"></label><p class="st" role="status"></p>' +
        '<button type="button" class="na-asst-ok">Registrar este teléfono como dueño</button>' +
        '<p class="na-asst-own-w">Si ya hay un teléfono de dueño, este quedará esperando hasta que lo apruebes desde ese teléfono.</p>';
      host.insertBefore(box, host.firstChild);
      var inp = box.querySelector('input'), btn = box.querySelector('button'), st = box.querySelector('.st');
      btn.onclick = async function () {
        var pin = inp.value.trim(); inp.value = ''; if (!pin) { st.textContent = 'Escribe tu PIN de dueño.'; return; }
        btn.disabled = true; var r = await post(OWNER_DEV_PATH + '/register', { pin: pin }, null, 15000);
        if (r && r.ok) { st.textContent = 'Listo: este teléfono es de dueño.'; box.dataset.state = 'ok'; refreshAccess(); return; }
        if (r && r.pending) { st.textContent = 'Esperando aprobación desde el teléfono del dueño.'; box.dataset.state = 'pend'; return; }
        var e = String(r && r.error || '');
        if (/locked|too_many/.test(e) || (r && r.locked_until)) { st.textContent = 'Demasiados intentos. Espera 15 min.'; inp.disabled = true; inp.placeholder = 'Bloqueado'; box.dataset.state = 'lock'; return; }
        if (/employee/.test(e)) { st.textContent = 'Este teléfono ya es de empleado y no puede pasar a dueño así.'; box.dataset.state = 'emp'; return; }
        btn.disabled = false; st.textContent = /pin/.test(e) ? 'PIN incorrecto.' + (r.attempts_left != null ? ' Te quedan ' + r.attempts_left + ' intentos.' : '') : r && r.error === 'not_found' ? 'Esta opción todavía no está activa en el servidor.' : 'No se pudo registrar.';
      };
    });
  }

  function paintAccess(box, d) {
    var l = box.querySelector('.na-asst-acc-l');
    if (!d || !d.devices) { l.textContent = (d && d.error === 'admin_only') ? 'Solo el aparato del dueño puede cambiar esto.' : 'No se pudo cargar.'; return; }
    if (!d.devices.length) { l.textContent = 'No hay aparatos de empleado vinculados.'; return; }
    l.innerHTML = d.devices.map(function (x, i) {
      return '<div class="na-asst-acc-r" data-dev="' + C.esc(x.device_id) + '" data-cur="' + C.esc(x.level) + '"><div><strong>' + C.esc(x.label || 'Aparato de empleado') + '</strong><small class="st" role="status"></small></div>' +
        '<div class="na-asst-seg" role="radiogroup" aria-label="Asistente en ' + C.esc(x.label || 'aparato') + '">' + LEVELS.map(function (L) {
          return '<label><input type="radio" name="naAsstLvl' + i + '" value="' + L[0] + '"' + (L[0] === x.level ? ' checked' : '') + '><span>' + L[1] + '</span></label>'; }).join('') + '</div></div>';
    }).join('');
    l.onchange = function (e) {
      var inp = e.target; if (!inp || inp.type !== 'radio') return;
      var row = inp.closest('.na-asst-acc-r'), st = row.querySelector('.st'), prev = row.dataset.cur, lvl = inp.value;
      function revert(msg) { var r = row.querySelector('input[value="' + prev + '"]'); if (r) r.checked = true; st.textContent = msg || ''; }
      var R = root.NA_ROLES;
      // PIN del dueño -> aprobación 'assistant.employee_access' ligada a ESTE cambio (operation_id) -> el servidor la gasta una vez.
      var save = async function (pin) {
        var op = 'ACC-' + (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
        var apr = await post('/auth/owner-approval', { pin: pin, action: 'assistant.employee_access', operation_id: op }, null, 15000);
        if (!apr || !apr.approval_id) { var ea = String(apr && apr.error || ''); return { msg: /locked/.test(ea) ? 'Demasiados intentos. Espera unos minutos.' : /pin/.test(ea) ? 'PIN incorrecto.' : 'No se pudo verificar el PIN.', stop: !/pin_invalid/.test(ea) }; }
        var res = await post(ACCESS_PATH, { device_id: row.dataset.dev, level: lvl, operation_id: op }, { 'x-owner-approval': apr.approval_id }, 15000);
        if (res && res.ok) { row.dataset.cur = lvl; st.textContent = 'Guardado' + (res.logged ? '' : ' (sin bitácora en este servidor)'); return { ok: true }; }
        var e2 = String(res && res.error || '');
        return { msg: /locked/.test(e2) ? 'Demasiados intentos. Espera unos minutos.' : /pin/.test(e2) ? 'PIN incorrecto.' : 'No se pudo guardar.', stop: !/pin_invalid/.test(e2) };
      };
      if (R && typeof R.askPin === 'function' && creds()) {
        R.askPin('Asistente: ' + LEVELS.filter(function (L) { return L[0] === lvl; })[0][1], 'Escribe tu PIN de dueño.', save).then(function (ok) { if (!ok) revert('Sin cambios.'); });
      } else {
        // Prototipo local sin sesión: PIN en una ventana simple del navegador.
        var pin = root.prompt ? root.prompt('PIN del dueño para cambiar el asistente') : '';
        if (!pin) { revert('Sin cambios.'); return; }
        save(pin).then(function (r) { if (!r.ok) revert(r.msg); });
      }
    };
  }
  async function get(path) {
    var c = creds(), url = path, h = {};
    if (c) { url = c.endpoint.replace(/\/+$/, '') + path; h.authorization = 'Bearer ' + c.token; }
    else if (protoRole()) h['x-proto-role'] = protoRole();
    var r = await C.request(root.fetch.bind(root), url, c ? { method: 'GET', headers: h, cache: 'no-store', credentials: 'omit', redirect: 'error' } : { method: 'GET', headers: h, cache: 'no-store' }, 10000);
    var d = r.data || {}; if (!r.ok) d.error = d.error || 'HTTP_' + r.status; return d;
  }

  function mount() {
    if (doc.querySelector('.na-asst-root')) return; // se construye una sola vez
    // Sin permiso del servidor no se arma nada (ni burbuja ni panel).
    if (!isAdmin()) return;
    rootEl = el('div', 'na-asst-root'); rootEl.dataset.state = 'listo';
    rootEl.innerHTML = '<span class="na-asst-tag" aria-hidden="true"></span><button type="button" class="na-asst-bubble" aria-label="Abrir asistente Burbuja">' + charHtml() + '</button>';
    tagEl = rootEl.querySelector('.na-asst-tag');
    panelEl = el('section', 'na-asst-panel'); panelEl.hidden = true; panelEl.setAttribute('role', 'dialog'); panelEl.setAttribute('aria-label', 'Asistente Burbuja');
    panelEl.innerHTML = '<div class="na-asst-head">' + charHtml() + '<div class="na-asst-head-t"><b>Burbuja</b><small>' + (isOwnerAccess() ? 'Gestión · dueño · prueba aislada' : 'Consultas · empleado · prueba aislada') + '</small></div><button type="button" class="na-asst-x" aria-label="Cerrar asistente">✕</button></div>' +
      '<div class="na-asst-offline" hidden>Asistente no disponible sin internet</div><div class="na-asst-msgs" aria-live="polite"></div>' +
      '<div class="na-asst-chips">' + chipsHtml() + '</div>' +
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
    root.addEventListener('online', function () { offline(false); });
    root.addEventListener('offline', function () { offline(true); });
    doc.addEventListener('visibilitychange', function () { if (doc.hidden) applyPause(); else wake(); });
    shownFor = access ? access.role + ':' + access.level : '';
    rootEl.addEventListener('pointerdown', wake, { passive: true }); panelEl.addEventListener('pointerdown', wake, { passive: true });
    try { new IntersectionObserver(function (es) { offscreen = !es[0].isIntersecting; applyPause(); }).observe(rootEl.querySelector('.na-asst-bubble')); } catch (_) {}
    root.addEventListener('resize', place);
    setInterval(function () { if (doc.hidden || sleeping) return; place(); applyPause(); }, 1000); // quieta: el MutationObserver y los toques recolocan
    // Recolocar enseguida al cambiar de pantalla o abrir/cerrar ventanas (sin esperar el segundo).
    var raf = 0; function soon() { if (raf) return; raf = root.requestAnimationFrame(function () { raf = 0; place(); applyPause(); }); }
    try { var mo = new MutationObserver(soon); doc.querySelectorAll('.page, .modal-overlay, #cartDrawer').forEach(function (n) { mo.observe(n, { attributes: true, attributeFilter: ['class'] }); });
      new MutationObserver(soon).observe(doc.body, { childList: true }); } catch (_) {}
    doc.addEventListener('click', soon, true);
    applyQuality(); watchBattery(); place(); applyPause(); setState(root.navigator.onLine === false ? 'offline' : 'listo');
    setTimeout(measureFrames, 1500);
  }

  // Arranque: después de que el POS terminó de cargar (load + momento libre), primero se pregunta al servidor.
  function boot() {
    refreshAccess();
    root.addEventListener('online', refreshAccess);
    root.addEventListener('offline', function () { renderHero(); });
    doc.addEventListener('visibilitychange', function () { if (!doc.hidden) refreshAccess(); });
    var tick = 0; function check() { if (tick) return; tick = setTimeout(function () { tick = 0; if (!doc.hidden) { renderHero(); decorateConfig(); decorateRegister(); } }, 250); }
    try { new MutationObserver(check).observe(doc.body, { childList: true, subtree: true }); } catch (_) {}
    var menu = doc.getElementById('pageMenu');
    try { if (menu) new MutationObserver(function () { if (menu.classList.contains('active')) refreshAccess(); }).observe(menu, { attributes: true, attributeFilter: ['class'] }); } catch (_) {}
  }
  root.NA_ASISTENTE = { open: function () { if (panelEl) openPanel(); }, close: function () { if (panelEl) closePanel(); }, setState: setState, send: send, _gate: gate, _deps: deps, get quality() { return quality; }, place: place, refreshAccess: refreshAccess, get access() { return access; } };
  function later() { (root.requestIdleCallback || function (f) { setTimeout(f, 300); })(boot, { timeout: 2500 }); }
  if (doc.readyState === 'complete') later(); else root.addEventListener('load', later);
})(window);
