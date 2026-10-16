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
  var history = [], state = 'listo', quality = 'high', lowBattery = false, slowFrames = false, stateTimer = null, busy = false;
  var clockOffset = 0;
  var IDLE_MS = 20000, idleTimer = null, sleeping = false, offscreen = false;

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
  function protoRole() { try { return root.localStorage.getItem('na_asistente_proto_role') === 'empleado' ? 'empleado' : null; } catch (_) { return null; } }
  function roles() {
    var R = root.NA_ROLES || { role: 'unknown' };
    if (!creds() && protoRole()) return { role: 'empleado', isOwner: function () { return false; } };
    return R;
  }
  // Mismo pedido que NA_ROLES.api (endpoint, Bearer, sin cookies) pero con límite de tiempo propio del asistente.
  // Un timeout lanza un error (timeout=true); un error HTTP vuelve como { error, status }.
  async function post(path, body, headers, ms) {
    var c = creds(), url = path, h = Object.assign({ 'content-type': 'application/json' }, headers || {});
    var init = { method: 'POST', cache: 'no-store', body: JSON.stringify(body) };
    if (c) { url = c.endpoint.replace(/\/+$/, '') + path; h.authorization = 'Bearer ' + c.token; init.credentials = 'omit'; init.redirect = 'error'; }
    else if (protoRole()) h['x-proto-role'] = 'empleado';
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
    for (var i = 0; i < 2; i++) {
      try { var body = { token: p.confirm_token, proposal: clean }; if (review) body.review = review;
        var d = await post('/auth/assistant/confirm', body, hdr, C.TIMEOUTS.confirm); return d.ok ? d : { ok: false, error: d.error, rows: d.rows }; }
      catch (e) { lastErr = e; if (i === 0) await new Promise(function (r) { setTimeout(r, 600); }); }
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
    if (p.type === 'compra') rows = p.lineas.map(function (l, i) {
      var flag = l.revisar && l.revisar.length;
      var why = flag ? l.revisar.map(function (k) { return REVIEW_TEXT[k] || k; }).join(', ') : '';
      return '<tr' + (flag ? ' class="flag" data-row="' + i + '"' : '') + '><td>' + E(l.cantidad) + ' × ' + E(l.nombre) + (l.product_id ? '' : ' <b class="nr">(no registrado)</b>') +
        (flag ? '<div class="flag-t">Revisa este dato: ' + E(why) + '</div><div class="flag-a"><button type="button" data-accept="' + i + '">Está bien</button><button type="button" data-drop="' + i + '">Quitar fila</button></div>' : '') +
        '</td><td class="r">' + (l.costo_unitario != null ? soles(l.costo_unitario) : '') + '</td></tr>'; }).join('');
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
    var owner = OWNER_TYPES.indexOf(p.type) >= 0;
    return '<h4>' + E(p.title) + (owner ? '<span class="pill">Solo dueño</span>' : '') + '</h4>' + head + '<table>' + rows + '</table>' + warn + '<div class="note">' + E(note) + '</div>' +
      '<div class="meta"><span>Vence en <b data-left>5:00</b></span><span>Se usa una sola vez</span></div>' +
      (owner ? '<div class="na-asst-pin"><label>Escribe tu PIN de dueño</label><input type="password" inputmode="numeric" maxlength="8" autocomplete="off" aria-label="PIN del dueño"></div>' : '') +
      '<div class="res" aria-live="polite"></div>' +
      '<div class="acts"><button type="button" class="na-asst-ok" data-ok>Confirmar</button><button type="button" class="na-asst-no" data-no>Cancelar</button></div>';
  }
  var OWNER_TYPES = ['precio', 'compra'];
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
    try { d = await post('/auth/owner-approval', { pin: pin, action: p.type === 'precio' ? 'product.update' : 'inventory.adjust', operation_id: op }, null, C.TIMEOUTS.approval); }
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
  function addCard(p) {
    var key = gate.add(p); if (!key) return;
    var c = el('div', 'na-asst-card', cardHtml(p)); c.dataset.type = p.type; c.dataset.st = 'pending'; msgsEl.appendChild(c);
    var res = c.querySelector('.res');
    var go = c.querySelector('[data-go]'); if (go) go.onclick = function () { gate.execute(key, { confirmed: true }).then(function () { closePanel(); }); };
    var no = c.querySelector('[data-no]'); if (no) no.onclick = function () { gate.cancel(key); c.dataset.st = 'cancelled'; res.textContent = 'Cancelado. No se hizo nada.'; };
    var ok = c.querySelector('[data-ok]'), left = c.querySelector('[data-left]'), pinEl = c.querySelector('.na-asst-pin input');
    var exp = tokenExp(p), timer = null;
    // Filas «Revisa este dato»: Confirmar queda apagado hasta aceptar o quitar cada una (el servidor exige lo mismo).
    var decided = {};
    function pendingRows() { return Array.prototype.filter.call(c.querySelectorAll('tr.flag'), function (tr) { return !decided[tr.dataset.row]; }).length; }
    function review() { if (p.type !== 'compra') return null; var a = [], d = []; Object.keys(decided).forEach(function (k) { (decided[k] === 'drop' ? d : a).push(Number(k)); }); return { op: tokenOp(p), accept: a, drop: d }; }
    function syncOk() { if (!ok || c.dataset.st !== 'pending') return; var n = pendingRows(); ok.disabled = n > 0; ok.textContent = n > 0 ? 'Revisa ' + n + (n === 1 ? ' fila' : ' filas') : 'Confirmar'; }
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
      if (ms <= 0) { clearInterval(timer); if (c.dataset.st === 'pending') { gate.cancel(key); c.dataset.st = 'expired'; res.textContent = 'Esta propuesta venció. Pídela otra vez.'; if (ok) { ok.textContent = 'Vencida'; ok.disabled = true; } if (no) no.disabled = true; } left.textContent = '0:00'; return; }
      var sec = Math.ceil(ms / 1000); left.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    }
    syncOk();
    if (left && p.needsConfirm) { tick(); timer = setInterval(function () { if (c.dataset.st !== 'pending') { clearInterval(timer); return; } tick(); }, 1000); }
    if (ok) ok.onclick = async function () {
      if (c.dataset.st !== 'pending') return;
      ok.disabled = true; no.disabled = true; ok.textContent = 'Confirmando…'; setState('concentrado');
      if (pinEl) {
        var v = await verifyOwnerPin(pinEl.value.trim(), p); pinEl.value = '';
        if (!v.ok) { res.textContent = v.msg; no.disabled = false; ok.textContent = 'Confirmar'; ok.disabled = false; syncOk(); setState('error', 2000); return; }
      }
      gate.execute(key, { confirmed: true, review: review() }).then(function (r) {
        res.textContent = r.msg; c.dataset.st = gate.state(key) || 'pending';
        if (c.dataset.st !== 'pending') ok.textContent = { done: 'Hecho', denied: 'No disponible', cancelled: 'Cancelada', expired: 'Vencida' }[c.dataset.st] || 'Confirmar';
        if (r.ok) { setState('feliz', 2600); if (p.type !== 'documento') setTimeout(closePanel, 1400); }
        else { setState('error', 2600); if (c.dataset.st === 'pending') { ok.disabled = false; no.disabled = false; ok.textContent = 'Confirmar'; syncOk(); } }
      });
    };
    scrollEnd();
  }
  var ERRORS = { rate_limited: 'Vas muy rápido. Espera un minuto.', daily_limit: 'Llegaste al límite de hoy en este aparato.', monthly_cap: 'Se alcanzó el tope del mes del asistente. Avisa al dueño.',
    image_too_large: 'La foto es muy grande.', bad_image: 'No pude leer esa foto.', upstream_timeout: 'El asistente tardó mucho. Inténtalo otra vez.', upstream_error: 'El asistente no respondió. Inténtalo otra vez.',
    upstream_busy: 'El asistente está ocupado. Inténtalo en un momento.', not_found: 'El asistente no está activado en este servidor.', forbidden_role: 'No tienes permiso para esto.', unauthorized: 'Este aparato no tiene sesión.' };
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
      if (!d.ok) { addMsg('a', ERRORS[d.error] || 'No se pudo completar. Inténtalo otra vez.'); setState('error', 2600); return; }
      history.push({ role: 'user', content: body.text || 'Foto' }, { role: 'assistant', content: d.reply });
      addMsg('a', d.reply); if (d.mode === 'mock') { var m = el('div', 'na-asst-mode'); m.textContent = 'Modo demostración (sin clave de DeepSeek)'; msgsEl.appendChild(m); }
      (d.denied || []).forEach(addDenied);
      (d.proposals || []).forEach(addCard);
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
    if (!msgsEl.children.length) addMsg('a', '¡Hola! Soy Burbuja. Te ayudo a vender, registrar compras, leer fotos de facturas, preparar documentos y explicarte el sistema. Nada se hace sin que pulses Confirmar.');
    var off = root.navigator.onLine === false; offline(off); if (off) setState('offline'); else setState('feliz', 1300); measureFrames();
    setTimeout(function () { try { inputEl.focus({ preventScroll: true }); } catch (_) {} }, 50);
  }
  function closePanel() { panelEl.hidden = true; rootEl.hidden = false; place(); applyPause(); }

  function mount() {
    if (doc.querySelector('.na-asst-root')) return; // se construye una sola vez
    rootEl = el('div', 'na-asst-root'); rootEl.dataset.state = 'listo';
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
    root.addEventListener('online', function () { offline(false); });
    root.addEventListener('offline', function () { offline(true); });
    doc.addEventListener('visibilitychange', function () { if (doc.hidden) applyPause(); else wake(); });
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

  root.NA_ASISTENTE = { open: function () { openPanel(); }, close: function () { closePanel(); }, setState: setState, send: send, _gate: gate, _deps: deps, get quality() { return quality; }, place: place };
  if (doc.body) mount(); else doc.addEventListener('DOMContentLoaded', mount);
})(window);
