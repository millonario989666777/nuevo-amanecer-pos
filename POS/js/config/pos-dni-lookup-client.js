/* Búsqueda de DNI en «Nuevo cliente».
   - Al escribir 8 dígitos se busca primero en los clientes ya guardados: si existe, se abre su ficha (nunca se duplica).
   - Si no existe y hay nube, se pide al servidor (el celular nunca ve la clave del servicio) y se rellena el nombre.
   - Espera máxima de 3 segundos; sin internet o con error, el cajero escribe el nombre a mano y sigue. */
(function (root) {
  'use strict';
  var doc = root.document; if (!doc) return;
  var TIMEOUT_MS = 3000, seq = 0, asked = {}, inflight = null;
  function clean(v) { return String(v == null ? '' : v).trim().replace(/\s+/g, ' '); }
  function legacyList() { try { return Array.isArray(clientes) ? clientes : []; } catch (_) { return []; } } // eslint-disable-line no-undef
  function canonList() {
    try { var s = root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.snapshot && root.NuevoAmanecerCanonical.snapshot(); return Array.isArray(s && s.customers) ? s.customers : []; } catch (_) { return []; }
  }
  function findLocal(dni) {
    var c = legacyList().find(function (x) { return clean(x && x.dni) === dni; });
    if (c) return { id: c.id, name: c.nombre };
    var k = canonList().find(function (x) { return clean(x && x.document) === dni; });
    return k ? { id: k.customer_id, name: k.name } : null;
  }
  function hint(text) {
    var input = doc.getElementById('cDni'); if (!input) return;
    var el = doc.getElementById('cDniHint');
    if (!el) { el = doc.createElement('div'); el.id = 'cDniHint'; el.className = 'na-dni-hint'; el.setAttribute('aria-live', 'polite'); el.style.cssText = 'font-size:12px;margin-top:4px;opacity:.8'; input.insertAdjacentElement('afterend', el); }
    el.textContent = text || ''; el.hidden = !text;
  }
  function call(name) { var a = [].slice.call(arguments, 1); var fn = root[name]; if (typeof fn === 'function') try { return fn.apply(root, a); } catch (_) {} }
  // cerrarModal y toast son «const» del script clásico: no están en window, se llaman por nombre.
  function closeCli() {
    try { if (typeof cerrarModal === 'function') { cerrarModal('mCli'); return; } } catch (_) {} // eslint-disable-line no-undef
    var m = doc.getElementById('mCli'); if (m) m.classList.remove('open');
  }
  function say(msg, kind) {
    try { if (typeof toast === 'function') { toast(msg, kind); return; } } catch (_) {} // eslint-disable-line no-undef
    call('toast', msg, kind);
  }
  function openExisting(found, dni) {
    closeCli();
    var opened = false;
    if (found.id != null && typeof root.naCanonOpenClientAccount === 'function') {
      try { if (typeof root.goPage === 'function') root.goPage('pageClientes'); else call('setModule', 'clientes'); root.naCanonOpenClientAccount(found.id); opened = true; } catch (_) { opened = false; }
    }
    if (!opened) {
      call('setModule', 'clientes');
      var s = doc.getElementById('cliSearch'); if (s) s.value = dni;
      call('cliRender');
      var card = found.id != null && doc.getElementById('cc-' + found.id); if (card) { card.classList.add('open'); opened = true; }
    }
    say(opened ? 'Este DNI ya es de «' + clean(found.name) + '». Se abrió su ficha.' : 'Este DNI ya es de «' + clean(found.name) + '». Búsquelo en Clientes.', 'info');
  }
  var MANUAL = 'No se encontró el nombre. Escríbalo a mano.';
  var SLOW = 'La búsqueda tarda. Escriba el nombre a mano; si llega, se completa solo.';
  function apply(out, dni) {
    var input = doc.getElementById('cDni'), nameEl = doc.getElementById('cNombre');
    if (!input || !nameEl || clean(input.value) !== dni) return;
    if (out.status === 'existing') { hint(''); openExisting({ id: out.customer_id, name: out.name }, dni); return; }
    if (out.status === 'found' && out.name) {
      asked[dni] = { name: out.name };
      if (!clean(nameEl.value)) { nameEl.value = out.name; hint('Nombre encontrado. Puede corregirlo si hace falta.'); }
      else hint('');
      return;
    }
    var reason = String(out.reason || '');
    // Solo se recuerda «sin nombre» cuando el servicio respondió de verdad; un fallo de red se puede reintentar.
    if (reason === 'not_found') asked[dni] = { name: null };
    if (reason === 'no_session') hint('Sesión vencida o aparato desconectado: vuelva a vincular. Escriba el nombre a mano.');
    else if (/limit/.test(reason)) hint('Límite de búsquedas alcanzado. Escriba el nombre a mano.');
    else if (reason === 'not_found') hint(MANUAL);
    else hint('No se pudo buscar ahora. Escriba el nombre a mano.');
  }
  async function check() {
    var input = doc.getElementById('cDni'), nameEl = doc.getElementById('cNombre');
    if (!input || !nameEl) return;
    var modal = doc.getElementById('mCli'); if (modal && !modal.classList.contains('open')) return;
    var dni = clean(input.value).replace(/\D/g, ''), my = ++seq;
    if (!/^\d{8}$/.test(dni) || clean(input.value).length !== 8) { hint(''); return; }
    var local = findLocal(dni);
    if (local) { hint(''); openExisting(local, dni); return; }
    if (clean(nameEl.value)) { hint('Ya hay un nombre escrito. Bórrelo si quiere buscarlo por DNI.'); return; }
    // Igual que pos-roles-client: basta la sesión guardada; no exige que la nube canónica esté marcada.
    if (!root.NA_ROLES || typeof root.NA_ROLES.api !== 'function' || root.navigator.onLine === false) { hint('Sin conexión: escriba el nombre a mano.'); return; }
    if (inflight === dni) return; // input + change + paste del mismo DNI: una sola consulta
    if (asked[dni]) { if (asked[dni].name) { nameEl.value = asked[dni].name; hint(''); } else hint(MANUAL); return; }
    hint('Buscando DNI…');
    var done = false; inflight = dni;
    // A los 3 s el cajero ya puede seguir a mano; si la respuesta llega después, igual se completa el nombre vacío.
    root.setTimeout(function () { if (!done && my === seq) hint(SLOW); }, TIMEOUT_MS);
    var out;
    try { out = await root.NA_ROLES.api('/auth/dni-lookup', { dni: dni }); }
    catch (e) { out = (e && e.data && e.data.status) ? e.data : { status: 'manual', reason: (e && (e.message === 'SIN_SESION' || e.status === 401 || e.status === 403)) ? 'no_session' : 'network' }; }
    done = true; if (inflight === dni) inflight = null;
    if (my !== seq && clean(doc.getElementById('cDni') && doc.getElementById('cDni').value) !== dni) return;
    apply(out, dni);
  }
  function bind() {
    var input = doc.getElementById('cDni'); if (!input || input.dataset.naDni) return;
    input.dataset.naDni = '1'; input.setAttribute('inputmode', 'numeric');
    // Algunos teclados de celular (autocompletar, pegar, dictado) no disparan «input» al final.
    ['input', 'change', 'blur', 'keyup'].forEach(function (ev) { input.addEventListener(ev, function () { check(); }); });
    input.addEventListener('paste', function () { root.setTimeout(check, 0); });
  }
  root.NA_DNI_LOOKUP = { check: check, findLocal: findLocal };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind); else bind();
})(typeof window !== 'undefined' ? window : globalThis);
