(function (root) {
  'use strict';
  // Próximamente (solo dueño). Este archivo es liviano: el registro (datos) se carga bajo demanda
  // desde js/modules/proximamente-registry.js al abrir la sección. El bloqueo vive en
  // NA_PERMISSIONS.FEATURE_LOCKS (js/config/pos-permissions.js), única fuente cliente/servidor.
  var REGISTRY_SRC = 'js/modules/proximamente-registry.js';
  var MODULES = ['Ventas', 'Caja', 'Inventario', 'Clientes', 'Comprobantes', 'Extras'];
  var PRIORITY_LABELS = { alta: 'Prioridad alta', media: 'Prioridad media', baja: 'Prioridad baja' };
  var FEATURES = null, loading = null, filters = { priority: '', query: '' }, openModules = {};
  function freeze(value) {
    if (value && typeof value === 'object') { Object.keys(value).forEach(function (key) { freeze(value[key]); }); Object.freeze(value); }
    return value;
  }
  function locked(id) {
    var p = root.NA_PERMISSIONS;
    return !(p && typeof p.featureLocked === 'function') || p.featureLocked(id);
  }
  function build(rows) {
    FEATURES = freeze((rows || []).map(function (row) {
      var copy = {}; Object.keys(row).forEach(function (key) { copy[key] = row[key]; });
      copy.enabled = !locked(row.id); copy.page = row.page || null; return copy;
    }));
    return FEATURES;
  }
  function load() {
    if (FEATURES) return Promise.resolve(FEATURES);
    if (root.NA_PROXIMAMENTE_REGISTRY) return Promise.resolve(build(root.NA_PROXIMAMENTE_REGISTRY));
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      if (!root.document) { reject(new Error('registry_unavailable')); return; }
      var script = root.document.createElement('script'); script.src = REGISTRY_SRC; script.async = true;
      script.onload = function () { resolve(build(root.NA_PROXIMAMENTE_REGISTRY)); };
      script.onerror = function () { loading = null; reject(new Error('registry_unavailable')); };
      root.document.head.appendChild(script);
    });
    return loading;
  }
  function list() { return FEATURES || []; }
  function get(id) { return list().find(function (feature) { return feature.id === id; }); }
  function isUnlocked(feature) { return !!(feature && feature.enabled && feature.page); }
  function isEnabled(id) { return isUnlocked(get(id)); }
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
  function normalize(text) { return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); }
  function matches(feature) {
    if (filters.priority && feature.priority !== filters.priority) return false;
    var q = normalize(filters.query).trim();
    return !q || normalize(feature.name + ' ' + feature.description + ' ' + feature.module).indexOf(q) >= 0;
  }
  function card(feature) {
    var unlocked = isUnlocked(feature);
    var node = element('button', 'na-prox-card' + (unlocked ? ' is-enabled' : '')); node.type = 'button'; node.dataset.featureId = feature.id;
    if (unlocked) node.appendChild(element('span','na-prox-available','Disponible'));
    if (!unlocked) node.appendChild(element('span', 'na-prox-badge', '🔒 Próximamente' + (PRIORITY_LABELS[feature.priority] ? ' · ' + PRIORITY_LABELS[feature.priority] : '')));
    if (feature.uncertain) node.appendChild(element('span', 'na-prox-tag', 'por confirmar'));
    var icon = element('span', 'na-prox-icon', feature.icon); icon.setAttribute('aria-hidden', 'true'); node.appendChild(icon);
    node.appendChild(element('span', 'na-prox-name', feature.name));
    node.appendChild(element('span', 'na-prox-description', feature.description));
    node.addEventListener('click', function () { openFeature(feature); });
    return node;
  }
  function renderSections(host) {
    host.replaceChildren();
    var shown = 0;
    ['Disponible'].concat(MODULES).forEach(function (module) {
      var items = list().filter(function (f) { return matches(f) && (module==='Disponible'?isUnlocked(f):f.module===module&&!isUnlocked(f)); });
      var rank = { alta: 0, media: 1, baja: 2 };
      items = items.slice().sort(function (a, b) { return (isUnlocked(b) - isUnlocked(a)) || ((a.priority ? rank[a.priority] : 3) - (b.priority ? rank[b.priority] : 3)); });
      if (!items.length) return;
      shown += items.length;
      var section = element('details', 'na-prox-section'); section.dataset.module = module;
      if (openModules[module] !== false) section.open = true;
      section.addEventListener('toggle', function () { openModules[module] = section.open; });
      section.appendChild(element('summary', 'na-prox-summary', module + ' (' + items.length + ')'));
      var grid = element('div', 'na-prox-grid na-prox-section-grid');
      items.forEach(function (feature) { grid.appendChild(card(feature)); });
      section.appendChild(grid); host.appendChild(section);
    });
    if (!shown) host.appendChild(element('p', 'na-prox-empty', 'No hay funciones con ese filtro.'));
  }
  function toolbar(host) {
    var bar = element('div', 'na-prox-toolbar');
    var search = element('input', 'na-prox-search'); search.type = 'search'; search.placeholder = 'Buscar función'; search.setAttribute('aria-label', 'Buscar función'); search.value = filters.query;
    search.addEventListener('input', function () { filters.query = search.value; renderSections(host); });
    bar.appendChild(search);
    var chips = element('div', 'na-prox-chips'); chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Prioridad');
    [['', 'Todas'], ['alta', 'Alta'], ['media', 'Media'], ['baja', 'Baja']].forEach(function (pair) {
      var chip = element('button', 'na-prox-chip' + (filters.priority === pair[0] ? ' is-active' : ''), pair[1]); chip.type = 'button'; chip.dataset.priority = pair[0];
      chip.setAttribute('aria-pressed', String(filters.priority === pair[0]));
      chip.addEventListener('click', function () {
        filters.priority = pair[0];
        chips.querySelectorAll('.na-prox-chip').forEach(function (c) { var on = c.dataset.priority === pair[0]; c.className = 'na-prox-chip' + (on ? ' is-active' : ''); c.setAttribute('aria-pressed', String(on)); });
        renderSections(host);
      });
      chips.appendChild(chip);
    });
    bar.appendChild(chips);
    return bar;
  }
  function render(container) {
    if (!container || !ownerAllowed()) return Promise.resolve();
    return load().then(function () {
      if (!ownerAllowed()) return;
      container.className = 'na-prox-grid na-prox-root';
      container.replaceChildren();
      var sections = element('div', 'na-prox-sections');
      container.appendChild(toolbar(sections)); container.appendChild(sections);
      renderSections(sections);
    }, function () { container.replaceChildren(element('p', 'na-prox-empty', 'No se pudo cargar la lista. Revisa la conexión e inténtalo otra vez.')); });
  }
  var api = { MODULES: MODULES, load: load, list: list, get: get, isEnabled: isEnabled, isUnlocked: isUnlocked, render: render, openPreview: openPreview, openFeature: openFeature };
  Object.defineProperty(api, 'FEATURES', { get: function () { return FEATURES; }, enumerable: true });
  root.NA_PROXIMAMENTE = Object.freeze(api);
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
