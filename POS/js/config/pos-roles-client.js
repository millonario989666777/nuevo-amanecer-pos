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
  async function refresh() {
    if (!cloud()) { setState({ role: 'owner' }); state.ready = true; return state; }
    try {
      var me = await api('/auth/me');
      state.confirmed = true;
      setState({ role: me.pos_role, pinSet: me.owner_pin_set, label: me.label, deviceId: me.device_id }, true);
    } catch (e) {
      state.confirmed = false;
      if (e.status === 401 || e.status === 403) setState({ role: 'unknown' }, true); else paint();
    }
    state.ready = true; return state;
  }

  var PIN_ERRORS = {
    owner_pin_invalid: 'PIN incorrecto.', owner_pin_locked: 'Demasiados intentos. El PIN queda bloqueado 15 minutos.',
    owner_pin_not_set: 'El dueño todavía no configuró su PIN. Pídele que lo cree en Configuración › Usuarios y PIN.',
    pin_format: 'El PIN debe tener de 4 a 8 dígitos.', owner_only: 'Solo el aparato del dueño puede hacer esto.',
    roles_not_ready: 'El servidor aún no tiene activados los roles.', invalid_code: 'Código no válido o vencido.'
  };
  function message(e) { var k = e && (e.message || ''); if (PIN_ERRORS[k]) return PIN_ERRORS[k] + (e.data && e.data.attempts_left ? ' Quedan ' + e.data.attempts_left + ' intentos.' : ''); return 'No se pudo conectar con el servidor. Revisa internet.'; }

  // Ventana para pedir el PIN del dueño. Resuelve con el PIN escrito o null si se cancela.
  function askPin(title, detail) {
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
      wrap.querySelector('.na-pin-ok').onclick = function () { var v = input.value.trim(); if (/^\d{4,8}$/.test(v)) done(v); else wrap.querySelector('.na-pin-msg').textContent = PIN_ERRORS.pin_format; };
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') wrap.querySelector('.na-pin-ok').click(); if (ev.key === 'Escape') done(null); });
      setTimeout(function () { input.focus(); }, 30);
    });
  }
  function toast(msg, kind) { try { root.toast(msg, kind || 'error'); } catch (_) {} }

  // Pide PIN y obtiene una aprobación del servidor. Devuelve approval_id o null.
  async function approve(action, operationId, title, detail) {
    for (var i = 0; i < 3; i++) {
      var pin = await askPin(title, detail);
      if (pin === null) return null;
      try { var r = await api('/auth/owner-approval', { pin: pin, action: action, operation_id: operationId || null }); return r.approval_id; }
      catch (e) { toast(message(e)); if (e.message !== 'owner_pin_invalid') return null; }
    }
    return null;
  }
  var LABELS = { 'inventory.adjust': 'Ajuste de stock', 'adjustment.create': 'Ajuste de dinero', 'compensation.create': 'Anulación',
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
  function guardConfig() {
    var page = doc.getElementById('pageConfig');
    if (!page || !page.classList.contains('active') || canConfigure()) return;
    page.classList.remove('active');
    try { if (root.NA_MENU_NAVIGATION) root.NA_MENU_NAVIGATION.navigate('pagePOS'); else root.goPage('pagePOS'); } catch (_) {}
    if (state.role === 'empleado') toast('Configuración es solo para el dueño.', 'error');
    else offlineNotice();
  }
  // Solo Configuración y pantallas del dueño fallan cerrado; vender, cobrar y la cola siguen igual.
  function offlineNotice() {
    if (doc.querySelector('.na-offline-cfg')) return;
    var o = doc.createElement('div'); o.className = 'na-pin-overlay na-offline-cfg'; o.setAttribute('role', 'dialog');
    var online = root.navigator.onLine !== false;
    o.innerHTML = '<div class="na-pin-box"><div class="na-pin-title">' + (online ? 'Comprobando permisos…' : 'Sin conexión') + '</div>'
      + '<div class="na-pin-detail">' + (online ? 'Configuración se abre cuando el servidor confirma que eres el dueño. Inténtalo de nuevo en unos segundos.' : 'Sin conexión: Configuración necesita internet para confirmar que eres el dueño.') + '</div>'
      + '<div class="na-pin-actions"><button type="button" class="na-pin-ok na-offline-back">Volver a la venta</button></div></div>';
    o.querySelector('.na-offline-back').addEventListener('click', function () { o.remove(); });
    doc.body.appendChild(o);
    if (online) refresh();
  }
  function install() {
    var page = doc.getElementById('pageConfig');
    if (page && !install.done && typeof root.MutationObserver === 'function') {
      install.done = true;
      new root.MutationObserver(guardConfig).observe(page, { attributes: true, attributeFilter: ['class'] });
    }
    guardConfig();
    refresh().then(guardConfig);
  }
  root.addEventListener('na:role', guardConfig);
  root.addEventListener('online', function () { refresh(); });
  root.addEventListener('offline', function () { state.confirmed = false; paint(); guardConfig(); });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', install); else install();
})(window);
