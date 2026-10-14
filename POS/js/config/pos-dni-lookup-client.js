/* Búsqueda de DNI en «Nuevo cliente».
   - Al escribir 8 dígitos se busca primero en los clientes ya guardados: si existe, se abre su ficha (nunca se duplica).
   - Si no existe y hay nube, se pide al servidor (el celular nunca ve la clave del servicio) y se rellena el nombre.
   - Espera máxima de 3 segundos; sin internet o con error, el cajero escribe el nombre a mano y sigue. */
(function (root) {
  'use strict';
  var doc = root.document; if (!doc) return;
  var TIMEOUT_MS = 3000, COOLDOWN_MS = 45000, seq = 0, asked = {}, inflight = null, failedAt = {};
  function clean(v) { return String(v == null ? '' : v).trim().replace(/\s+/g, ' '); }
  function legacyList() { try { return Array.isArray(clientes) ? clientes : []; } catch (_) { return []; } } // eslint-disable-line no-undef
  function canonList() {
    try { var s = root.NuevoAmanecerCanonical && root.NuevoAmanecerCanonical.snapshot && root.NuevoAmanecerCanonical.snapshot(); return Array.isArray(s && s.customers) ? s.customers : []; } catch (_) { return []; }
  }
  function digits(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }
  // RUC: dígito verificador módulo 11 (pesos 5432765432).
  function rucOk(ruc) {
    if (!/^(?:10|15|17|20)\d{9}$/.test(ruc)) return false;
    var w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2], sum = 0;
    for (var i = 0; i < 10; i++) sum += Number(ruc[i]) * w[i];
    return (11 - (sum % 11)) % 10 === Number(ruc[10]);
  }
  function ruc10(dni) { for (var d = 0; d < 10; d++) if (rucOk('10' + dni + d)) return '10' + dni + d; return null; }
  // Mismo titular: RUC 10 ⇄ su DNI (dígitos 3-10). Evita clientes duplicados también sin internet.
  function aliases(doc) {
    if (doc.length === 11 && doc.slice(0, 2) === '10') return [doc, doc.slice(2, 10)];
    if (doc.length === 8) { var r = ruc10(doc); return r ? [doc, r] : [doc]; }
    return [doc];
  }
  function findLocal(dni) {
    var keys = aliases(dni);
    var c = legacyList().find(function (x) { return keys.indexOf(digits(x && x.dni)) >= 0; });
    if (c) return { id: c.id, name: c.nombre };
    var k = canonList().find(function (x) { return keys.indexOf(digits(x && x.document)) >= 0; });
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
    var kind = dni.length === 11 ? 'RUC' : 'DNI';
    say(opened ? 'Este ' + kind + ' ya es de «' + clean(found.name) + '». Se abrió su ficha.' : 'Este ' + kind + ' ya es de «' + clean(found.name) + '». Búsquelo en Clientes.', 'info');
  }
  // RUC: la dirección fiscal se escribe si el campo está vacío o aún tiene la que puso una búsqueda anterior (sin editar).
  var filledAddress = '';
  function fillAddress(address) {
    var el = doc.getElementById('cDir'); if (!el) return;
    var cur = clean(el.value), auto = filledAddress && cur === filledAddress;
    if (address && (!cur || auto)) { el.value = address; filledAddress = clean(address); }
    else if (auto) { el.value = ''; filledAddress = ''; }
  }
  function isRuc(dni) { return dni.length === 11; }
  function manualMsg(dni) { return isRuc(dni) ? 'No se encontró la razón social. Escríbala a mano.' : 'No se encontró el nombre. Escríbalo a mano.'; }
  // Para RUC se habla de razón social.
  function what(dni) { return dni && dni.length === 11 ? 'la razón social' : 'el nombre'; }
  function slowMsg(dni) { return 'La búsqueda tarda. Escriba ' + what(dni) + ' a mano; si llega, se completa ' + (dni && dni.length === 11 ? 'sola.' : 'solo.'); }
  function apply(out, dni) {
    var input = doc.getElementById('cDni'), nameEl = doc.getElementById('cNombre');
    if (!input || !nameEl || digits(input.value) !== dni) return;
    if (out.status === 'existing') { hint(''); openExisting({ id: out.customer_id, name: out.name }, dni); return; }
    if (out.status === 'found' && out.name) {
      asked[dni] = { name: out.name, address: out.address || '' };
      if (!clean(nameEl.value)) { nameEl.value = out.name; hint(dni.length === 11 ? 'Razón social encontrada. Puede corregirla si hace falta.' : 'Nombre encontrado. Puede corregirlo si hace falta.'); }
      else hint('');
      fillAddress(out.address);
      return;
    }
    var reason = String(out.reason || '');
    // Solo se recuerda «sin nombre» cuando el servicio respondió de verdad; un fallo de red se puede reintentar.
    if (reason === 'not_found') asked[dni] = { name: null };
    if (reason === 'no_session') hint('Sesión vencida o aparato desconectado: vuelva a vincular. Escriba ' + what(dni) + ' a mano.');
    else if (/limit/.test(reason)) { failedAt[dni] = { at: Date.now(), limit: true }; hint(limitMsg(dni)); }
    else if (reason === 'not_found') hint(manualMsg(dni));
    else { failedAt[dni] = { at: Date.now(), limit: false }; retryHint(dni); }
  }
  function limitMsg(dni) { return 'Límite de búsquedas alcanzado. Escriba ' + what(dni) + ' a mano.'; }
  function retryHint(dni) {
    var el = doc.getElementById('cDniHint');
    // Mismo DNI y el botón ya está: no se repinta (si no, el blur lo recrea y el clic se pierde).
    if (el && el.dataset.naRetry === dni && el.querySelector('button')) return;
    hint('No se pudo buscar ahora. Escriba ' + what(dni) + ' a mano o ');
    el = doc.getElementById('cDniHint'); if (!el) return;
    el.dataset.naRetry = dni;
    var btn = doc.createElement('button'); btn.type = 'button'; btn.textContent = 'Reintentar';
    btn.style.cssText = 'border:0;background:none;padding:0;color:inherit;text-decoration:underline;font:inherit;cursor:pointer';
    var go = function (e) { if (e && e.preventDefault) e.preventDefault(); if (!failedAt[dni]) return; delete failedAt[dni]; check(); };
    btn.addEventListener('pointerdown', go); btn.addEventListener('click', go);
    el.appendChild(btn);
  }
  async function check() {
    var input = doc.getElementById('cDni'), nameEl = doc.getElementById('cNombre');
    if (!input || !nameEl) return;
    var modal = doc.getElementById('mCli'); if (modal && !modal.classList.contains('open')) return;
    // Solo cuentan los dígitos: «10-78203419-2» pegado vale como RUC. DNI = 8 dígitos, RUC = 11.
    var dni = digits(input.value), my = ++seq;
    // Pegado con guiones/espacios/puntos: el campo queda solo con dígitos, así el cliente se guarda limpio.
    if ((dni.length === 8 || dni.length === 11) && input.value !== dni && /^[\d\s.\-]+$/.test(input.value)) input.value = dni;
    if (!/^(?:\d{8}|\d{11})$/.test(dni)) { hint(''); return; }
    if (isRuc(dni) && !rucOk(dni)) { hint('RUC inválido. Revise los 11 dígitos.'); return; }
    var local = findLocal(dni);
    if (local) { hint(''); openExisting(local, dni); return; }
    // keyup/blur/change del mismo DNI: ni consulta repetida ni aviso que pise «Buscando…» / «La búsqueda tarda».
    if (inflight === dni) return;
    // El nombre es el que se acaba de encontrar para este DNI: no repetir ni avisar «Ya hay un nombre escrito».
    if (asked[dni] && asked[dni].name && clean(nameEl.value) === clean(asked[dni].name)) return;
    if (clean(nameEl.value)) { hint(isRuc(dni) ? 'Ya hay una razón social escrita. Bórrela si quiere buscarla por RUC.' : 'Ya hay un nombre escrito. Bórrelo si quiere buscarlo por DNI.'); return; }
    // Igual que pos-roles-client: basta la sesión guardada; no exige que la nube canónica esté marcada.
    if (!root.NA_ROLES || typeof root.NA_ROLES.api !== 'function' || root.navigator.onLine === false) { hint('Sin conexión: escriba ' + what(dni) + ' a mano.'); return; }
    if (asked[dni]) { if (asked[dni].name) { nameEl.value = asked[dni].name; fillAddress(asked[dni].address); hint(''); } else hint(manualMsg(dni)); return; }
    // Tras un error del servicio o de red no se vuelve a consultar en cada tecla: espera 45 s o «Reintentar».
    if (failedAt[dni] && Date.now() - failedAt[dni].at < COOLDOWN_MS) { if (failedAt[dni].limit) hint(limitMsg(dni)); else retryHint(dni); return; }
    hint(dni.length === 11 ? 'Buscando RUC…' : 'Buscando DNI…');
    var done = false; inflight = dni;
    // A los 3 s el cajero ya puede seguir a mano; si la respuesta llega después, igual se completa el nombre vacío.
    root.setTimeout(function () { if (!done && inflight === dni) hint(slowMsg(dni)); }, TIMEOUT_MS);
    var out;
    try { out = await root.NA_ROLES.api('/auth/dni-lookup', { dni: dni }); }
    catch (e) { out = (e && e.data && e.data.status) ? e.data : { status: 'manual', reason: (e && (e.message === 'SIN_SESION' || e.status === 401 || e.status === 403)) ? 'no_session' : 'network' }; }
    done = true; if (inflight === dni) inflight = null;
    if (my !== seq && digits(doc.getElementById('cDni') && doc.getElementById('cDni').value) !== dni) return;
    apply(out, dni);
  }
  function bind() {
    var input = doc.getElementById('cDni'); if (!input || input.dataset.naDni) return;
    input.dataset.naDni = '1'; input.setAttribute('inputmode', 'numeric');
    // Algunos teclados de celular (autocompletar, pegar, dictado) no disparan «input» al final.
    ['input', 'change', 'blur', 'keyup'].forEach(function (ev) { input.addEventListener(ev, function () { check(); }); });
    input.addEventListener('paste', function () { root.setTimeout(check, 0); });
  }
  root.NA_DNI_LOOKUP = { check: check, findLocal: findLocal, rucOk: rucOk };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', bind); else bind();
})(typeof window !== 'undefined' ? window : globalThis);
