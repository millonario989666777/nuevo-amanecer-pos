/* Etapa 2 (G): secciones Usuarios y PIN, Aparatos conectados, Copia de seguridad; nombres claros;
   Reseteo al final con reglas seguras. Todo lo sensible lo valida el servidor. */
(function (root) {
  'use strict';
  var doc = root.document;
  var R = function () { return root.NA_ROLES; };
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function toast(m, k) { try { root.toast(m, k || 'success'); } catch (_) {} }
  function cloud() { try { return !!(root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.enabled()); } catch (_) { return false; } }
  function head(icon, title, sub) { return '<div class="cfg-screen-head"><div class="cfg-screen-head-main"><div class="cfg-screen-head-icon">' + icon + '</div><div><div class="cfg-screen-head-title">' + esc(title) + '</div><div class="cfg-screen-head-sub">' + esc(sub) + '</div></div></div></div>'; }
  function fmtDate(iso) { if (!iso) return '—'; try { return new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) { return iso; } }

  var SECTIONS = [
    ['usuarios', '🔐', 'Usuarios y PIN', 'PIN del dueño y roles'],
    ['aparatos', '📱', 'Aparatos conectados', 'Celulares y cajas vinculados'],
    ['respaldo', '💾', 'Copia de seguridad', 'Descargar respaldo']
  ];
  var RENAMES = { control: ['Bloqueos y permisos', 'Qué módulos se pueden usar'], info: ['Estado del sistema', 'Versión y datos guardados'], importar: ['Importar productos', 'Catálogo desde Excel o CSV'] };

  function sidebar() {
    var sb = doc.getElementById('cfgSidebar'); if (!sb) return;
    var after = sb.querySelector('.cfg-cat-btn[data-cfgcat="ticket"]');
    SECTIONS.slice().reverse().forEach(function (s) {
      if (sb.querySelector('.cfg-cat-btn[data-cfgcat="' + s[0] + '"]')) return;
      var b = doc.createElement('button'); b.className = 'cfg-cat-btn na-g-cat'; b.dataset.cfgcat = s[0];
      b.setAttribute('onclick', "switchCfgCategory('" + s[0] + "')");
      b.innerHTML = '<span>' + s[1] + '</span><div><strong>' + esc(s[2]) + '</strong><small>' + esc(s[3]) + '</small></div>';
      if (s[0] === 'respaldo') { var imp = sb.querySelector('.cfg-cat-btn[data-cfgcat="importar"]'); if (imp) { imp.after(b); return; } }
      if (after) after.after(b); else sb.appendChild(b);
    });
    Object.keys(RENAMES).forEach(function (k) {
      var b = sb.querySelector('.cfg-cat-btn[data-cfgcat="' + k + '"]'); if (!b) return;
      var st = b.querySelector('strong'), sm = b.querySelector('small');
      if (st) st.textContent = RENAMES[k][0]; if (sm && !b.dataset.naRenamed) sm.textContent = RENAMES[k][1]; b.dataset.naRenamed = '1';
    });
    // Reseteo siempre al final, separado y en rojo.
    var reset = sb.querySelector('.cfg-cat-btn[data-cfgcat="reseteo"]');
    if (reset) { reset.classList.add('na-cfg-danger'); var st2 = reset.querySelector('strong'), sm2 = reset.querySelector('small'); if (st2) st2.textContent = 'Reseteo'; if (sm2) sm2.textContent = 'Borrar datos de este aparato'; sb.appendChild(reset); }
  }

  function usuariosHtml() {
    var r = R(), set = r && r.pinSet;
    return head('🔐', 'Usuarios y PIN', 'El PIN del dueño autoriza anulaciones, ajustes de stock, cambios de precio y el reseteo.')
      + '<div class="cfg-panel"><div class="cfg-panel-title">Este aparato</div><div class="cfg-info-list">'
      + '<div class="cfg-info-row"><span>Rol</span><span>' + (r && r.role === 'empleado' ? 'Empleado' : 'Dueño') + '</span></div>'
      + '<div class="cfg-info-row"><span>PIN del dueño</span><span id="naPinState">' + (set ? 'Configurado' : 'Todavía no configurado') + '</span></div></div></div>'
      + '<div class="cfg-panel"><div class="cfg-panel-title">' + (set ? 'Cambiar PIN del dueño' : 'Crear PIN del dueño') + '</div>'
      + '<div class="cfg-panel-sub">De 4 a 8 dígitos. Se guarda cifrado en el servidor, nunca en este aparato. No lo compartas por chat.</div>'
      + '<div class="na-g-form">' + (set ? '<label>PIN actual<input id="naPinCurrent" class="cfg-input" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>' : '')
      + '<label>PIN nuevo<input id="naPinNew" class="cfg-input" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>'
      + '<label>Repite el PIN nuevo<input id="naPinNew2" class="cfg-input" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></label>'
      + '<button type="button" class="na-cfg-save-btn" id="naPinSave">Guardar PIN</button></div></div>'
      + '<div class="cfg-business-note">Los cajeros y sus permisos locales siguen en Negocio › Cajeros locales. Para que un empleado use otro celular, ve a Aparatos conectados.</div>';
  }
  async function savePin(who) {
    var cur = doc.getElementById('naPinCurrent'), a = doc.getElementById('naPinNew'), b = doc.getElementById('naPinNew2');
    var clear = function () { [cur, a, b].forEach(function (i) { if (i) i.value = ''; }); };
    if (!/^\d{4,8}$/.test(a.value)) { toast('El PIN debe tener de 4 a 8 dígitos.', 'error'); return; }
    if (a.value !== b.value) { toast('Los dos PIN nuevos no coinciden.', 'error'); return; }
    try { await R().api('/auth/owner-pin', { new_pin: a.value, current_pin: cur ? cur.value : undefined }); clear(); await R().refresh(); toast('PIN del ' + (who === 'admin' ? 'admin' : 'dueño') + ' guardado'); render('usuarios'); }
    catch (e) { clear(); toast(R().message(e), 'error'); }
  }

  function aparatosHtml() {
    return head('📱', 'Aparatos conectados', 'Vincula el celular de un empleado con un código de un solo uso. Puedes desconectarlo cuando quieras.')
      + '<div class="cfg-panel"><div class="cfg-panel-title">Vincular un aparato de empleado</div>'
      + '<div class="cfg-panel-sub">El código dura 15 minutos y sirve una sola vez. El empleado podrá vender, cobrar y registrar, pero no abrir Configuración ni anular o ajustar sin tu PIN.</div>'
      + '<div class="na-g-form"><label>Nombre del aparato (opcional)<input id="naPairLabel" class="cfg-input" maxlength="60" placeholder="Ej. Caja 2, celular de Rosa"></label>'
      + '<button type="button" class="na-cfg-save-btn" id="naPairCreate">Crear código</button></div><div id="naPairOut"></div></div>'
      + '<div class="cfg-panel"><div class="cfg-panel-title">Aparatos</div><div id="naDevList" class="na-g-devs">Cargando…</div></div>';
  }
  async function loadDevices() {
    var box = doc.getElementById('naDevList'); if (!box) return;
    try {
      var d = (await R().api('/auth/devices', {})).devices || [];
      var active = d.filter(function (x) { return x.status === 'active'; });
      box.innerHTML = active.length ? active.map(function (x) {
        return '<div class="na-g-dev"><div><strong>' + esc(x.label || (x.pos_role === 'empleado' ? 'Aparato de empleado' : 'Aparato del dueño')) + (x.current ? ' (este)' : '') + '</strong>'
          + '<small>' + (x.pos_role === 'empleado' ? 'Empleado' : 'Dueño') + ' · desde ' + esc(fmtDate(x.created_at)) + '</small></div>'
          + (x.current ? '' : '<button type="button" class="na-g-revoke" data-dev="' + esc(x.device_id) + '">Desconectar</button>') + '</div>';
      }).join('') : '<div class="cfg-business-note">No hay aparatos activos.</div>';
    } catch (e) { box.textContent = R().message(e); }
  }
  async function needPin(title) { if (!R().pinSet) return ''; var p = await R().askPin(title, 'Escribe tu PIN de dueño.'); return p; }
  async function createPair() {
    var pin = await needPin('Crear código para empleado'); if (pin === null) return;
    var label = (doc.getElementById('naPairLabel') || {}).value || '';
    try {
      var r = await R().api('/auth/pairing-code', { label: label, pin: pin || undefined });
      var out = doc.getElementById('naPairOut');
      out.innerHTML = '<div class="na-g-code" aria-live="polite"><div class="na-g-code-val">' + esc(r.code) + '</div><div>Vence: ' + esc(fmtDate(r.expires_at)) + '</div>'
        + '<ol><li>En el celular del empleado abre la página del POS (la misma dirección de siempre, sin /app).</li><li>Toca «Soy empleado: tengo un código».</li><li>Escribe este código y toca «Vincular».</li></ol></div>';
      loadDevices();
    } catch (e) { toast(R().message(e), 'error'); }
  }
  async function revoke(id) {
    var ok = true; try { ok = await root._naConfirmAction('¿Desconectar este aparato? Tendrá que vincularse de nuevo.', { title: 'Desconectar aparato', danger: true, okText: 'Desconectar' }); } catch (_) { ok = root.confirm('¿Desconectar este aparato?'); }
    if (!ok) return; var pin = await needPin('Desconectar aparato'); if (pin === null) return;
    try { await R().api('/auth/devices/revoke', { device_id: id, pin: pin || undefined }); toast('Aparato desconectado'); loadDevices(); } catch (e) { toast(R().message(e), 'error'); }
  }

  function respaldoHtml() {
    var c = cloud();
    return head('💾', 'Copia de seguridad', c ? 'Tus ventas, abonos y cajas ya se guardan en la nube con respaldo automático. Aquí puedes descargar una copia para guardarla.' : 'Descarga una copia de todo el sistema o restaura una existente.')
      + '<div class="cfg-panel"><div class="cfg-panel-title">Descargar copia</div><div class="cfg-panel-sub">Archivo JSON con los datos que hay en este aparato.</div>'
      + '<div class="cfg-upload-box"><button class="cfg-save-btn" onclick="exportarRespaldo()">⬇️ Descargar copia de seguridad</button></div></div>'
      + (c ? '<div class="cfg-business-note">Restaurar una copia está desactivado con la nube activa: podría pisar datos ya sincronizados.</div>'
        : '<div class="cfg-panel"><div class="cfg-panel-title">Restaurar copia</div><div class="cfg-upload-box"><input type="file" id="backupFile" accept=".json"><button class="cfg-save-btn" onclick="importarRespaldo()" style="background:var(--blue)">⬆️ Restaurar respaldo</button></div></div>');
  }

  // Reseteo nunca borra ventas, abonos, créditos, cajas, stock, movimientos, compras, fotos
  // ni la Apariencia del aparato. Con la nube solo vuelve a descargar los datos del servidor.
  function reseteoHtml() {
    var keep = 'No se borran ventas, abonos, créditos, cajas, stock, movimientos de inventario, compras aplicadas, fotos de productos ni la Apariencia de este aparato.';
    if (!cloud()) return head('⚠️', 'Reseteo', keep) + '<div class="cfg-business-note">Sin la nube activa no hay nada que volver a descargar. Para empezar de cero, pide ayuda al soporte.</div>';
    return head('⚠️', 'Reseteo', keep)
      + '<div class="cfg-action-card danger"><div class="cfg-action-title">☁️ Volver a descargar de la nube</div>'
      + '<div class="cfg-action-desc">Vuelve a traer los datos del servidor a este aparato. Pide el PIN del dueño (lo valida el servidor), necesita internet y no funciona si hay ventas, abonos o compras sin confirmar.</div>'
      + '<button class="cfg-save-btn" id="naResync" onclick="resetModule(\'nube\')" style="background:var(--red);padding:11px">Volver a descargar</button></div>';
  }
  function online() { try { return root.navigator.onLine !== false; } catch (_) { return true; } }

  function render(cat) {
    var cont = doc.getElementById('cfgContent'); if (!cont) return false;
    if (cat === 'usuarios') cont.innerHTML = usuariosHtml();
    else if (cat === 'aparatos') { cont.innerHTML = aparatosHtml(); loadDevices(); }
    else if (cat === 'respaldo') cont.innerHTML = respaldoHtml();
    else if (cat === 'reseteo') cont.innerHTML = reseteoHtml();
    else return false;
    return true;
  }
  function afterBase(cat) {
    var cont = doc.getElementById('cfgContent'); if (!cont) return;
    if (cat === 'importar') { // la copia de seguridad ahora tiene su propia sección
      var f = cont.querySelector('#backupFile'); var panel = f && f.closest('.cfg-panel'); if (panel) panel.remove();
    }
    if (cat === 'reseteo') {
      var h = cont.querySelector('.cfg-screen-head-sub');
      if (h && cloud()) h.textContent = 'Borra datos solo de este aparato. En la nube no se borra nada: las ventas, abonos y cajas sincronizadas vuelven a descargarse. Pide el PIN del dueño y no funciona si hay ventas sin confirmar.';
    }
  }

  // Reseteo con reglas: PIN validado en el servidor y bloqueo si hay ventas sin confirmar.
  function unconfirmedSales() {
    try { if (root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.pendingSnapshot()) return true; } catch (_) {}
    try { var rej = JSON.parse(root.localStorage.getItem('na_canonical_rejected_operations') || '[]'); if (rej && (Array.isArray(rej) ? rej.length : Object.keys(rej).length)) return true; } catch (_) {}
    try { return (root.ventas || []).some(function (v) { return v && (v.source === 'CANONICAL_OUTBOX' || v.status === 'PENDING_SYNC' || v.naReview || v.canonicalReview); }); } catch (_) { return false; }
  }
  function wrapReset() {
    if (typeof root.resetModule !== 'function' || root.resetModule.__naG) return;
    var base = root.resetModule;
    root.resetModule = async function (modulo) {
      if (!R() || !R().isOwner()) { toast('Solo el dueño puede usar Reseteo, con el aparato conectado a internet.', 'error'); return; }
      if (!cloud() || modulo !== 'nube') { toast('Reseteo ya no borra datos. Con la nube activa usa «Volver a descargar».', 'error'); return; }
      if (!online()) { toast('Sin internet: Reseteo necesita conexión para validar el PIN.', 'error'); return; }
      if (unconfirmedSales()) { toast('Hay ventas, abonos o compras sin confirmar. Espera a que se sincronicen.', 'error'); return; }
      if (!R().pinSet) { toast('Primero crea el PIN del dueño en Usuarios y PIN.', 'error'); return; }
      // El servidor valida el PIN antes de que el aparato cambie nada.
      var id = await R().approve('reset', null, 'Reseteo', 'Escribe el PIN del dueño para volver a descargar los datos de la nube.');
      if (!id) return;
      try { await R().refresh(); } catch (_) {}
      if (!R().isOwner() || !online() || unconfirmedSales()) { toast('No se hizo: cambió la conexión o hay operaciones pendientes.', 'error'); return; }
      try { await root.NuevoAmanecerCanonical.refresh(); toast('Datos descargados de nuevo desde la nube.'); }
      catch (_) { toast('No se pudo descargar desde la nube. Inténtalo de nuevo.', 'error'); }
    };
    root.resetModule.__naG = true;
  }


  // Negocio, POS y Ticket: el servidor (/settings) es la fuente. Solo el dueño confirmado guarda;
  // los demás aparatos usan una copia local de solo lectura que se vuelve a tomar del servidor.
  var SHARED = {
    'pos.business': { get: function (c) { var b = c.business || {}; return { nombre: b.nombre || '', ruc: b.ruc || '', direccion: b.direccion || '', telefono: b.telefono || '' }; },
      set: function (c, v) { c.business = Object.assign(c.business || {}, v); } },
    'pos.flags': { get: function (c) { return { igvActive: !!c.igvActive, margenActive: !!c.margenActive, stockAlertActive: !!c.stockAlertActive, printAuto: !!c.printAuto, mayoristaActive: !!c.mayoristaActive, alertsEnabled: c.alertsEnabled !== false, stockMin: c.stockMin }; },
      set: function (c, v) { Object.keys(v || {}).forEach(function (k) { c[k] = v[k]; }); } },
    // Línea de crédito inicial, reglas y días para pagar (30 por defecto): una sola política para todos los aparatos.
    'pos.credit': { get: function (c) { return Object.assign({}, c.creditPolicy || {}); }, set: function (c, v) { c.creditPolicy = Object.assign(c.creditPolicy || {}, v); } },
    'pos.ticket': { get: function (c) { return Object.assign({}, c.ticket || {}); }, set: function (c, v) { c.ticket = Object.assign(c.ticket || {}, v); } }
  };
  var CACHE_KEY = 'na_pos_settings_cache_v1';
  var server = {}; // key -> { value, revision }
  try { server = JSON.parse(root.localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (_) { server = {}; }
  var baseSave = null, pushTimer = null;
  /* global appConfig */
  function cfg() { try { return typeof appConfig !== 'undefined' ? appConfig : null; } catch (_) { return null; } }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function applyServer() {
    var c = cfg(); if (!c) return false; var changed = false;
    Object.keys(SHARED).forEach(function (k) { if (!server[k]) return; var before = SHARED[k].get(c); SHARED[k].set(c, server[k].value); if (!same(before, SHARED[k].get(c))) changed = true; });
    if (changed) { try { root._naApplyConfigUI(); } catch (_) {} try { baseSave && baseSave(); } catch (_) {} }
    return changed;
  }
  async function pullSettings() {
    if (!cloud() || !R()) return false;
    try {
      var out = await R().api('/settings', null, 'GET');
      (out.settings || []).forEach(function (r) { if (SHARED[r.key]) server[r.key] = { value: r.value, revision: r.revision }; });
      try { root.localStorage.setItem(CACHE_KEY, JSON.stringify(server)); } catch (_) {}
    } catch (_) {}
    var owner = R().isOwner && R().isOwner();
    // El dueño solo recibe del servidor lo que ya existe allí; nunca pierde lo que aún no subió.
    return owner ? applyServerIfMissingLocal() : applyServer();
  }
  function applyServerIfMissingLocal() { return Object.keys(server).length ? applyServer() : false; }
  async function pushSettings() {
    var c = cfg(); if (!c || !cloud() || !R() || !R().isOwner()) return { ok: false, reason: 'owner_only' };
    var failed = [];
    for (var k in SHARED) {
      var value = SHARED[k].get(c);
      if (server[k] && same(server[k].value, value)) continue;
      try {
        var res = await R().api('/settings', { key: k, value: value, expected_revision: server[k] ? server[k].revision : 0 });
        server[k] = { value: value, revision: res.revision };
      } catch (e) { failed.push(k); if (e && e.message === 'revision_conflict') { await pullSettings(); } }
    }
    try { root.localStorage.setItem(CACHE_KEY, JSON.stringify(server)); } catch (_) {}
    return { ok: !failed.length, failed: failed };
  }
  function wrapSettings() {
    if (typeof root.saveAppState === 'function' && !root.saveAppState.__naG) {
      baseSave = root.saveAppState;
      root.saveAppState = function () {
        var out = baseSave.apply(this, arguments);
        if (cloud() && R()) {
          if (R().isOwner()) { clearTimeout(pushTimer); pushTimer = setTimeout(function () { pushSettings(); }, 600); }
          else if (Object.keys(server).length) setTimeout(applyServer, 0); // solo lectura: se vuelve a la copia del servidor
        }
        return out;
      };
      root.saveAppState.__naG = true;
    }
    if (typeof root.guardarConfig === 'function' && !root.guardarConfig.__naG) {
      var baseGuardar = root.guardarConfig;
      root.guardarConfig = async function () {
        if (cloud()) {
          if (!R() || !R().isOwner()) { toast(root.navigator.onLine === false ? 'Sin conexión: Configuración necesita internet para confirmar que eres el dueño.' : 'Solo el dueño puede cambiar la configuración.', 'error'); applyServer(); return false; }
          if (root.navigator.onLine === false) { toast('Sin conexión: la configuración se guarda en el servidor. Conéctate e inténtalo de nuevo.', 'error'); return false; }
        }
        var ok = await baseGuardar.apply(this, arguments);
        if (!cloud() || !ok) return ok;
        clearTimeout(pushTimer);
        var res = await pushSettings();
        if (!res.ok) { toast('No se pudo guardar en el servidor. Revisa internet e inténtalo de nuevo.', 'error'); return false; }
        toast('Configuración guardada en el servidor', 'success');
        return true;
      };
      root.guardarConfig.__naG = true;
    }
  }


  // Descuentos de empleado: con internet piden el PIN del dueño (lo valida el servidor).
  // Sin internet se aplican marcados «por autorizar» y, al cobrar, quedan en un registro
  // local de solo agregar: nunca se borran ni se cambian.
  var DISC_KEY = 'na_discounts_por_autorizar_v1';
  /* global cart */
  function cartRef() { try { return typeof cart !== 'undefined' ? cart : []; } catch (_) { return []; } }
  function isEmployee() { return cloud() && R() && R().role === 'empleado'; }
  function discountLog() { try { var v = JSON.parse(root.localStorage.getItem(DISC_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } }
  function appendDiscount(entry) {
    var list = discountLog(); if (list.some(function (e) { return e.id === entry.id; })) return false;
    list.push(entry); root.localStorage.setItem(DISC_KEY, JSON.stringify(list));
    return root.localStorage.getItem(DISC_KEY) === JSON.stringify(list);
  }
  function wrapDiscounts() {
    if (typeof root.aplicarDescuentoPorcentaje === 'function' && !root.aplicarDescuentoPorcentaje.__naG) {
      var baseApply = root.aplicarDescuentoPorcentaje;
      root.aplicarDescuentoPorcentaje = async function (value) {
        if (!isEmployee()) return baseApply.apply(this, arguments);
        if (root.navigator.onLine !== false) {
          var id = await R().approve('discount', null, 'Autorización del dueño', 'Descuento de ' + (Number(value) || 0) + '%: pide al dueño que escriba su PIN.');
          if (!id) { toast('Descuento cancelado.', 'error'); return; }
          var r = baseApply.apply(this, arguments);
          cartRef().forEach(function (it) { if (it._descuento != null) { it._descuentoAprobado = id; delete it._descuentoPorAutorizar; } });
          return r;
        }
        var out = baseApply.apply(this, arguments);
        cartRef().forEach(function (it) { if (it._descuento != null && !it._descuentoAprobado) it._descuentoPorAutorizar = true; });
        toast('Sin conexión: el descuento queda «por autorizar» y el dueño lo revisará.', 'error');
        return out;
      };
      root.aplicarDescuentoPorcentaje.__naG = true;
    }
    if (typeof root.confirmarVenta === 'function' && !root.confirmarVenta.__naGDisc) {
      var baseConfirm = root.confirmarVenta;
      root.confirmarVenta = async function () {
        var flagged = cartRef().filter(function (it) { return it._descuentoPorAutorizar; }).map(function (it) {
          return { nombre: String(it.name || it.nombre || ''), cantidad: Number(it.qty) || 0, precio_original: Number(it._precioOriginal) || 0, precio: Number(it.precio) || 0, descuento_pct: Number(it._descuento) || 0 };
        });
        var out = await baseConfirm.apply(this, arguments);
        if (flagged.length && !cartRef().length) {
          var total = flagged.reduce(function (a, i) { return a + (i.precio_original - i.precio) * i.cantidad; }, 0);
          appendDiscount(Object.freeze({ id: 'D-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), registrado: new Date().toISOString(), aparato: (R() && R().label) || '', estado: 'por autorizar', descuento_total: Math.round(total * 100) / 100, items: flagged }));
        }
        return out;
      };
      root.confirmarVenta.__naGDisc = true;
    }
  }

  function install() {
    sidebar(); wrapReset(); wrapSettings(); wrapDiscounts();
    if (typeof root.renderCfgContent === 'function' && !root.renderCfgContent.__naG) {
      var base = root.renderCfgContent;
      root.renderCfgContent = function (cat) { if (render(cat)) return; var r = base.apply(this, arguments); try { afterBase(cat); } catch (_) {} return r; };
      root.renderCfgContent.__naG = true;
    }
  }
  doc.addEventListener('click', function (e) {
    var t = e.target; if (!t || !t.closest) return;
    if (t.closest('#naPinSave')) savePin();
    else if (t.closest('#naPairCreate')) createPair();
    else { var rv = t.closest('.na-g-revoke'); if (rv) revoke(rv.dataset.dev); }
  });
  root.addEventListener('na:role', function () { sidebar(); if (R() && (R().confirmed || R().role === 'empleado')) pullSettings(); });
  if (cloud()) setTimeout(function () { try { if (!R() || !R().isOwner()) applyServer(); } catch (_) {} }, 0);
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', install); else install();
  root.addEventListener('load', install);
  // Configuración v9 (PC/tablet): guardar ya y esperar al servidor para mostrar «Guardado ✓».
  async function flush() {
    clearTimeout(pushTimer);
    try { if (baseSave) await baseSave(); else if (typeof root.saveAppState === 'function') await root.saveAppState(); } catch (_) {}
    if (!cloud() || !R()) return { ok: true, local: true };
    return pushSettings();
  }
  root.NA_CONFIG_G = { flush: flush, savePin: savePin, loadDevices: loadDevices, render: render, unconfirmedSales: unconfirmedSales, pullSettings: pullSettings, pushSettings: pushSettings, discountLog: function () { return JSON.parse(JSON.stringify(discountLog())); } };
})(window);
