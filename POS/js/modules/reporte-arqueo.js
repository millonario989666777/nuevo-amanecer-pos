/* Arqueo de caja por fechas: proyección de solo lectura de la réplica canónica local. */
(function (root) {
  'use strict';

  var PAGE_ID = 'pageReporteArqueo';
  var DAY_MS = 86400000;
  function text(value) { return String(value == null ? '' : value); }
  function cents(value) { var n = Number(value); return Number.isSafeInteger(n) ? n : 0; }
  function validDay(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    var date = new Date(value + 'T00:00:00Z');
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
  }
  // Los timestamps de la réplica son UTC; America/Lima es UTC-5 sin horario de verano.
  function lima(value) {
    var raw = text(value);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw) || !validDay(raw.slice(0, 10))) return null;
    var ms = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : raw + 'Z').getTime();
    if (!Number.isFinite(ms)) return null;
    var local = new Date(ms - 5 * 3600000).toISOString();
    return { date: local.slice(0, 10), time: local.slice(11, 16), ms: ms };
  }
  function defaultRange() {
    var hasta = new Date(Date.now() - 5 * 3600000).toISOString().slice(0, 10);
    var desde = new Date(new Date(hasta + 'T00:00:00Z').getTime() - 29 * DAY_MS).toISOString().slice(0, 10);
    return { desde: desde, hasta: hasta };
  }
  function dateLabel(day) { return day.split('-').reverse().join('/'); }
  function name(value) { var raw = text(value); return raw.trim() ? raw : 'No registrado'; }
  function buildReport(sessions, options) {
    options = options || {};
    var defaults = defaultRange();
    var desde = options.desde === undefined ? defaults.desde : validDay(text(options.desde));
    var hasta = options.hasta === undefined ? defaults.hasta : validDay(text(options.hasta));
    if (!desde || !hasta) throw new RangeError('Selecciona fechas válidas para el reporte.');
    if (desde > hasta) throw new RangeError('La fecha Desde no puede ser posterior a Hasta.');
    var source = Array.isArray(sessions) ? sessions : sessions && sessions.cashSessions;
    var rows = (Array.isArray(source) ? source : []).filter(function (s) { return s && s.status === 'CLOSED'; }).map(function (s) {
      var closed = lima(s.closed_at), at = closed || lima(s.opened_at);
      if (!at || at.date < desde || at.date > hasta) return null;
      return { sessionId: text(s.session_id), fecha: at.date, fechaLabel: dateLabel(at.date), hora: closed ? closed.time : '',
        openedByName: name(s.opened_by_name), closedByName: name(s.closed_by_name),
        esperado: cents(s.expected_cents), contado: s.counted_cents == null ? null : cents(s.counted_cents),
        diferencia: s.difference_cents == null ? null : cents(s.difference_cents), timestamp: at.ms };
    }).filter(Boolean).sort(function (a, b) { return b.timestamp - a.timestamp || a.sessionId.localeCompare(b.sessionId); });
    var totals = { count: rows.length, esperado: 0, contado: 0, diferencia: 0, sinContar: 0 };
    rows.forEach(function (row) {
      // Los tres totales suman solo cierres contados: contado − esperado == diferencia.
      if (row.contado === null) { totals.sinContar += 1; return; }
      totals.esperado += row.esperado;
      totals.contado += row.contado;
      totals.diferencia += row.diferencia === null ? row.contado - row.esperado : row.diferencia;
    });
    return { range: { desde: desde, hasta: hasta }, rows: rows, totals: totals };
  }
  function toCsv(report) {
    function cell(value) {
      var valueText = value == null ? '' : String(value);
      // Guard de ventas-stock más salto de línea inicial: solo el texto puede ser una fórmula.
      if (typeof value === 'string' && /^[=+@\t\r\n-]/.test(valueText.replace(/^ +/, ''))) valueText = "'" + valueText;
      return /[",\r\n]/.test(valueText) ? '"' + valueText.replace(/"/g, '""') + '"' : valueText;
    }
    function amount(value) { return value === null ? null : value / 100; }
    var lines = [['Fecha cierre', 'Hora cierre', 'Abrió', 'Cerró', 'Esperado', 'Contado', 'Diferencia']];
    report.rows.forEach(function (row) {
      lines.push([row.fechaLabel, row.hora, row.openedByName, row.closedByName,
        amount(row.esperado), amount(row.contado), amount(row.diferencia)]);
    });
    lines.push(['Total', report.totals.count, report.totals.sinContar ? report.totals.sinContar + ' sin contar' : '', '', amount(report.totals.esperado), amount(report.totals.contado), amount(report.totals.diferencia)]);
    return '\uFEFF' + lines.map(function (line) {
      return line.map(function (value, column) {
        // Mantener los importes como números evita prefijar las diferencias negativas.
        return column >= 4 && typeof value === 'number' ? value.toFixed(2) : cell(value);
      }).join(',');
    }).join('\r\n') + '\r\n';
  }
  function ownerAllowed() {
    var roles = root.NA_ROLES, permissions = root.NA_PERMISSIONS;
    return !!(roles && typeof roles.isOwner === 'function' && roles.isOwner() &&
      permissions && typeof permissions.canAccessScreen === 'function' && permissions.canAccessScreen('owner', PAGE_ID));
  }
  function element(tag, className, value) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function rangeOptions(page) {
    var desde = page.querySelector('[data-ra-desde]'), hasta = page.querySelector('[data-ra-hasta]');
    return { desde: desde ? desde.value : undefined, hasta: hasta ? hasta.value : undefined };
  }
  function currentReport(page) {
    var options = rangeOptions(page);
    buildReport([], options); // Validar antes de leer la réplica.
    var client = root.NuevoAmanecerCanonical;
    return buildReport(client && typeof client.snapshot === 'function' ? client.snapshot() : {}, options);
  }
  function money(value) { return (value < 0 ? '-' : '') + 'S/ ' + (Math.abs(value) / 100).toFixed(2); }
  function difference(value) {
    return value === null ? '—' : (value > 0 ? '+' : '') + money(value) + (value > 0 ? ' (sobrante)' : value < 0 ? ' (faltante)' : '');
  }
  function diffClass(value) { return 'ra-num' + (value > 0 ? ' ra-sobrante' : value < 0 ? ' ra-faltante' : ''); }
  function updateScrollHint(page) {
    var wrap = page.querySelector('.ra-table-wrap'), hint = page.querySelector('.ra-scroll-hint');
    if (hint) hint.hidden = !wrap || !(wrap.scrollWidth > wrap.clientWidth + 1);
  }
  function render() {
    var page = root.document && root.document.getElementById(PAGE_ID);
    if (!page) return false;
    var content = page.querySelector('[data-ra-content]'), status = page.querySelector('[data-ra-status]');
    if (!content || !status) return false;
    var authorized = ownerAllowed(), controls = page.querySelector('[data-ra-controls]'), exportButton = page.querySelector('[data-ra-export]');
    if (controls) controls.hidden = !authorized;
    if (exportButton) exportButton.disabled = true;
    content.replaceChildren();
    if (!authorized) { status.textContent = 'Sin permiso. Pídele acceso al dueño.'; return false; }
    var defaults = defaultRange();
    ['desde', 'hasta'].forEach(function (key) {
      var input = page.querySelector('[data-ra-' + key + ']');
      if (input && !input.__naArqueoDefaultSet) {
        if (!input.value) input.value = defaults[key];
        input.__naArqueoDefaultSet = true;
      }
    });
    var report;
    try { report = currentReport(page); }
    catch (error) { status.textContent = error instanceof RangeError ? error.message : 'No se pudo leer el reporte de este dispositivo.'; return false; }
    if (exportButton) exportButton.disabled = false;
    status.textContent = dateLabel(report.range.desde) + ' al ' + dateLabel(report.range.hasta) + ' · hora de Lima · cierres cargados en este dispositivo';
    if (!report.rows.length) content.appendChild(element('p', 'ra-empty', 'No hay cierres de caja para este rango de fechas.'));
    var hint = element('p', 'ra-scroll-hint', 'Desliza para ver más →'); hint.hidden = true;
    content.appendChild(hint);
    var wrap = element('div', 'ra-table-wrap'); wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Arqueos de caja por fechas');
    var table = element('table', 'ra-table'); table.appendChild(element('caption', 'ra-sr-only', 'Arqueos de caja y totales del rango'));
    var head = element('thead'), tr = element('tr');
    ['Fecha cierre', 'Abrió', 'Cerró', 'Esperado', 'Contado', 'Diferencia'].forEach(function (label) {
      var th = element('th', '', label); th.scope = 'col'; tr.appendChild(th);
    });
    head.appendChild(tr); table.appendChild(head);
    var body = element('tbody');
    report.rows.forEach(function (row) {
      var line = element('tr');
      var fecha = element('th', '', row.fechaLabel); fecha.scope = 'row';
      fecha.appendChild(element('small', '', row.hora || '—')); line.appendChild(fecha);
      line.appendChild(element('td', '', row.openedByName)); line.appendChild(element('td', '', row.closedByName));
      line.appendChild(element('td', 'ra-num', money(row.esperado)));
      line.appendChild(element('td', 'ra-num', row.contado === null ? '—' : money(row.contado)));
      line.appendChild(element('td', diffClass(row.diferencia), difference(row.diferencia)));
      body.appendChild(line);
    });
    table.appendChild(body);
    var foot = element('tfoot'), total = element('tr');
    var label = element('th', '', 'Total · ' + report.totals.count + (report.totals.count === 1 ? ' cierre' : ' cierres') + (report.totals.sinContar ? ' · ' + report.totals.sinContar + ' sin contar' : ''));
    label.scope = 'row'; label.colSpan = 3; total.appendChild(label);
    [money(report.totals.esperado), money(report.totals.contado)].forEach(function (value) { total.appendChild(element('td', 'ra-num', value)); });
    total.appendChild(element('td', diffClass(report.totals.diferencia), difference(report.totals.diferencia)));
    foot.appendChild(total); table.appendChild(foot); wrap.appendChild(table); content.appendChild(wrap);
    if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(function () { updateScrollHint(page); });
    else updateScrollHint(page);
    return true;
  }
  function init() {
    var page = root.document.getElementById(PAGE_ID);
    if (!page || page.__naReporteArqueoBound) return;
    page.__naReporteArqueoBound = true;
    function update() { if (page.classList.contains('active')) render(); }
    page.addEventListener('change', update);
    page.addEventListener('input', update);
    root.addEventListener('resize', function () { updateScrollHint(page); });
    var exportButton = page.querySelector('[data-ra-export]');
    if (exportButton) exportButton.addEventListener('click', function () {
      if (!ownerAllowed()) { render(); return; }
      if (!render()) return;
      var report;
      try { report = currentReport(page); } catch (_) { return; }
      var url = root.URL.createObjectURL(new root.Blob([toCsv(report)], { type: 'text/csv;charset=utf-8' }));
      var link = element('a'); link.href = url;
      link.download = 'arqueo-caja-' + report.range.desde + '-a-' + report.range.hasta + '.csv';
      try { page.appendChild(link); link.click(); }
      finally { link.remove(); root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 1000); }
    });
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', function () { if (!ownerAllowed()) render(); else update(); });
    ['na:canonical-updated', 'focus'].forEach(function (event) { root.addEventListener(event, update); });
    update();
  }
  root.NA_REPORTE_ARQUEO = Object.freeze({ buildReport: buildReport, toCsv: toCsv, render: render });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.NA_REPORTE_ARQUEO;
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(globalThis);
