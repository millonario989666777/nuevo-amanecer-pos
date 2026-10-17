/* Tesorería: proyección de turnos y movimientos ya cargados, sin red ni persistencia. */
(function (root) {
  'use strict';
  var PAGE_ID = 'pageDashboardTesoreria', DAY_MS = 86400000, renderedReport = null;
  var METHODS = ['efectivo', 'yape', 'plin', 'tarjeta', 'transferencia', 'credito', 'otros'];
  var LABELS = ['Efectivo', 'Yape', 'Plin', 'Tarjeta', 'Transferencia', 'Crédito', 'Otros'];
  function text(value) { return String(value == null ? '' : value); }
  function validDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    var date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
  }
  function limaDay(value) {
    var raw = text(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return validDay(raw);
    if (!raw) return '';
    if (typeof value === 'number' || value instanceof Date) raw = value;
    else {
      if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(raw) || !validDay(raw.slice(0, 10))) return '';
      raw = raw.replace(' ', 'T');
      if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(raw)) raw += '-05:00';
    }
    var date = new Date(raw);
    return Number.isFinite(date.getTime()) ? new Date(date.getTime() - 5 * 3600000).toISOString().slice(0, 10) : '';
  }
  function periodRange(days, now) {
    var count = Number(days) === 30 ? 30 : 7, to = limaDay(now === undefined ? Date.now() : now);
    if (!to) throw new RangeError('Fecha de referencia inválida');
    return { days: count, from: new Date(Date.parse(to + 'T00:00:00Z') - (count - 1) * DAY_MS).toISOString().slice(0, 10), to: to };
  }
  function cents(value, soles) {
    if (value == null || value === '' || typeof value === 'boolean') return null;
    var n = Number(value), result = soles ? Math.round(n * 100) : n;
    return Number.isSafeInteger(result) ? result : null;
  }
  function method(value, fallback) {
    var key = text(value).trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (key === 'cash') key = 'efectivo';
    return METHODS.indexOf(key) >= 0 ? key : key ? 'otros' : fallback;
  }
  function emptyMethods() { return Object.fromEntries(METHODS.map(function (key) { return [key, 0]; })); }
  function paymentParts(move, canonical) {
    var parts = emptyMethods();
    function add(key, value, soles) { parts[key] += cents(value, soles) || 0; }
    if (canonical && (move.cash_cents != null || move.digital_cents != null || move.credit_cents != null)) {
      add('efectivo', move.cash_cents); add('credito', move.credit_cents);
      add(method(move.digital_method, 'transferencia'), move.digital_cents);
    } else if (text(move.metodo || move.payment_method).toLowerCase() === 'mixto') {
      var d = move.detallePago || move.paymentBreakdown || {};
      add('efectivo', d.efectivo != null ? d.efectivo : d.cash != null ? d.cash : move.efectivo, true);
      METHODS.filter(function (key) { return key !== 'efectivo'; }).forEach(function (key) { add(key, d[key], true); });
      if (d.digital != null) add(method(d.digitalMethod, 'transferencia'), d.digital, true);
      if (!move.detallePago && !move.paymentBreakdown) parts.transferencia = Math.max(0, (cents(move.monto, true) || 0) - parts.efectivo);
    } else add(method(move.metodo || move.payment_method, 'efectivo'), canonical ? move.amount_cents : move.monto, !canonical);
    return parts;
  }
  function saleMovement(move, canonical) {
    if (canonical) return move.sale_id != null && move.event_type == null;
    return move.tipo === 'ing' && (move.ventaId != null || /\bventa\b/i.test(text(move.cat) + ' ' + text(move.desc)));
  }
  function reversal(move) { return move.tipo === 'egr' && move.reversal === true && move.ventaId != null && text(move.reversalOf) === text(move.ventaId); }
  function buildReport(data, options) {
    data = data || {}; options = options || {};
    var range = periodRange(options.days, options.now), canonical = Array.isArray(data.cashSessions);
    var sessions = canonical ? data.cashSessions : Array.isArray(data.cashClosures) ? data.cashClosures : [];
    var moves = canonical ? data.cashMovements : data.cajMovs;
    moves = (Array.isArray(moves) ? moves : []).filter(function (m) { return m && typeof m === 'object'; });
    var days = new Map(), sessionDays = new Map(), seenSessions = new Set(), seenMoves = new Set(), dataCount = 0;
    for (var i = 0; i < range.days; i++) {
      var day = new Date(Date.parse(range.from + 'T00:00:00Z') + i * DAY_MS).toISOString().slice(0, 10);
      days.set(day, { date: day, methods: emptyMethods(), salesMissing: false, closures: 0, uncounted: 0,
        expected: 0, counted: 0, expectedMissing: false, difference: null });
    }
    sessions.forEach(function (s) {
      if (!s || typeof s !== 'object' || (canonical && s.status !== 'OPEN' && s.status !== 'CLOSED')) return;
      var id = text(canonical ? s.session_id : s.sessionId), identity = canonical ? id : text(s.id) || id;
      if (identity && seenSessions.has(identity)) return;
      if (identity) seenSessions.add(identity);
      var day = canonical ? limaDay(s.opened_at) : limaDay(s.fechaApertura || s.timestampApertura || s.fecha);
      if (id) sessionDays.set(id, day);
      var row = days.get(day); if (!row) return;
      dataCount++;
      // Un cierre sin movimientos no prueba ventas cero: el desglose puede no estar cargado.
      if (!moves.some(function (m) {
        var sid = canonical ? m.session_id : m.sessionId;
        return sid != null ? id && text(sid) === id : limaDay(m.timestamp || m.created_at || m.fecha) === day;
      })) row.salesMissing = true;
      if (canonical && s.status !== 'CLOSED') return;
      row.closures++;
      var expected = cents(canonical ? s.expected_cents : s.esperado, !canonical);
      var counted = cents(canonical ? s.counted_cents : s.contado, !canonical);
      if (expected === null) row.expectedMissing = true; else row.expected += expected;
      if (counted === null) row.uncounted++; else row.counted += counted;
    });
    moves.forEach(function (m) {
      if (!saleMovement(m, canonical) && (canonical || !reversal(m))) return;
      var identity = text(canonical ? m.movement_id : m.id);
      if (identity && seenMoves.has(identity)) return;
      if (identity) seenMoves.add(identity);
      var sid = canonical ? m.session_id : m.sessionId;
      // Las ventas del turno se atribuyen al día de apertura; sin turno asociado, a su día Lima.
      var day = sid != null && sessionDays.has(text(sid)) ? sessionDays.get(text(sid)) : limaDay(m.timestamp || m.created_at || m.fecha);
      var row = days.get(day); if (!row) return;
      var parts = paymentParts(m, canonical), sign = !canonical && reversal(m) ? -1 : 1;
      METHODS.forEach(function (key) { row.methods[key] += sign * parts[key]; });
      dataCount++;
    });
    var rows = Array.from(days.values()).reverse().map(function (row) {
      if (!row.closures || row.expectedMissing) row.expected = null;
      if (!row.closures || row.uncounted) row.counted = null;
      row.difference = row.expected === null || row.counted === null ? null : row.counted - row.expected;
      if (row.salesMissing) row.methods = null;
      delete row.expectedMissing;
      return row;
    });
    return { range: range, rows: rows, hasData: dataCount > 0 };
  }
  function csvCell(value) {
    var raw = text(value);
    if (typeof value === 'string' && /^[=+@\t\r\n-]/.test(raw.replace(/^ +/, ''))) raw = "'" + raw;
    return /[",\r\n]/.test(raw) ? '"' + raw.replace(/"/g, '""') + '"' : raw;
  }
  function dateLabel(day) { return day.split('-').reverse().join('/'); }
  function toCsv(report) {
    var lines = [['Filtro activo', 'Últimos ' + report.range.days + ' días', report.range.from, report.range.to, 'Lima · fecha de apertura'],
      ['Fecha'].concat(LABELS, ['Esperado', 'Contado', 'Diferencia'])];
    report.rows.forEach(function (row) {
      lines.push([dateLabel(row.date)].concat(METHODS.map(function (key) { return row.methods ? row.methods[key] : null; }),
        [row.expected, row.counted, row.difference]).map(function (value, i) { return i > 0 && value !== null ? value / 100 : value; }));
    });
    return '\uFEFF' + lines.map(function (line) {
      return line.map(function (value, i) { return typeof value === 'number' && i > 0 ? value.toFixed(2) : csvCell(value); }).join(',');
    }).join('\r\n') + '\r\n';
  }
  function ownerAllowed() {
    var roles = root.NA_ROLES, permissions = root.NA_PERMISSIONS;
    return !!(roles && typeof roles.isOwner === 'function' && roles.isOwner() && permissions &&
      typeof permissions.canAccessScreen === 'function' && permissions.canAccessScreen('owner', PAGE_ID));
  }
  function element(tag, className, value) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = text(value);
    return node;
  }
  function money(value) { return (value < 0 ? '-' : '') + 'S/\u00a0' + (Math.abs(value) / 100).toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function localData() {
    var client = root.NuevoAmanecerCanonical;
    // snapshot() solo copia memoria; enabled() consulta storage y no se usa aquí.
    if (client && typeof client.snapshot === 'function') {
      var snapshot = client.snapshot();
      if (snapshot && ((Array.isArray(snapshot.cashSessions) && snapshot.cashSessions.length) ||
        (Array.isArray(snapshot.cashMovements) && snapshot.cashMovements.length))) return snapshot;
    }
    return { cashClosures: typeof cashClosures !== 'undefined' ? cashClosures : root.cashClosures,
      cajMovs: typeof cajMovs !== 'undefined' ? cajMovs : root.cajMovs };
  }
  function render() {
    renderedReport = null;
    var page = root.document && root.document.getElementById(PAGE_ID); if (!page) return false;
    var content = page.querySelector('[data-dt-content]'), status = page.querySelector('[data-dt-status]');
    if (!content || !status) return false;
    var authorized = ownerAllowed(), controls = page.querySelector('[data-dt-controls]'), exportButton = page.querySelector('[data-dt-export]');
    if (controls) controls.hidden = !authorized;
    if (exportButton) exportButton.disabled = true;
    content.replaceChildren();
    if (!authorized) { status.textContent = 'Sin permiso. Pídele acceso al dueño.'; return false; }
    var period = page.querySelector('[data-dt-period]'), report;
    try { report = buildReport(localData(), { days: period ? period.value : 7 }); }
    catch (_) { status.textContent = 'No se pudieron leer los datos de caja cargados en este dispositivo.'; return false; }
    status.textContent = dateLabel(report.range.from) + ' al ' + dateLabel(report.range.to) + ' · hora de Lima · datos cargados en este dispositivo';
    renderedReport = report;
    if (exportButton) exportButton.disabled = !report.hasData;
    if (!report.hasData) { content.appendChild(element('p', 'dt-empty', 'No hay turnos ni ventas de caja cargados para este período.')); return true; }
    if (report.rows.some(function (row) { return row.salesMissing; })) content.appendChild(element('p', 'dt-note', 'Hay turnos sin movimientos asociados; su desglose de ventas no está disponible.'));
    var wrap = element('section', 'dt-results'), table = element('table', 'dt-table');
    table.appendChild(element('caption', 'dt-sr-only', 'Tesorería diaria por fecha de apertura en Lima'));
    var head = element('thead'), headers = element('tr'), labels = ['Fecha'].concat(LABELS, ['Esperado', 'Contado', 'Diferencia']);
    labels.forEach(function (label, i) { var th = element('th', i ? 'cf-num' : '', label); th.scope = 'col'; headers.appendChild(th); });
    head.appendChild(headers); table.appendChild(head);
    var body = element('tbody');
    report.rows.forEach(function (row) {
      var line = element('tr'); line.setAttribute('data-dt-day', row.date);
      var date = element('th', '', dateLabel(row.date)); date.scope = 'row'; line.appendChild(date);
      var amounts = METHODS.map(function (key) { return row.methods ? row.methods[key] : null; }).concat([row.expected, row.counted, row.difference]);
      amounts.forEach(function (amount, i) {
        var difference = i === amounts.length - 1;
        var value = amount === null ? '—' : (difference && amount > 0 ? '+' : '') + money(amount);
        if (difference && amount < 0) value += ' (faltante)';
        if (difference && amount > 0) value += ' (sobrante)';
        var cell = element('td', 'cf-num' + (difference && amount < 0 ? ' dt-negative' : ''), value);
        cell.setAttribute('data-label', labels[i + 1]); line.appendChild(cell);
      });
      body.appendChild(line);
    });
    table.appendChild(body); wrap.appendChild(table); content.appendChild(wrap);
    return true;
  }
  function exportCsv() {
    if (!ownerAllowed()) { render(); return false; }
    // Recalcular evita exportar un filtro anterior o datos anteriores a la última sincronización.
    if (!render() || !renderedReport || !renderedReport.hasData || !ownerAllowed()) return false;
    var report = renderedReport, page = root.document.getElementById(PAGE_ID);
    var url = root.URL.createObjectURL(new root.Blob([toCsv(report)], { type: 'text/csv;charset=utf-8' }));
    var link = element('a'); link.href = url;
    link.download = 'tesoreria-' + report.range.from + '-a-' + report.range.to + '.csv';
    try { page.appendChild(link); link.click(); }
    finally { link.remove(); root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 1000); }
    return true;
  }
  function init() {
    var page = root.document.getElementById(PAGE_ID);
    if (!page || page.__naDashboardTesoreriaBound) return;
    page.__naDashboardTesoreriaBound = true;
    function update() { if (page.classList.contains('active')) render(); }
    page.addEventListener('change', update);
    var refresh = page.querySelector('[data-dt-refresh]'), exportButton = page.querySelector('[data-dt-export]');
    if (refresh) refresh.addEventListener('click', update);
    if (exportButton) exportButton.addEventListener('click', exportCsv);
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', function () { if (!ownerAllowed()) render(); else update(); });
    ['na:canonical-updated', 'na:canonical-sale-projection', 'focus'].forEach(function (event) { root.addEventListener(event, update); });
    update();
  }
  root.NA_DASHBOARD_TESORERIA = Object.freeze({ limaDay: limaDay, periodRange: periodRange, buildReport: buildReport,
    csvCell: csvCell, toCsv: toCsv, money: money, ownerAllowed: ownerAllowed, render: render, exportCsv: exportCsv, init: init });
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(globalThis);
