/* Asistente del POS (PROTOTIPO AISLADO). Lógica sin pantalla: privacidad, permisos y confirmación.
   Funciona en el navegador (window.NA_ASISTENTE_CORE) y en Node (pruebas).
   Regla de oro: una propuesta solo se ejecuta con execute(id, {confirmed:true}) llamado desde el
   botón «Confirmar», una sola vez, y usando funciones que el POS ya tiene. */
(function (root) {
  'use strict';
  var PATTERNS = [
    [/\b(pin|clave|contrase(?:ñ|n)a|password|token|api[ _-]?key)\b(\s*(?:es|era|de|:|=)?\s*)[^\s,.;]{3,}/gi, '$1$2[oculto]'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[correo oculto]'],
    [/\b(?:RUC\s*(?:N[°º.]?\s*)?[:#-]?\s*)?(?:10|15|17|20)\d{9}\b/gi, '[RUC oculto]'],
    [/(?:\+?51[\s-]?)?\b9\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g, '[teléfono oculto]'],
    [/\b(?:DNI\s*[:#-]?\s*)?\d{8}\b/gi, '[DNI oculto]']
  ];
  function redactText(v) { var s = String(v == null ? '' : v); PATTERNS.forEach(function (p) { s = s.replace(p[0], p[1]); }); return s; }
  function perms() { return root.NA_PERMISSIONS; }
  function canDo(role, action) { var P = perms(); return !!(P && P.canDo(role, action)); }

  // Contexto que viaja al Worker: solo productos (id, nombre, precio, stock; costo solo si el rol lo ve). Nunca clientes.
  function buildContext(productos, role, screen, query) {
    var list = Array.isArray(productos) ? productos : [];
    var q = String(query || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    var words = q.split(/\s+/).filter(function (w) { return w.length >= 4; });
    function score(p) { var n = String(p.name || p.nombre || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); return words.some(function (w) { return n.indexOf(w) >= 0; }) ? 1 : 0; }
    var ranked = list.slice().sort(function (a, b) { return score(b) - score(a); }).slice(0, 80);
    var costs = canDo(role, 'purchases.costs.view');
    return { screen: screen || null, products: ranked.map(function (p) {
      var o = { id: String(p.id), nombre: redactText(String(p.name || p.nombre || '')).slice(0, 80), precio: Number(p.precio) || 0, stock: Number(p.stock) || 0 };
      if (costs && Number(p.costo) > 0) o.costo = Number(p.costo);
      return o;
    }) };
  }

  // ¿Puede ESTA persona ejecutar ESTA propuesta? (el Worker ya filtró; esto es la segunda barrera)
  function canExecute(roles, proposal) {
    var role = roles && roles.role;
    if (role !== 'owner' && role !== 'empleado') return { ok: false, msg: 'No se sabe quién usa este aparato. Revisa la conexión.' };
    if (!proposal || !proposal.type) return { ok: false, msg: 'Propuesta no válida.' };
    if (proposal.type === 'precio') {
      var ownerOk = canDo(role, 'assistant.price.propose') && (!roles.isOwner || roles.isOwner());
      if (!ownerOk) return { ok: false, msg: 'Solo el dueño puede cambiar precios.' };
    }
    if (['venta', 'compra', 'precio', 'documento', 'pasos'].indexOf(proposal.type) < 0) return { ok: false, msg: 'Acción desconocida.' };
    return { ok: true };
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function soles(n) { return n == null || !isFinite(n) ? '-' : 'S/ ' + Number(n).toFixed(2); }

  // Documento interno imprimible. Siempre marcado como NO comprobante SUNAT.
  function documentHtml(p, business) {
    var total = 0;
    var rows = (p.lineas || []).map(function (l) { var sub = l.precio != null ? l.precio * (l.cantidad || 1) : null; if (sub != null) total += sub;
      return '<tr><td>' + esc(l.cantidad || 1) + '</td><td>' + esc(l.nombre) + '</td><td class="r">' + soles(l.precio) + '</td><td class="r">' + soles(sub) + '</td></tr>'; }).join('');
    return '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>' + esc(p.title) + '</title><style>' +
      'body{font:15px/1.4 system-ui,sans-serif;margin:24px;color:#0f172a}h1{font-size:20px;margin:0 0 4px}.w{border:2px dashed #b91c1c;color:#b91c1c;padding:6px 10px;font-weight:800;margin:10px 0;text-align:center}' +
      'table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #cbd5e1;padding:6px 4px;text-align:left}.r{text-align:right}tfoot td{font-weight:800}</style></head><body>' +
      '<h1>' + esc(business || 'Botica Nuevo Amanecer') + '</h1><div>' + esc(p.title) + ' · ' + esc(new Date().toLocaleDateString('es-PE')) + '</div>' +
      '<div class="w">DOCUMENTO INTERNO DE PRUEBA · NO ES COMPROBANTE SUNAT</div>' +
      '<table><thead><tr><th>Cant.</th><th>Descripción</th><th class="r">P. unit.</th><th class="r">Importe</th></tr></thead><tbody>' + rows + '</tbody>' +
      (p.tipo === 'lista_precios' ? '' : '<tfoot><tr><td></td><td>Total</td><td></td><td class="r">' + soles(total) + '</td></tr></tfoot>') + '</table>' +
      (p.nota ? '<p>' + esc(p.nota) + '</p>' : '') + '</body></html>';
  }

  // Ejecutores: usan SOLO funciones existentes del POS, inyectadas (deps) para poder probarlos.
  var EXECUTORS = {
    venta: function (p, d) {
      var added = 0, fails = [];
      (p.lineas || []).forEach(function (l) {
        var prod = (d.productos() || []).find(function (x) { return String(x.id) === String(l.product_id); });
        if (!prod) { fails.push(l.nombre); return; }
        for (var i = 0; i < l.cantidad; i++) { if (d.posAdd(prod.id) === false) { fails.push(l.nombre); break; } added++; }
      });
      d.navigate('pagePOS');
      return { ok: added > 0, msg: added ? 'Agregué ' + added + ' unidad(es) al carrito. Revisa y pulsa Cobrar.' + (fails.length ? ' No se pudo: ' + fails.join(', ') + '.' : '') : 'No se pudo agregar: ' + fails.join(', ') + '.' };
    },
    compra: function (p, d) {
      var w = d.openPurchase();
      if (!w) return { ok: false, msg: 'No se pudo abrir «Nueva compra».' };
      d.fillPurchase(w, p);
      return { ok: true, msg: 'Abrí «Nueva compra» con ' + p.lineas.length + ' línea(s). Revisa y pulsa «Registrar compra».' };
    },
    precio: function (p, d) {
      var prod = (d.productos() || []).find(function (x) { return String(x.id) === String(p.product_id); });
      if (!prod) return { ok: false, msg: 'Ese producto ya no está en el inventario.' };
      d.openPriceEditor(prod.id, p.precio_nuevo);
      return { ok: true, msg: 'Abrí la ficha de ' + prod.name + ' con el precio nuevo. Pulsa Guardar para aplicarlo.' };
    },
    documento: function (p, d) { d.showDocument(documentHtml(p, d.businessName && d.businessName()), p); return { ok: true, msg: 'Vista previa lista. No es comprobante SUNAT.' }; },
    pasos: function (p, d) { if (p.pantalla) d.navigate(p.pantalla); return { ok: true, msg: 'Te llevé a la pantalla.' }; }
  };

  // Puerta de confirmación. execute() es asíncrono:
  // 1) exige confirmed:true (solo lo pasa el botón «Confirmar»);
  // 2) revisa el rol en el aparato (segunda barrera);
  // 3) pide al Worker que gaste el token de un solo uso (deps.confirm). El token trae un operation_id
  //    creado UNA vez; si se corta la señal se reenvía el MISMO token y el Worker devuelve el mismo id;
  // 4) recién entonces llama a las funciones existentes del POS. Un doble toque comparte la misma promesa.
  function createGate(deps) {
    var items = Object.create(null);
    async function run(it) {
      var perm = canExecute(deps.roles(), it.p);
      if (!perm.ok) { it.state = 'denied'; return perm; }
      if (deps.online && !deps.online()) { it.state = 'pending'; return { ok: false, msg: 'Asistente no disponible sin internet.' }; }
      if (it.p.needsConfirm) {
        if (!it.p.confirm_token) { it.state = 'denied'; return { ok: false, msg: 'Esta propuesta no se puede confirmar (falta el permiso del servidor).' }; }
        var c;
        try { c = await deps.confirm(it.p, it.review || null); } catch (e) { it.state = 'pending'; return { ok: false, retry: true, msg: 'Se cortó la conexión. Pulsa Confirmar otra vez: no se duplicará.' }; }
        if (!c || !c.ok) { it.state = (c && (c.error === 'confirm_expired' || c.error === 'forbidden_role' || c.error === 'proposal_changed')) ? 'denied' : 'pending';
          return { ok: false, msg: ({ confirm_expired: 'La propuesta venció (5 min). Pídela otra vez.', forbidden_role: 'Solo el dueño puede hacer esto.', proposal_changed: 'La propuesta cambió. Pídela otra vez.', review_required: 'Revisa las filas marcadas antes de confirmar.', owner_approval_required: 'Falta el PIN del dueño.', proposal_id_mismatch: 'La propuesta no coincide. Pídela otra vez.', rate_limited: 'Espera un momento antes de confirmar otra.' })[c && c.error] || 'El servidor no aceptó la confirmación.' }; }
        it.operationId = c.operation_id;
        // Se aplica la propuesta que el servidor verificó para ESTE token, nunca otra que esté en memoria.
        if (c.proposal) { if (c.proposal.id !== it.p.id || c.proposal.type !== it.p.type) { it.state = 'denied'; return { ok: false, msg: 'La propuesta no coincide. Pídela otra vez.' }; } it.applied = c.proposal; }
        if (c.already_confirmed && it.executed) { it.state = 'done'; return { ok: true, msg: 'Ya se hizo. No se repitió.' }; }
      }
      if (it.executed) { it.state = 'done'; return { ok: true, msg: 'Ya se hizo. No se repitió.' }; }
      try {
        var r = EXECUTORS[it.p.type](it.applied || it.p, deps, it.operationId);
        if (r.ok) it.executed = true;
        it.state = r.ok ? 'done' : 'pending'; return r;
      } catch (e) { it.state = 'pending'; return { ok: false, msg: 'No se pudo completar. Inténtalo otra vez.' }; }
    }
    return {
      // Cada tarjeta tiene su propia entrada (clave = id firmado por el servidor). Si llegara un id repetido con OTRO token,
      // se le da una clave nueva: nunca se reutiliza la propuesta de otra tarjeta.
      add: function (p) {
        if (!p || !p.id) return null;
        var key = String(p.id), n = 1;
        while (items[key] && items[key].p.confirm_token !== p.confirm_token) key = p.id + '#' + (++n);
        if (!items[key]) items[key] = { p: p, key: key, state: 'pending', executed: false, operationId: null, inflight: null, applied: null, review: null };
        return key;
      },
      proposal: function (key) { return items[key] ? items[key].p : null; },
      state: function (id) { return items[id] ? items[id].state : null; },
      operationId: function (id) { return items[id] ? items[id].operationId : null; },
      cancel: function (id) { if (items[id] && items[id].state === 'pending') items[id].state = 'cancelled'; },
      execute: function (id, opts) {
        var it = items[id];
        if (!it) return Promise.resolve({ ok: false, msg: 'Propuesta no encontrada.' });
        if (!opts || opts.confirmed !== true) return Promise.resolve({ ok: false, msg: 'Falta confirmar.' });
        if (it.inflight) return it.inflight;
        if (it.state === 'done') return Promise.resolve({ ok: true, msg: 'Ya se hizo. No se repitió.' });
        if (it.state !== 'pending') return Promise.resolve({ ok: false, msg: it.state === 'cancelled' ? 'Se canceló.' : 'No permitido.' });
        if (opts.review) it.review = opts.review;
        it.state = 'running';
        it.inflight = run(it).finally(function () { it.inflight = null; });
        return it.inflight;
      }
    };
  }

  var api = { redactText: redactText, buildContext: buildContext, canExecute: canExecute, createGate: createGate, documentHtml: documentHtml, EXECUTORS: EXECUTORS, soles: soles, esc: esc };
  root.NA_ASISTENTE_CORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
