(function (root) {
  'use strict';
  function freeze(value) {
    if (value && typeof value === 'object') { Object.keys(value).forEach(function (key) { freeze(value[key]); }); Object.freeze(value); }
    return value;
  }
  var FEATURES = freeze([
    { id: 'creditos-vencimiento', name: 'Créditos con vencimiento por documento y cobro múltiple', description: 'Organiza vencimientos y cobra varios documentos juntos.', icon: '📅', enabled: false, page: null, preview: { type: 'table', columns: ['Documento', 'Cliente', 'Vencimiento', 'Saldo'] } },
    { id: 'gastos', name: 'Gastos (categorías y reporte)', description: 'Clasifica egresos y consulta su reporte por categoría.', icon: '🧾', enabled: false, page: null, preview: { type: 'form', fields: ['Categoría', 'Descripción', 'Importe'] } },
    { id: 'reportes', name: 'Reportes', description: 'Ventas por día, productos más vendidos, utilidad, cajero y método de pago.', icon: '📊', enabled: false, page: null, preview: { type: 'table', columns: ['Día', 'Producto', 'Ventas', 'Utilidad', 'Cajero', 'Método de pago'] } },
    { id: 'cotizaciones', name: 'Cotizaciones', description: 'Prepara propuestas de venta para tus clientes.', icon: '📋', enabled: false, page: null, preview: { type: 'form', fields: ['Cliente', 'Producto', 'Cantidad', 'Precio'] } },
    { id: 'cuentas-pagar', name: 'Cuentas por pagar a proveedores', description: 'Consulta saldos y vencimientos de tus proveedores.', icon: '🏷️', enabled: false, page: null, preview: { type: 'table', columns: ['Proveedor', 'Documento', 'Vencimiento', 'Saldo'] } },
    { id: 'compartir-pdf-whatsapp', name: 'Compartir por PDF y WhatsApp', description: 'Prepara documentos para compartir con tus clientes.', icon: '📄', enabled: false, page: null, preview: { type: 'form', fields: ['Documento', 'Cliente', 'Teléfono'] } },
    { id: 'filtro-fechas-export', name: 'Filtro de fechas con exportación', description: 'Selecciona un período y prepara la exportación de datos.', icon: '🗓️', enabled: false, page: null, preview: { type: 'form', fields: ['Desde', 'Hasta', 'Formato'] } }
  ]);
  function list() { return FEATURES; }
  function get(id) { return FEATURES.find(function (feature) { return feature.id === id; }); }
  function isEnabled(id) { var feature = get(id); return !!(feature && feature.enabled && feature.page); }
  function isUnlocked(feature) { return !!(feature && feature.enabled && feature.page); }
  function ownerAllowed() {
    return !!(root.NA_ROLES && typeof root.NA_ROLES.canConfigure === 'function' && root.NA_ROLES.canConfigure());
  }
  function element(tag, className, text) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function openPreview(id) {
    var feature = get(id);
    if (!feature || !root.document || !ownerAllowed()) return;
    var old = root.document.getElementById('naProxPreview');
    if (old) old.remove();
    var dialog = element('dialog', 'na-prox-preview');
    dialog.id = 'naProxPreview';
    dialog.setAttribute('aria-labelledby', 'naProxPreviewTitle');
    dialog.appendChild(element('p', 'na-prox-banner', 'Función en preparación, aún no guarda datos'));
    var title = element('h2', '', feature.name); title.id = 'naProxPreviewTitle'; dialog.appendChild(title);
    if (feature.preview.type === 'form') {
      var form = element('div', 'na-prox-form');
      feature.preview.fields.forEach(function (field) {
        var label = element('label', '', field);
        var input = element('input'); input.type = 'text'; input.placeholder = field; input.readOnly = true; input.disabled = true;
        label.appendChild(input); form.appendChild(label);
      });
      dialog.appendChild(form);
    } else {
      var scroll = element('div', 'na-prox-table-scroll');
      var table = element('table'); var head = element('thead'); var row = element('tr');
      feature.preview.columns.forEach(function (column) { var cell = element('th', '', column); cell.scope = 'col'; row.appendChild(cell); });
      head.appendChild(row); table.appendChild(head);
      var body = element('tbody'); var sample = element('tr');
      feature.preview.columns.forEach(function () { sample.appendChild(element('td', '', '—')); });
      body.appendChild(sample); table.appendChild(body); scroll.appendChild(table); dialog.appendChild(scroll);
    }
    var actions = element('div', 'na-prox-actions');
    var save = element('button', '', 'Guardar'); save.type = 'button'; save.disabled = true;
    var close = element('button', '', 'Cerrar'); close.type = 'button'; close.addEventListener('click', function () { dialog.close(); });
    actions.appendChild(save); actions.appendChild(close); dialog.appendChild(actions);
    dialog.addEventListener('close', function () { dialog.remove(); });
    root.document.body.appendChild(dialog); dialog.showModal();
  }
  function openFeature(feature) {
    if (isUnlocked(feature) && typeof root.goPage === 'function') {
      var open = root.document && root.document.getElementById('naProxPreview');
      if (open) open.close();
      root.goPage(feature.page);
      return;
    }
    openPreview(feature.id);
  }
  function render(container) {
    if (!container || !ownerAllowed()) return;
    container.replaceChildren();
    FEATURES.forEach(function (feature) {
      var unlocked = isUnlocked(feature);
      var card = element('button', 'na-prox-card' + (unlocked ? ' is-enabled' : '')); card.type = 'button'; card.dataset.featureId = feature.id;
      if (!unlocked) card.appendChild(element('span', 'na-prox-badge', '🔒 Próximamente'));
      var icon = element('span', 'na-prox-icon', feature.icon); icon.setAttribute('aria-hidden', 'true'); card.appendChild(icon);
      card.appendChild(element('span', 'na-prox-name', feature.name));
      card.appendChild(element('span', 'na-prox-description', feature.description));
      card.addEventListener('click', function () { openFeature(feature); }); container.appendChild(card);
    });
  }
  root.NA_PROXIMAMENTE = freeze({ FEATURES: FEATURES, list: list, get: get, isEnabled: isEnabled, isUnlocked: isUnlocked, render: render, openPreview: openPreview, openFeature: openFeature });
  if (typeof module !== 'undefined' && module.exports) module.exports = root.NA_PROXIMAMENTE;
  function init() {
    var page = root.document.getElementById('pageProximamente');
    if (!page) return;
    function update() {
      if (page.classList.contains('active')) render(page.querySelector('.na-prox-grid'));
      else { var dialog = root.document.getElementById('naProxPreview'); if (dialog) dialog.close(); }
    }
    new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    update();
  }
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init);
    else init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
