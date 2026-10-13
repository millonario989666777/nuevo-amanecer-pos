/* Búsqueda de DNI en «Nuevo cliente».
   - Al escribir 8 dígitos se busca primero en los clientes ya guardados: si existe, se abre su ficha (nunca se duplica).
   - Si no existe y hay nube, se pide al servidor (el celular nunca ve la clave del servicio) y se rellena el nombre.
   - Espera máxima de 3 segundos; sin internet o con error, el cajero escribe el nombre a mano y sigue. */
(function (root) {
  'use strict';
  var doc = root.document; if (!doc) return;
  var TIMEOUT_MS = 3000, seq = 0, asked = {};
  function clean(v) { return String(v == null ? '' : v).trim().replace(/\s+/g, ' '); }
  function cloud() { try { return !!(root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.enabled()); } catch (_) { return false; } }
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
  function openExisting(found, dni) {
    call('cerrarModal', 'mCli');
    call('setModule', 'clientes');
    var s = doc.getElementById('cliSearch'); if (s) s.value = dni;
    call('cliRender');
    var card = found.id != null && doc.getElementById('cc-' + found.id); if (card) card.classList.add('open');
    call('toast', 'Este DNI ya es de «' + clean(found.name) + '». Se abrió su ficha.', 'info');
  }
  function withTimeout(p) {
    return Promise.race([p, new Promise(function (_, rej) { root.setTimeout(function () { rej(new Error('TIMEOUT')); }, TIMEOUT_MS); })]);
  }
  var MANUAL = 'No se encontró el nombre. Escríbalo a mano.';
  async function check() {
    var input = doc.getElementById('cDni'), nameEl = doc.getElementById('cNombre');
    if (!input || !nameEl) return;
    var dni = clean(input.value), my = ++seq;
    if (!/^\d{8}$/.test(dni)) { hint(''); return; }
    var local = findLocal(dni);
    if (local) { hint(''); openExisting(local, dni); return; }
    if (clean(nameEl.value)) { hint(''); return; }
    if (!cloud() || !root.NA_ROLES || root.navigator.onLine === false) { hint('Sin conexión: escriba el nombre a mano.'); return; }
    if (asked[dni]) { if (asked[dni].name) { nameEl.value = asked[dni].name; hint(''); } else hint(MANUAL); return; }
    hint('Buscando DNI…');
    var out;
    try { out = await withTimeout(root.NA_ROLES.api('/auth/dni-lookup', { dni: dni })); }
    catch (e) { out = (e && e.data) || { status: 'manual' }; }
    if (my !== seq || clean(input.value) !== dni) return;
    if (out.status === 'existing') { hint(''); openExisting({ id: out.customer_id, name: out.name }, dni); return; }
    if (out.status === 'found' && out.name) {
      asked[dni] = { name: out.name };
      if (!clean(nameEl.value)) nameEl.value = out.name;
      hint('Nombre encontrado. Puede corregirlo si hace falta.'); return;
    }
    if (out.reason !== 'timeout' && out.reason !== 'provider_error') asked[dni] = { name: null };
    hint(/limit/.test(String(out.reason || '')) ? 'Límite de búsquedas alcanzado. Escriba el nombre a mano.' : MANUAL);
  }
  function bind() {
    var input = doc.getElementById('cDni'); if (!input || input.dataset.naDni) return;
    input.dataset.naDni = '1'; input.setAttribute('inputmode', 'numeric');
    input.addEventListener('input', function () { check(); });
  }
  root.NA_DNI_LOOKUP = { check: check, findLocal: findLocal };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind); else bind();
})(typeof window !== 'undefined' ? window : globalThis);
