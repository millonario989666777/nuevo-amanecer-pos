/* Asistente del POS (PROTOTIPO AISLADO, SOLO DUEÑO / modo admin). Lógica sin pantalla: privacidad, permisos y confirmación.
   No vende ni llena el carrito.
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
    return capContext({ screen: screen || null, products: ranked.map(function (p) {
      var o = { id: String(p.id), nombre: redactText(String(p.name || p.nombre || '')).slice(0, 60), precio: Number(p.precio) || 0, stock: Number(p.stock) || 0 };
      if (costs && Number(p.costo) > 0) o.costo = Number(p.costo);
      if (!tracksStock(p)) o.controla = false;
      return o;
    }) }, 2000, 25);
  }

  // ¿Puede ESTE aparato ejecutar ESTA propuesta? (el Worker ya filtró y vuelve a revisar al confirmar; esto es la segunda barrera).
  // Dueño: sí. Empleado: solo si el SERVIDOR le dio un nivel (roles.level viene del último ping, nunca de una caché local);
  // y aun así NO recibe tarjetas que cambian algo (solo el dueño confirma). Documentos del empleado: solo lista de precios y pedido.
  var TYPES = ['compra', 'precio', 'costo', 'ajuste', 'producto', 'documento', 'consulta', 'pasos'];
  var EMP_LEVELS = ['consultas', 'consultas_documentos'], EMP_DOCS = ['lista_precios', 'lista_pedido'];
  function canExecute(roles, proposal) {
    var role = roles && roles.role;
    if (role !== 'owner' && role !== 'empleado') return { ok: false, msg: 'No se sabe quién usa este aparato. Revisa la conexión.' };
    if (role === 'owner' && roles.isOwner && !roles.isOwner()) return { ok: false, msg: 'El asistente es solo para el dueño.' };
    if (role === 'empleado') {
      if (EMP_LEVELS.indexOf(roles.level) < 0) return { ok: false, msg: 'El asistente es solo para el dueño.' };
      if (proposal && proposal.type === 'costo') return { ok: false, msg: 'Solo el dueño puede cambiar costos.' };
      if (proposal && (proposal.needsConfirm || ['compra', 'precio', 'ajuste', 'producto'].indexOf(proposal.type) >= 0)) return { ok: false, msg: 'Los cambios los hace el dueño desde su teléfono.' };
      if (proposal && proposal.type === 'documento' && (roles.level !== 'consultas_documentos' || EMP_DOCS.indexOf(proposal.tipo) < 0)) return { ok: false, msg: 'Ese documento es solo para el dueño.' };
    }
    if (!proposal || TYPES.indexOf(proposal.type) < 0) return { ok: false, msg: 'Acción desconocida.' };
    return { ok: true };
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function soles(n) { return n == null || !isFinite(n) ? '-' : 'S/ ' + Number(n).toFixed(2); }

  // ---------- Documentos internos (solo lectura, armados en el aparato con datos que el POS ya tiene) ----------
  // Siempre marcados «NO ES COMPROBANTE SUNAT». Nunca emiten nada fiscal ni escriben datos.
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function maskDoc(d) { var s = String(d || '').replace(/\s/g, ''); return s.length >= 4 ? '****' + s.slice(-4) : (s ? '****' : '-'); }
  function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
  function pname(p) { return p.name || p.nombre || ''; }
  function tracks(p) { return p.controlInventario !== false && p.tracksInventory !== false; }
  function inRange(f, d, h) { f = String(f || '').slice(0, 10); return (!d || f >= d) && (!h || f <= h); }
  function docShell(title, sub, head, rows, foot, note, business) {
    return '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
      'body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#0f172a}h1{font-size:20px;margin:0 0 2px}.s{color:#334155;margin-bottom:6px}.w{border:2px dashed #b91c1c;color:#991b1b;padding:6px 10px;font-weight:800;margin:10px 0;text-align:center}' +
      'table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #cbd5e1;padding:6px 4px;text-align:left}th{background:#f1f5f9}.r{text-align:right}tfoot td{font-weight:800}.n{color:#334155;font-size:12px;margin-top:10px}@media print{.w{border-color:#000;color:#000}}</style></head><body>' +
      '<h1>' + esc(business || 'Botica Nuevo Amanecer') + '</h1><div class="s">' + esc(title) + (sub ? ' · ' + esc(sub) : '') + ' · Generado ' + esc(new Date().toLocaleString('es-PE')) + '</div>' +
      '<div class="w">DOCUMENTO INTERNO · NO ES COMPROBANTE SUNAT</div>' +
      '<table><thead><tr>' + head.map(function (h, i) { return '<th' + (i && h.r ? ' class="r"' : '') + '>' + esc(h.t || h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      (rows.length ? rows.map(function (r) { return '<tr>' + r.map(function (c, i) { return '<td' + (head[i] && head[i].r ? ' class="r"' : '') + '>' + esc(c) + '</td>'; }).join('') + '</tr>'; }).join('') : '<tr><td colspan="' + head.length + '">Sin datos.</td></tr>') +
      '</tbody>' + (foot ? '<tfoot><tr>' + foot.map(function (c, i) { return '<td' + (head[i] && head[i].r ? ' class="r"' : '') + '>' + esc(c) + '</td>'; }).join('') + '</tr></tfoot>' : '') + '</table>' +
      (note ? '<div class="n">' + esc(note) + '</div>' : '') + '</body></html>';
  }
  var R = function (t) { return { t: t, r: true }; };
  // Avisos heredados de Reportes (ver docs/asistente/PLAN.md). Van al pie del documento donde aplican.
  var KNOWN = { caja: 'Aviso heredado de Reportes: el flujo de caja todavía no separa bien efectivo y pagos digitales.', costo: 'Aviso heredado: registrar una compra no actualiza el costo del producto; el valor al costo puede estar desfasado.' };
  function unavailable(p, what, business) { return { title: p.title, rows: 0, html: docShell(p.title, null, ['Detalle'], [], null, 'No disponible: falta ' + what + ' en este aparato.', business) }; }
  // Los documentos usan los MISMOS cálculos que las pantallas del POS (data.api): así el PDF sale igual que la pantalla al céntimo.
  // El asistente no hace cuentas propias de dinero, solo da formato.
  async function buildDocument(p, data, business) {
    data = data || {}; var api = data.api || {}, prods = data.productos || [], d = p.desde || null, h = p.hasta || p.desde || null;
    // Aparato de empleado: filas armadas por el SERVIDOR (sin costos). No se usan los datos locales del aparato.
    if (p.data) {
      if (p.data.error || !Array.isArray(p.data.filas)) return unavailable(p, 'la lista del servidor', business);
      var er = p.data.filas.map(function (f) { return f.map(function (v, i) { return p.tipo === 'lista_precios' && i === 1 ? soles(num(v)) : v; }); });
      var eh = (p.data.columnas || []).map(function (c, i) { return i ? R(c) : c; });
      return { title: p.title, rows: er.length, html: docShell(p.title, p.tipo === 'lista_pedido' ? 'Lista de pedido para proveedor' : null, eh, er, null,
        (p.tipo === 'lista_pedido' ? 'Cantidad sugerida: hasta el doble del mínimo. Revísala antes de pedir.' : 'Precios de venta de la ficha de cada producto.') + (p.data.truncado ? ' Lista larga: se muestran los primeros productos.' : ''), business) };
    }
    if (p.tipo === 'inventario_valorizado') {
      if (typeof api.valorizacion !== 'function') return unavailable(p, 'el reporte de Valorización', business);
      var rep = api.valorizacion(prods), t = rep.totals || {};
      var rows = (rep.rows || rep.categories || []).map(function (r) { return [r.category || r.key || '-', num(r.products), num(r.units), soles(num(r.costValue)), soles(num(r.saleValue))]; });
      return { title: p.title, rows: rows.length, html: docShell(p.title, 'Mismo cálculo que Valorización de inventario', ['Categoría', R('Productos'), R('Unidades'), R('Valor costo'), R('Valor venta')], rows,
        ['Total', num(t.products), num(t.units), soles(num(t.costValue)), soles(num(t.saleValue))], (t.noCostProducts ? t.noCostProducts + ' producto(s) sin costo: el valor al costo está incompleto. ' : '') + KNOWN.costo, business) };
    }
    if (p.tipo === 'lista_precios') {
      var lr = prods.slice().sort(function (a, b) { return pname(a).localeCompare(pname(b)); }).map(function (x) { return [pname(x), soles(num(x.precio)), x.precioCaja ? soles(num(x.precioCaja)) : '-']; });
      return { title: p.title, rows: lr.length, html: docShell(p.title, null, ['Producto', R('Precio'), R('Precio caja')], lr, null, 'Precios de la ficha de cada producto.', business) };
    }
    if (p.tipo === 'lista_pedido') {
      // Mismo criterio que el aviso de stock bajo del inventario: stock en o bajo el mínimo. La cantidad sugerida es solo una ayuda.
      var rr = prods.filter(function (x) { return tracks(x) && (num(x.stock) <= 0 || num(x.stock) <= num(x.stockMin)); })
        .sort(function (a, b) { return (num(a.stock) - num(a.stockMin)) - (num(b.stock) - num(b.stockMin)); })
        .map(function (x) { var q = Math.max(1, Math.ceil(num(x.stockMin) * 2 - num(x.stock))), c = num(x.costo); return [pname(x), num(x.stock), num(x.stockMin), q, c > 0 ? soles(c) : '-', c > 0 ? soles(c * q) : '-', c > 0 ? Math.round(c * q * 100) : 0]; });
      // Versión del dueño: con costo de referencia e inversión estimada (la del empleado no los trae).
      var inv = rr.reduce(function (a, r) { return a + r.pop(); }, 0);
      return { title: p.title, rows: rr.length, html: docShell(p.title, 'Lista de pedido para proveedor', ['Producto', R('Stock'), R('Mínimo'), R('Pedir'), R('Costo ref.'), R('Inversión')], rr, ['Total estimado', '', '', '', '', soles(inv / 100)], 'Cantidad sugerida: hasta el doble del mínimo. Revísala antes de pedir. ' + KNOWN.costo, business) };
    }
    if (p.tipo === 'reporte_ventas') {
      if (typeof api.totalV !== 'function') return unavailable(p, 'el cálculo de Ventas', business);
      // Igual que la pantalla Ventas: excluye anuladas (v.anulada) y suma totalV(v).
      var vs = (data.ventas || []).filter(function (v) { return !v.anulada && inRange(v.fecha, d, h); }), byDay = {}, byM = {}, total = 0;
      vs.forEach(function (v) { var f = String(v.fecha).slice(0, 10), tv = num(api.totalV(v)), m = v.metodo || 'otro'; total += tv; byDay[f] = (byDay[f] || 0) + tv; byM[m] = (byM[m] || 0) + tv; });
      var vr = Object.keys(byDay).sort().map(function (k) { return ['Día ' + k, soles(byDay[k])]; }).concat(Object.keys(byM).sort().map(function (k) { return ['Método: ' + k, soles(byM[k])]; }));
      return { title: p.title, rows: vs.length, html: docShell(p.title, (d || 'todas') + (h && h !== d ? ' a ' + h : ''), ['Detalle', R('S/')], vr, ['Total (' + vs.length + ' ventas)', soles(total)], 'Mismo cálculo que la pantalla Ventas (sin anuladas). ' + KNOWN.caja, business) };
    }
    if (p.tipo === 'estado_cuenta') {
      if (typeof api.summarizeClient !== 'function' || typeof api.effectiveBalance !== 'function') return unavailable(p, 'el resumen de créditos', business);
      var words = norm(p.cliente).split(/\s+/).filter(function (w) { return w.length >= 3; });
      var cli = words.length ? (data.clientes || []).find(function (c) { var n = norm(c.nombre || c.name); return words.every(function (w) { return n.indexOf(w) >= 0; }); }) : null;
      if (!cli) return { title: p.title, rows: 0, html: docShell(p.title, 'Cliente no encontrado', ['Detalle'], [], null, 'Escribe el nombre del cliente como está en Clientes.', business) };
      // Igual que Deudas de clientes: summarizeClient(cliente, solo lectura) + effectiveBalance (pagos en cola incluidos).
      var sum = api.summarizeClient(cli, true), saldo = num(api.effectiveBalance(sum, api.pending ? api.pending() : null));
      var cr = (sum.active || []).map(function (c) { return [c.desc || c.concepto || c.tipo || 'Crédito', soles(num(c.monto)), soles(num(c.pagado)), soles(num(api.outstanding ? api.outstanding(c) : num(c.monto) - num(c.pagado))), c.vence || '-']; });
      return { title: p.title, rows: cr.length, html: docShell(p.title, (cli.nombre || cli.name) + ' · Doc. ' + maskDoc(cli.dni || cli.documento || cli.document), ['Concepto', R('Monto'), R('Pagado'), R('Pendiente'), 'Vence'], cr,
        ['Saldo (como en Clientes)', '', '', soles(saldo), ''], 'El documento del cliente se muestra oculto. Vencido: ' + soles(num(sum.overdueDebt)) + '.', business) };
    }
    if (p.tipo === 'resumen_cierre') {
      if (typeof api.cashCloses !== 'function') return unavailable(p, 'el reporte de Arqueo', business);
      // Mismo origen y cálculo que «Reporte de arqueo»: GET /auth/cash-closes + NA_REPORTE_ARQUEO.buildReport.
      var ar = await api.cashCloses(d, h), at = ar.report.totals;
      var crow = ar.report.rows.map(function (r) { return [r.fechaLabel + (r.hora ? ' ' + r.hora : ''), r.closedByName, soles(r.esperado / 100), r.contado == null ? 'sin contar' : soles(r.contado / 100), r.diferencia == null ? '-' : soles(r.diferencia / 100)]; });
      return { title: p.title, rows: crow.length, html: docShell(p.title, ar.report.range.desde + ' a ' + ar.report.range.hasta + (ar.fromServer ? ' · servidor' : ' · copia local'), ['Cierre', 'Cerró', R('Esperado'), R('Contado'), R('Diferencia')], crow,
        ['Total (' + at.count + ')', '', soles(at.esperado / 100), soles(at.contado / 100), soles(at.diferencia / 100)], (at.sinContar ? at.sinContar + ' cierre(s) sin contar no suman. ' : '') + KNOWN.caja, business) };
    }
    return unavailable(p, 'ese tipo de documento', business);
  }

  // Ejecutores: usan SOLO funciones existentes del POS, inyectadas (deps) para poder probarlos.
  var EXECUTORS = {
    compra: function (p, d) {
      var w = d.openPurchase();
      if (!w) return { ok: false, msg: 'No se pudo abrir «Nueva compra».' };
      d.fillPurchase(w, p);
      return { ok: true, msg: 'Abrí «Nueva compra» con ' + p.lineas.length + ' línea(s). Revisa y pulsa «Registrar compra».' };
    },
    precio: function (p, d) {
      var prod = (d.productos() || []).find(function (x) { return String(x.id) === String(p.product_id); });
      if (!prod) return { ok: false, msg: 'Ese producto ya no está en el inventario.' };
      d.openProductEditor(prod.id, { precio: p.precio_nuevo });
      return { ok: true, msg: 'Abrí la ficha de ' + pname(prod) + ' con el precio nuevo. Pulsa Guardar para aplicarlo.' };
    },
    costo: function (p, d) {
      var prod = (d.productos() || []).find(function (x) { return String(x.id) === String(p.product_id); });
      if (!prod) return { ok: false, msg: 'Ese producto ya no está en el inventario.' };
      d.openProductEditor(prod.id, { costo: p.costo_nuevo });
      return { ok: true, msg: 'Abrí la ficha de ' + pname(prod) + ' con el costo nuevo. Pulsa Guardar para aplicarlo.' };
    },
    ajuste: function (p, d) {
      var prod = (d.productos() || []).find(function (x) { return String(x.id) === String(p.product_id); });
      if (!prod) return { ok: false, msg: 'Ese producto ya no está en el inventario.' };
      var o = d.openStockMove(prod.id, p.tipo, p.cantidad, p.motivo);
      if (o !== true) return { ok: false, msg: typeof o === 'string' && o ? o : 'No se pudo abrir «Registrar movimiento». Ábrelo desde Inventario.' };
      return { ok: true, msg: 'Abrí «Registrar movimiento» de ' + pname(prod) + ' lleno. Revisa y pulsa Guardar.' };
    },
    producto: function (p, d) {
      if (!d.openNewProduct(p)) return { ok: false, msg: 'No se pudo abrir «Nuevo producto».' };
      return { ok: true, msg: 'Abrí «Nuevo producto» lleno. Revisa y pulsa Guardar.' };
    },
    documento: async function (p, d) { var doc = await buildDocument(p, d.data ? d.data() : {}, d.businessName && d.businessName()); d.showDocument(doc.html, p); return { ok: true, msg: 'Documento listo (' + doc.rows + ' fila(s)). No es comprobante SUNAT.' }; },
    consulta: function () { return { ok: true, msg: '' }; },
    pasos: function (p, d) { if (p.pantalla) d.navigate(p.pantalla); return { ok: true, msg: 'Te llevé a la pantalla.' }; }
  };

  // Puerta de confirmación. execute() es asíncrono:
  // 1) exige confirmed:true (solo lo pasa el botón «Confirmar»);
  // 2) revisa el rol en el aparato (segunda barrera);
  // 3) pide al Worker que gaste el token de un solo uso (deps.confirm). El token trae un operation_id
  //    creado UNA vez; si se corta la señal se reenvía el MISMO token y el Worker devuelve el mismo id;
  // 4) recién entonces llama a las funciones existentes del POS. Un doble toque comparte la misma promesa.
  // Pedido con límite de tiempo (solo para el asistente; no cambia NA_ROLES.api del resto del POS).
  // Si no responde en ms, se aborta y lanza un error con timeout=true.
  async function request(fetchImpl, url, init, ms) {
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = null, timedOut = false;
    var opts = Object.assign({}, init || {}); if (ctl) opts.signal = ctl.signal;
    var guard = new Promise(function (_, reject) { timer = setTimeout(function () { timedOut = true; if (ctl) ctl.abort(); var e = new Error('timeout'); e.timeout = true; reject(e); }, ms); });
    try {
      var r = await Promise.race([fetchImpl(url, opts), guard]);
      var data = {}; try { data = await Promise.race([r.json(), guard]); } catch (e) { if (e && e.timeout) throw e; data = {}; }
      return { status: r.status, ok: !!r.ok, data: data || {} };
    } catch (e) { if (timedOut || (e && e.name === 'AbortError')) { var t = new Error('timeout'); t.timeout = true; throw t; } throw e; }
    finally { clearTimeout(timer); }
  }
  // ---------- Respuesta en partes (chat) ----------
  // Tiempos (Bot 3): primer trozo ~10 s (si no llega nada, «Reintentar»); después, 30 s contados desde el ÚLTIMO trozo, no desde el inicio.
  var STREAM = { firstMs: 10000, idleMs: 30000, paintMs: 100 };
  // Lee «event: x / data: {...}» separados por línea en blanco. Un bloque a medias espera al siguiente trozo; un data roto se ignora.
  function createSseParser(onEvent) {
    var buf = '';
    return { feed: function (chunk) {
      buf = (buf + String(chunk || '')).replace(/\r\n/g, '\n'); var k;
      while ((k = buf.indexOf('\n\n')) >= 0) {
        var block = buf.slice(0, k), ev = 'message', data = ''; buf = buf.slice(k + 2);
        block.split('\n').forEach(function (l) { if (l.indexOf('event:') === 0) ev = l.slice(6).trim(); else if (l.indexOf('data:') === 0) data += (data ? '\n' : '') + l.slice(5).replace(/^ /, ''); });
        if (!data) continue; var j; try { j = JSON.parse(data); } catch (e) { continue; } onEvent(ev, j);
      }
    } };
  }
  // Pinta por tandas (cada ~100 ms con requestAnimationFrame), nunca letra por letra. finish() pinta lo que quede, sin perder ni repetir.
  function createTextPainter(write, o) {
    o = o || {}; var min = o.minMs == null ? STREAM.paintMs : o.minMs, now = o.now || function () { return Date.now(); };
    var sched = o.schedule || function (cb, wait) { setTimeout(function () { if (typeof requestAnimationFrame === 'function') requestAnimationFrame(cb); else cb(); }, wait); };
    var pending = '', last = -Infinity, armed = false, paints = 0, gen = 0;
    function flush(g) { if (g !== undefined && g !== gen) return; armed = false; if (!pending) return; var t = pending; pending = ''; last = now(); paints++; write(t); }
    return {
      push: function (t) { if (!t) return; pending += t; if (armed) return; armed = true; var g = gen; sched(function () { flush(g); }, Math.max(0, min - (now() - last))); },
      finish: function () { flush(); },
      reset: function () { gen++; pending = ''; armed = false; },
      paints: function () { return paints; }
    };
  }
  // Pide el chat en partes. Si el navegador o el servidor no lo soportan, vuelve el JSON de siempre (kind:'json').
  // Resultado en partes: { kind:'stream', final, error, cut, timeout:'first'|'idle'|null, text } — las tarjetas SOLO salen de final.
  async function streamChat(fetchImpl, url, init, o) {
    o = o || {}; var firstMs = o.firstMs || STREAM.firstMs, idleMs = o.idleMs || STREAM.idleMs;
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null, timer = null, timedOut = null, text = '', reader = null, giveUp = null;
    var opts = Object.assign({}, init || {}); if (ctl) opts.signal = ctl.signal;
    var res = { kind: 'stream', final: null, error: null, cut: false, timeout: null, text: '' };
    function arm(ms, kind) { clearTimeout(timer); timer = setTimeout(function () { timedOut = kind; if (ctl) ctl.abort(); if (giveUp) giveUp(new Error('timeout')); if (reader) { try { reader.cancel().catch(function () {}); } catch (e) { /* ya cortado */ } } }, ms); }
    arm(firstMs, 'first');
    var r;
    // Aunque el fetch no respete la señal, a los firstMs se deja de esperar.
    try { r = await Promise.race([fetchImpl(url, opts), new Promise(function (_, rej) { giveUp = rej; })]); giveUp = null; }
    catch (e) { clearTimeout(timer); var t = new Error(timedOut ? 'timeout' : 'network'); t.timeout = !!timedOut; t.stage = timedOut; throw t; }
    var ct = String((r.headers && r.headers.get && r.headers.get('content-type')) || '');
    if (!/text\/event-stream/.test(ct) || !r.body || typeof r.body.getReader !== 'function') {
      // Respuesta JSON (puertas de rol, foto, cupo… o servidor sin partes): el tiempo sigue corriendo hasta tener el cuerpo.
      try { var data = await r.json(); clearTimeout(timer); return { kind: 'json', status: r.status, ok: !!r.ok, data: data || {} }; }
      catch (e2) { clearTimeout(timer); if (timedOut) { var t2 = new Error('timeout'); t2.timeout = true; t2.stage = timedOut; throw t2; } return { kind: 'json', status: r.status, ok: !!r.ok, data: {} }; }
    }
    reader = r.body.getReader(); var dec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
    var parser = createSseParser(function (ev, d) {
      if (ev === 'text') { if (d.reset) { text = ''; if (o.onReset) o.onReset(); } else if (typeof d.t === 'string') { text += d.t; if (o.onText) o.onText(d.t); } }
      else if (ev === 'final') res.final = d; else if (ev === 'error') res.error = d;
    });
    // Cada trozo (incluido el «open» que el servidor manda enseguida) vuelve a armar el reloj: 30 s desde el último.
    if (timedOut) { res.cut = true; res.timeout = timedOut; res.text = text; return res; }
    try {
      for (;;) {
        var step = await reader.read();
        if (step.done) break;
        arm(idleMs, 'idle');
        parser.feed(dec ? dec.decode(step.value, { stream: true }) : String(step.value));
      }
      if (dec) parser.feed(dec.decode());
    } catch (e3) { /* corte de red o tiempo agotado: queda lo recibido */ }
    clearTimeout(timer);
    if (timedOut) res.timeout = timedOut;
    res.cut = !res.final && !res.error; res.text = text;
    return res;
  }
  var TIMEOUTS = { chat: 30000, confirm: 12000, approval: 15000 };
  // Errores en palabras simples (pedido del dueño): la persona NUNCA ve un código (403, 409, 429, 503, assistant_off, forbidden_document…).
  // Cada código conocido tiene su frase; uno desconocido o «HTTP_xxx» cae en la frase general. retry=true: se muestra «Reintentar».
  var MSG = {
    owner: 'Eso solo lo puede hacer el dueño.',
    offline: 'Sin conexión. Toca «Reintentar» cuando vuelva el internet.',
    wait: 'Espera un momento e intenta de nuevo.',
    slow: 'Está tardando mucho. Toca «Reintentar».',
    again: 'No se pudo completar. Toca «Reintentar».',
    expired: 'Esta propuesta venció. Pídela otra vez.',
    changed: 'La propuesta cambió. Pídela otra vez.'
  };
  var FRIENDLY = {
    forbidden_role: [MSG.owner], admin_only: [MSG.owner], image_owner_only: [MSG.owner], owner_approval_required: [MSG.owner], forbidden: [MSG.owner], HTTP_403: [MSG.owner],
    assistant_off: ['El asistente está apagado en este aparato.'], unauthorized: ['Este aparato no tiene sesión. Entra de nuevo al sistema.'], HTTP_401: ['Este aparato no tiene sesión. Entra de nuevo al sistema.'],
    forbidden_document: ['Ese documento es solo para el dueño. Puedes pedir la lista de precios o la lista de pedido.'],
    rate_limited: [MSG.wait, true], HTTP_429: [MSG.wait, true], upstream_busy: [MSG.wait, true],
    daily_limit: ['Por hoy ya no quedan preguntas en este aparato. Mañana sigue.'], monthly_cap: ['El asistente llegó a su tope del mes. Avisa al dueño.'],
    network: [MSG.offline, true], offline: [MSG.offline, true], timeout: [MSG.slow, true], upstream_timeout: [MSG.slow, true],
    upstream_error: [MSG.again, true], stock_check_unavailable: ['No pude revisar el inventario ahora. Toca «Reintentar» en un momento.', true], HTTP_503: [MSG.again, true], HTTP_502: [MSG.again, true], HTTP_500: [MSG.again, true],
    confirm_expired: [MSG.expired], HTTP_410: [MSG.expired], proposal_changed: [MSG.changed], proposal_id_mismatch: [MSG.changed], HTTP_409: [MSG.changed],
    product_missing: ['Ese producto ya no está en el inventario.'], sin_control_stock: ['Ese producto no controla inventario.'],
    review_required: ['Revisa este dato en las filas marcadas y vuelve a confirmar.'], over_limit: ['Fuera del límite: corrige la factura o quita la fila.'],
    empty_after_review: ['Quitaste todas las filas. Pide la compra de nuevo.'], other_device: ['Esta propuesta es de otro aparato. Pídela aquí otra vez.'],
    image_too_large: ['La foto es muy grande. Toma otra más cerca.'], bad_image: ['No pude leer esa foto. Toma otra con más luz.'],
    not_found: ['El asistente no está disponible por ahora.'], HTTP_404: ['El asistente no está disponible por ahora.'], bad_request: [MSG.again, true], bad_token: [MSG.changed]
  };
  // ¿El texto trae algo que parece código? (palabra_con_guion_bajo, «HTTP», «error 403», «Error:»). Entonces no se muestra tal cual.
  function looksTechnical(t) { return /[a-z0-9]+_[a-z0-9_]+|\berror\b|HTTP|\b(error|status|code)\b\s*:?\s*\d{3}\b|^\s*[45]\d\d\b|undefined|null|NaN|Exception|TypeError/i.test(String(t || '')); }
  function friendlyError(code, serverMsg) {
    var f = FRIENDLY[code];
    if (!f && /^HTTP_5/.test(String(code))) f = [MSG.again, true];
    if (!f && /^HTTP_4/.test(String(code))) f = [MSG.again, true];
    // Los motivos que ya vienen en palabras del servidor (tope, inventario) se usan solo si no traen nada técnico.
    var msg = serverMsg && typeof serverMsg === 'string' && !looksTechnical(serverMsg) ? serverMsg : (f ? f[0] : MSG.again);
    return { msg: msg, retry: !!(f ? f[1] : true) };
  }
  // Reintentos AUTOMÁTICOS de red al confirmar: tope fijo (1 envío + 1 reintento). Después decide la persona con «Volver a intentar».
  // Reenviar es seguro: mismo token y operation_id; si el servidor ya lo guardó responde already_confirmed y no se repite.
  var CONFIRM_ATTEMPTS = 2;
  // Qué muestra la tarjeta cuando confirm no pasa. Una tarjeta NUNCA queda trabada con «Confirmar»:
  //  - 422 review_required: filas en rojo «Revisa este dato»; se reenvía la MISMA tarjeta (un toque, sin PIN).
  //  - 429: «Espera un momento y vuelve a intentar» + «Volver a intentar» (misma tarjeta).
  //  - Siempre: «Pedir de nuevo» = propuesta NUEVA (token y operation_id nuevos).
  function confirmFailureView(r) {
    if (!r || r.ok) return null;
    var code = r.code || (r.retry ? 'network' : 'error');
    if (code === 'review_required') return { kind: 'review', rows: (r.rows || []).filter(function (n) { return Number.isInteger(n) && n >= 0; }), button: 'Confirmar', again: true, msg: 'Revisa este dato en las filas marcadas y vuelve a confirmar.' };
    if (code === 'over_limit') return { kind: 'limit', rows: (r.rows || []).filter(function (n) { return Number.isInteger(n) && n >= 0; }), button: 'Confirmar', again: true, msg: r.msg || 'Fuera del límite: corrige la factura o quita la fila.' };
    if (code === 'rate_limited' || code === 'HTTP_429') return { kind: 'wait', rows: [], button: 'Reintentar', again: true, msg: MSG.wait };
    if (code === 'network') return { kind: 'network', rows: [], button: 'Reintentar', again: true, msg: friendlyError('network').msg };
    return { kind: 'other', rows: [], button: 'Confirmar', again: true, msg: r.msg && !looksTechnical(r.msg) ? r.msg : friendlyError(code).msg };
  }

  // Contexto chico (~2 KB): primero los productos que coinciden con lo escrito, después el resto hasta el tope.
  function capContext(ctx, maxBytes, maxItems) {
    var out = [], size = 40;
    for (var i = 0; i < ctx.products.length && out.length < (maxItems || 25); i++) {
      var n = JSON.stringify(ctx.products[i]).length + 1; if (size + n > (maxBytes || 2000)) break; out.push(ctx.products[i]); size += n;
    }
    return { screen: ctx.screen, products: out };
  }

  // Mismo criterio que el POS (Inicio/Kardex): sin control = controlInventario/trackStock/track_stock/tracks_inventory en falso, o servicio.
  function tracksStock(p) {
    if (!p) return false;
    if (p.controlInventario === false || p.trackStock === false || p.track_stock === false || p.tracks_inventory === false || p.tracks_inventory === 0) return false;
    return ![p.tipo, p.type, p.unidad, p.cat].some(function (v) { return /^(servicio|service)$/i.test(String(v || '')); });
  }
  // Revisión ANTES de enviar y de gastar la tarjeta: si el POS no puede abrir la pantalla, se dice por qué y no se gasta nada.
  var PRECHECK = {
    ajuste: function (p, d) {
      var prod = (d.productos() || []).find(function (x) { return String(x.id) === String(p.product_id); });
      if (!prod) return 'Ese producto ya no está en el inventario.';
      if (!tracksStock(prod)) return '«' + pname(prod) + '» no controla inventario: no se puede registrar un movimiento de stock. Si debe controlarlo, actívalo en su ficha.';
      var why = d.stockMoveReady ? d.stockMoveReady(prod.id) : null;
      return why || null;
    },
    compra: function (p, d) {
      var list = d.productos() || [], bad = [];
      (p.lineas || []).forEach(function (l) { if (!l.product_id) return; var prod = list.find(function (x) { return String(x.id) === String(l.product_id); }); if (prod && !tracksStock(prod)) bad.push(pname(prod)); });
      return bad.length ? 'No controlan inventario: ' + bad.map(function (n) { return '«' + n + '»'; }).join(', ') + '. Quítalos de la compra o pide la compra de nuevo.' : null;
    }
  };
  function precheck(p, d) { var f = PRECHECK[p && p.type]; try { return f ? f(p, d) : null; } catch (_) { return 'No se pudo revisar la tarjeta en este aparato.'; } }
  function createGate(deps) {
    var items = Object.create(null);
    async function run(it) {
      var perm = canExecute(deps.roles(), it.p);
      if (!perm.ok) { it.state = 'denied'; return perm; }
      if (it.p.needsConfirm && deps.online && !deps.online()) { it.state = 'pending'; return { ok: false, msg: 'Asistente no disponible sin internet.' }; }
      if (it.p.needsConfirm) {
        var pre = precheck(it.p, deps); if (pre) { it.state = 'pending'; return { ok: false, code: 'precheck', msg: pre }; }
        if (!it.p.confirm_token) { it.state = 'denied'; return { ok: false, msg: 'Esta propuesta no se puede confirmar. Pídela otra vez.' }; }
        var c;
        try { c = await deps.confirm(it.p, it.review || null); } catch (e) { it.state = 'pending'; return { ok: false, retry: true, code: 'network', msg: e && e.timeout ? MSG.slow : 'Se cortó la conexión. Toca «Reintentar»: no se duplicará.' }; }
        if (!c || !c.ok) { it.state = (c && (c.error === 'confirm_expired' || c.error === 'forbidden_role' || c.error === 'admin_only' || c.error === 'proposal_changed' || c.error === 'sin_control_stock')) ? 'denied' : 'pending';
          return { ok: false, code: (c && c.error) || 'error', rows: c && Array.isArray(c.rows) ? c.rows : null, retry_after_s: c && c.retry_after_s || null, msg: friendlyError((c && c.error) || 'error', c && ['over_limit', 'sin_control_stock', 'stock_check_unavailable', 'product_missing'].indexOf(c.error) >= 0 ? c.message : null).msg }; }
        it.operationId = c.operation_id;
        // Se aplica la propuesta que el servidor verificó para ESTE token, nunca otra que esté en memoria.
        if (c.proposal) { if (c.proposal.id !== it.p.id || c.proposal.type !== it.p.type) { it.state = 'denied'; return { ok: false, msg: 'La propuesta no coincide. Pídela otra vez.' }; } it.applied = c.proposal; }
        if (c.already_confirmed && it.executed) { it.state = 'done'; return { ok: true, msg: 'Ya se hizo. No se repitió.' }; }
      }
      if (it.executed) { it.state = 'done'; return { ok: true, msg: 'Ya se hizo. No se repitió.' }; }
      try {
        var r = await EXECUTORS[it.p.type](it.applied || it.p, deps, it.operationId);
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

  // Relleno bajo la burbuja (cuenta pura, sin DOM): cuántos px taparía la burbuja a la última opción con todo desplazado abajo.
  // limit = borde de arriba de la burbuja - 12. Contenedor interno: visBottom (su borde visible de abajo) y rest (lo que le queda por desplazar).
  // Documento: vh, sy (desplazado), sh (alto total) y collapse (lo que la cabecera del POS todavía puede achicarse al desplazar).
  // Lo de debajo de la fila (sh - sy - rowBottom) no cambia al desplazar; si lo que sobra para desplazar es menor que lo que se achica
  // la cabecera, la página rebota arriba: entonces debe sobrar collapse + 24 px.
  function padOverlap(o) {
    if (o.sc) { if (o.sc.visBottom <= o.limit) return 0; return Math.max(0, o.rowBottom - o.sc.rest - o.limit); }
    var tail = o.sh - o.sy - o.rowBottom, over = (o.vh - o.limit) - tail, C = Math.max(0, o.collapse || 0);
    if (o.rowBottom + o.sy > o.limit && o.sh - o.vh < C + 24) over = Math.max(over, C + 24 - (o.sh - o.vh));
    return Math.max(0, over);
  }

  var api = { STREAM: STREAM, createSseParser: createSseParser, createTextPainter: createTextPainter, streamChat: streamChat, friendlyError: friendlyError, looksTechnical: looksTechnical, FRIENDLY: FRIENDLY, padOverlap: padOverlap, tracksStock: tracksStock, precheck: precheck, request: request, TIMEOUTS: TIMEOUTS, CONFIRM_ATTEMPTS: CONFIRM_ATTEMPTS, confirmFailureView: confirmFailureView, capContext: capContext, redactText: redactText, buildContext: buildContext, canExecute: canExecute, createGate: createGate, buildDocument: buildDocument, maskDoc: maskDoc, EXECUTORS: EXECUTORS, soles: soles, esc: esc };
  root.NA_ASISTENTE_CORE = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
