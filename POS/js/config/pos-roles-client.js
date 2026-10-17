/* Etapa 2 (G): rol del aparato (dueño/empleado) y PIN del dueño validado en el servidor.
   - El rol lo decide el servidor (/auth/me). Mientras no se conoce, la app falla cerrada:
     Configuración queda oculta. Sin nube (modo local) el aparato es del dueño.
   - El PIN nunca se guarda en el aparato: se envía una vez al servidor, que devuelve una
     aprobación de corta duración atada a la operación. */
(function (root) {
  'use strict';
  var doc = root.document;
  var CRED = 'na_cloud_sync_credentials', CACHE = 'na_pos_role_v1';
  var OWNER_COMMANDS = ['inventory.adjust', 'adjustment.create', 'compensation.create', 'product.update', 'customer.credit-policy.set'];
  var state = { role: 'unknown', pinSet: false, label: null, deviceId: null, ready: false, confirmed: false };

  function creds() {
    try { var c = JSON.parse(root.localStorage.getItem(CRED) || 'null'); return c && c.endpoint && c.token ? c : null; } catch (_) { return null; }
  }
  function cloud() {
    try { return !!(root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.enabled()) || !!creds(); } catch (_) { return !!creds(); }
  }
  // Configuración y acciones de dueño solo con el rol confirmado por el servidor en esta sesión.
  // El rol en caché (sin internet) nunca abre Configuración.
  function canConfigure() { return !cloud() || (state.role === 'owner' && state.confirmed); }
  function paint() {
    var html = doc.documentElement;
    html.classList.toggle('na-role-owner', state.role === 'owner');
    html.classList.toggle('na-role-empleado', state.role === 'empleado');
    html.classList.toggle('na-role-locked', state.role !== 'owner');
    html.classList.toggle('na-role-unconfirmed', !canConfigure());
    try { root.dispatchEvent(new CustomEvent('na:role', { detail: { role: state.role } })); } catch (_) {}
  }
  function setState(next, persist) {
    state.role = next.role === 'owner' || next.role === 'empleado' ? next.role : 'unknown';
    state.pinSet = !!next.pinSet; state.label = next.label || null; state.deviceId = next.deviceId || null;
    if (persist) try { root.localStorage.setItem(CACHE, JSON.stringify({ role: state.role, pinSet: state.pinSet, label: state.label, at: Date.now() })); } catch (_) {}
    paint();
  }
  // Rol en caché: solo para seguir trabajando sin internet. El servidor siempre vuelve a decidir.
  (function boot() {
    if (!cloud()) { setState({ role: 'owner' }); state.ready = true; return; }
    try { var c = JSON.parse(root.localStorage.getItem(CACHE) || 'null'); if (c && c.role) setState(c); else paint(); } catch (_) { paint(); }
  })();

  async function api(path, body, method, extraHeaders) {
    var c = creds(); if (!c) throw new Error('SIN_SESION');
    var r = await root.fetch(c.endpoint.replace(/\/+$/, '') + path, {
      method: method || (body ? 'POST' : 'GET'), credentials: 'omit', redirect: 'error', cache: 'no-store',
      headers: Object.assign({ authorization: 'Bearer ' + c.token }, body ? { 'content-type': 'application/json' } : {}, extraHeaders || {}),
      body: body ? JSON.stringify(body) : undefined
    });
    var data = {}; try { data = await r.json(); } catch (_) {}
    if (!r.ok) { var e = new Error(data.error || ('HTTP_' + r.status)); e.status = r.status; e.data = data; throw e; }
    return data;
  }
  // Aparato desconectado por el dueño: se dice claramente (no se muestra la pantalla de venta).
  var REVOKED_KEY = 'na_device_revoked_v1';
  function revokedScreen(on) {
    var old = doc.getElementById('naRevoked');
    if (!on) { if (old) old.remove(); return; }
    if (old || !doc.body) return;
    var o = doc.createElement('div'); o.id = 'naRevoked'; o.className = 'na-pin-overlay'; o.setAttribute('role', 'alertdialog'); o.setAttribute('aria-modal', 'true');
    o.innerHTML = '<div class="na-pin-box"><div class="na-pin-title">Este aparato fue desconectado</div><div class="na-pin-detail">El dueño lo desconectó. Aquí ya no se puede vender ni cobrar. Pide al dueño un código nuevo para volver a conectarlo.</div><div class="na-pin-actions"><button type="button" class="na-pin-ok">Entendido</button></div></div>';
    o.querySelector('button').addEventListener('click', function () { o.remove(); });
    doc.body.appendChild(o);
  }
  try { if (root.localStorage.getItem(REVOKED_KEY)) { if (doc.body) revokedScreen(true); else doc.addEventListener('DOMContentLoaded', function () { revokedScreen(true); }); } } catch (_) {}
  async function refresh() {
    if (!cloud()) { setState({ role: 'owner' }); state.ready = true; return state; }
    try {
      var me = await api('/auth/me');
      state.confirmed = true;
      try { root.localStorage.removeItem(REVOKED_KEY); } catch (_) {} revokedScreen(false);
      setState({ role: me.pos_role, pinSet: me.owner_pin_set, label: me.label, deviceId: me.device_id }, true);
    } catch (e) {
      state.confirmed = false;
      if (e.status === 403 && e.message === 'session_revoked') { try { root.localStorage.setItem(REVOKED_KEY, '1'); } catch (_) {} revokedScreen(true); }
      if (e.status === 401 || e.status === 403) setState({ role: 'unknown' }, true); else paint();
    }
    state.ready = true;
    if (state.confirmed) { var notice = doc.querySelector('.na-offline-cfg'); if (notice) notice.remove(); }
    return state;
  }

  var PIN_ERRORS = {
    owner_pin_invalid: 'PIN incorrecto.', owner_pin_locked: 'Demasiados intentos. El PIN queda bloqueado 15 minutos.',
    owner_pin_not_set: 'El dueño todavía no configuró su PIN. Pídele que lo cree en Configuración › Usuarios y PIN.',
    pin_format: 'El PIN debe tener de 4 a 8 dígitos.', owner_only: 'Solo el aparato del dueño puede hacer esto.',
    roles_not_ready: 'El servidor aún no tiene activados los roles.', invalid_code: 'Código no válido o vencido.'
  };
  function message(e) { var k = e && (e.message || ''); if (PIN_ERRORS[k]) return PIN_ERRORS[k] + (e.data && e.data.attempts_left ? ' Quedan ' + e.data.attempts_left + ' intentos.' : ''); return 'No se pudo conectar con el servidor. Revisa internet.'; }

  // Ventana para pedir el PIN del dueño. Resuelve con el PIN escrito o null si se cancela.
  // verify(pin) opcional: el PIN se comprueba con la ventana abierta y el error queda escrito DENTRO de ella
  // (no en un aviso flotante que el teclado tapa).
  function askPin(title, detail, verify) {
    return new Promise(function (resolve) {
      var wrap = doc.createElement('div'); wrap.className = 'na-pin-overlay'; wrap.setAttribute('role', 'dialog'); wrap.setAttribute('aria-modal', 'true');
      wrap.innerHTML = '<div class="na-pin-box"><div class="na-pin-title"></div><div class="na-pin-detail"></div>' +
        '<input class="na-pin-input" type="password" inputmode="numeric" autocomplete="off" maxlength="8" aria-label="PIN del dueño" placeholder="PIN del dueño">' +
        '<div class="na-pin-msg" aria-live="polite"></div><div class="na-pin-actions"><button type="button" class="na-pin-cancel">Cancelar</button><button type="button" class="na-pin-ok">Autorizar</button></div></div>';
      wrap.querySelector('.na-pin-title').textContent = title || 'Autorización del dueño';
      wrap.querySelector('.na-pin-detail').textContent = detail || '';
      doc.body.appendChild(wrap);
      var input = wrap.querySelector('.na-pin-input');
      function done(v) { input.value = ''; wrap.remove(); resolve(v); }
      wrap.querySelector('.na-pin-cancel').onclick = function () { done(null); };
      var msgEl = wrap.querySelector('.na-pin-msg'), okBtn = wrap.querySelector('.na-pin-ok'), checking = false;
      okBtn.onclick = async function () {
        if (checking) return;
        var v = input.value.trim();
        if (!/^\d{4,8}$/.test(v)) { msgEl.textContent = PIN_ERRORS.pin_format; return; }
        if (typeof verify !== 'function') { done(v); return; }
        checking = true; okBtn.disabled = true; msgEl.textContent = 'Comprobando…';
        try {
          var r = await verify(v);
          if (r && r.ok) { done(r.value); return; }
          msgEl.textContent = (r && r.msg) || 'No se pudo comprobar el PIN.';
          if (r && r.stop) { setTimeout(function () { done(null); }, 2500); return; }
          input.value = ''; try { input.focus(); } catch (_) {}
        } finally { checking = false; okBtn.disabled = false; }
      };
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') wrap.querySelector('.na-pin-ok').click(); if (ev.key === 'Escape') done(null); });
      setTimeout(function () { input.focus(); }, 30);
    });
  }
  function toast(msg, kind) { try { root.toast(msg, kind || 'error'); } catch (_) {} }

  // Pide PIN y obtiene una aprobación del servidor. Devuelve approval_id o null.
  async function approve(action, operationId, title, detail) {
    var tries = 0;
    return askPin(title, detail, async function (pin) {
      try { var r = await api('/auth/owner-approval', { pin: pin, action: action, operation_id: operationId || null }); return { ok: true, value: r.approval_id }; }
      catch (e) {
        tries++;
        if (e.message === 'owner_pin_invalid' && tries < 3) return { msg: message(e) };
        return { msg: message(e), stop: true };
      }
    });
  }
  var LABELS = { 'expired_lot_sale': 'Uso de lotes vencidos', 'inventory.adjust': 'Ajuste de stock', 'adjustment.create': 'Ajuste de dinero', 'compensation.create': 'Anulación',
    'product.update': 'Cambio de producto o precio', 'customer.credit-policy.set': 'Límite de crédito del cliente' };
  // Llamado por canonical-client ANTES de guardar la operación: si se cancela no queda nada pendiente.
  async function beforeCommand(command, operationId) {
    if (OWNER_COMMANDS.indexOf(command) < 0 || state.role === 'owner' || !cloud()) return null;
    var id = await approve(command, operationId, 'Autorización del dueño', (LABELS[command] || command) + ': pide al dueño que escriba su PIN.');
    if (!id) { var err = new Error('OWNER_APPROVAL_CANCELLED'); err.code = 'OWNER_APPROVAL_CANCELLED'; throw err; }
    return id;
  }

  root.NA_ROLES = {
    get role() { return state.role; }, get pinSet() { return state.pinSet; }, get label() { return state.label; }, get deviceId() { return state.deviceId; },
    isOwner: canConfigure, canConfigure: canConfigure, get confirmed() { return state.confirmed; }, refresh: refresh, api: api, askPin: askPin, approve: approve, beforeCommand: beforeCommand,
    message: message, OWNER_COMMANDS: OWNER_COMMANDS.slice()
  };

  // Configuración solo para el dueño, por cualquier camino de navegación.
  // Si la tabla de permisos no cargó (sin internet), falla cerrado: solo las pantallas del empleado.
  var EMPLOYEE_SCREENS = ['pageMenu', 'pagePOS', 'pageInventario', 'pageVentas', 'pageClientes', 'pageCaja'];
  function employeeScreen(id) {
    var p = root.NA_PERMISSIONS;
    if (p && typeof p.canAccessScreen === 'function') {
      try { return !!p.canAccessScreen('empleado', id); } catch (_) {}
    }
    return EMPLOYEE_SCREENS.indexOf(id) >= 0;
  }
  function forbidden(id) {
    return !employeeScreen(id) && !canConfigure();
  }
  function backToSale() {
    try { if (root.NA_MENU_NAVIGATION) root.NA_MENU_NAVIGATION.navigate('pagePOS'); else root.goPage('pagePOS'); } catch (_) {}
  }
  function noPermission() {
    if (!state.confirmed && cloud()) { offlineNotice(); return; }
    if (doc.getElementById('naNoPermission') || !doc.body) return;
    var o = doc.createElement('div'); o.id = 'naNoPermission'; o.className = 'na-pin-overlay';
    o.setAttribute('role', 'alertdialog'); o.setAttribute('aria-modal', 'true');
    o.innerHTML = '<div class="na-pin-box"><div class="na-permission-lock" aria-hidden="true">🔒</div><div class="na-pin-title">Sin permiso</div><div class="na-pin-detail">Pídele acceso al dueño</div><div class="na-pin-actions"><button type="button" class="na-pin-ok">Volver a la venta</button></div></div>';
    o.addEventListener('click', function (event) { event.stopPropagation(); });
    o.querySelector('button').onclick = function () { o.remove(); backToSale(); };
    doc.body.appendChild(o);
  }
  function guardConfig() {
    doc.querySelectorAll('.page.active').forEach(function (page) {
      try {
        if (forbidden(page.id)) { page.classList.remove('active'); backToSale(); noPermission(); }
        else if (page.id === 'pageConfig' && !canConfigure()) { page.classList.remove('active'); backToSale(); offlineNotice(); }
      } catch (_) {}
    });
    if (forbidden('ventas:reportes')) {
      var tab = doc.querySelector('#pageVentas [onclick*="reportes"].active');
      if (tab && typeof root.ventasSetTab === 'function') root.ventasSetTab(doc.querySelector('#pageVentas .tab'), 'hoy');
    }
  }
  function wrapNavigation() {
    if (typeof root.goPage === 'function' && !root.goPage.__naPermissions) {
      var go = root.goPage;
      root.goPage = function (id) { if (forbidden(id)) { noPermission(); return false; } return go.apply(this, arguments); };
      root.goPage.__naPermissions = true;
    }
    if (typeof root.ventasSetTab === 'function' && !root.ventasSetTab.__naPermissions) {
      var setTab = root.ventasSetTab;
      root.ventasSetTab = function (btn, tab) { if (tab === 'reportes' && forbidden('ventas:reportes')) { noPermission(); return false; } return setTab.apply(this, arguments); };
      root.ventasSetTab.__naPermissions = true;
    }
  }
  // Solo Configuración y pantallas del dueño fallan cerrado; vender, cobrar y la cola siguen igual.
  function offlineNotice() {
    if (doc.querySelector('.na-offline-cfg')) return;
    var o = doc.createElement('div'); o.className = 'na-offline-cfg na-pin-overlay'; o.setAttribute('role', 'alertdialog'); o.setAttribute('aria-modal', 'true');
    o.innerHTML = '<div class="na-pin-box"><div class="na-pin-title">Confirmando permisos…</div><div class="na-pin-detail">Necesitamos conexión para confirmar tus permisos con el servidor.</div><div class="na-pin-actions"><button type="button" class="na-pin-ok na-role-retry">Reintentar</button><button type="button" class="na-offline-back">Volver a la venta</button></div></div>';
    o.querySelector('.na-offline-back').onclick = function () { o.remove(); backToSale(); };
    o.querySelector('.na-role-retry').onclick = async function () {
      this.disabled = true;
      try { await refresh(); if (state.confirmed) { o.remove(); guardConfig(); } }
      finally { this.disabled = false; }
    };
    doc.body.appendChild(o);
  }
  function install() {
    wrapNavigation();
    if (!install.done && typeof root.MutationObserver === 'function') {
      install.done = true;
      var observer = new root.MutationObserver(guardConfig);
      doc.querySelectorAll('.page').forEach(function (page) { observer.observe(page, { attributes: true, attributeFilter: ['class'] }); });
    }
    guardConfig();
    refresh().then(guardConfig);
  }
  root.addEventListener('load', wrapNavigation);
  root.addEventListener('hashchange', guardConfig);
  root.addEventListener('na:role', guardConfig);
  root.addEventListener('online', function () { refresh(); });
  root.addEventListener('offline', function () { state.confirmed = false; paint(); guardConfig(); });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', install); else install();
})(window);
