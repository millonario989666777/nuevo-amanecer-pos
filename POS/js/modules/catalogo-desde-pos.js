/* Catálogo para compartir: solo lectura de productos y categorías en memoria. */
(function (root) {
  'use strict';

  var PAGE_ID = 'pageCatalogoDesdePos';
  function text(value) { return String(value == null ? '' : value).trim(); }
  function categoryKey(value) {
    return text(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function categoryTitle(key) {
    return key.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) || 'Sin categoría';
  }
  function salePrice(product) {
    var raw = product.precio;
    if (raw == null || text(raw) === '') return null;
    var value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  function money(value) {
    return 'S/\u00a0' + value.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function limaDay(now) {
    var value = now === undefined ? Date.now() : now;
    if (root.NALimaTime && typeof root.NALimaTime.parts === 'function') {
      var parts = root.NALimaTime.parts(value);
      return parts ? parts.date : '';
    }
    var date = new Date(value);
    return Number.isFinite(date.getTime()) ? new Date(date.getTime() - 5 * 3600000).toISOString().slice(0, 10) : '';
  }
  function buildCatalog(products, options) {
    options = options || {};
    var list = (Array.isArray(products) ? products : []).filter(function (p) {
      return p && typeof p === 'object' && !Array.isArray(p);
    });
    var labels = new Map();
    (Array.isArray(options.categories) ? options.categories : []).forEach(function (item) {
      var raw = typeof item === 'string' ? item : item && (item.value || item.label);
      var key = categoryKey(raw);
      if (key && !labels.has(key)) labels.set(key, typeof item === 'string' ? item : text(item.label) || categoryTitle(key));
    });
    list.forEach(function (p) {
      var key = categoryKey(p.cat);
      if (!labels.has(key)) labels.set(key, categoryTitle(key));
    });
    var category = options.category == null || options.category === '*' ? '*' : categoryKey(options.category);
    // Proyecta únicamente los tres campos públicos; no copia objetos del inventario.
    var rows = list.filter(function (p) { return category === '*' || categoryKey(p.cat) === category; }).map(function (p) {
      return { name: text(p.name || p.nombre) || 'Producto sin nombre',
        presentation: text(p.presentacion || p.presentation || p.unidad || p.unit), price: salePrice(p) };
    });
    rows.sort(function (a, b) { return a.name.localeCompare(b.name, 'es-PE'); });
    return { categories: Array.from(labels, function (pair) { return { value: pair[0], label: pair[1] }; })
      .sort(function (a, b) { return a.label.localeCompare(b.label, 'es-PE'); }), rows: rows };
  }
  function ownerAllowed() {
    return !!(root.NA_ROLES && typeof root.NA_ROLES.isOwner === 'function' && root.NA_ROLES.isOwner() &&
      root.NA_PERMISSIONS && typeof root.NA_PERMISSIONS.canAccessScreen === 'function' &&
      root.NA_PERMISSIONS.canAccessScreen('owner', PAGE_ID));
  }
  function element(tag, className, value) {
    var node = root.document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = String(value);
    return node;
  }
  function render() {
    var page = root.document && root.document.getElementById(PAGE_ID);
    if (!page) return false;
    var content = page.querySelector('[data-cdp-content]'), status = page.querySelector('[data-cdp-status]');
    var controls = page.querySelector('[data-cdp-controls]'), select = page.querySelector('[data-cdp-category]');
    var date = page.querySelector('[data-cdp-date]');
    if (!content || !status || !select || !date) return false;
    var authorized = ownerAllowed();
    if (controls) controls.hidden = !authorized;
    content.replaceChildren();
    if (!authorized) {
      select.replaceChildren(); date.textContent = '';
      status.textContent = 'Sin permiso. Pídele acceso al dueño.';
      return false;
    }
    var products = typeof productos !== 'undefined' ? productos : root.productos;
    // El helper _naAllCategories normaliza y modifica appConfig: leer sus fuentes directamente.
    var base = typeof _naBaseCategories !== 'undefined' ? _naBaseCategories : root._naBaseCategories;
    var config = typeof appConfig !== 'undefined' ? appConfig : root.appConfig;
    var categories = (Array.isArray(base) ? base : []).concat(config && Array.isArray(config.customCategories) ? config.customCategories : []);
    var selected = select.children.length ? select.value : '*';
    var catalog = buildCatalog(products, { categories: categories });
    // Conserva el filtro aunque ya no queden productos ni una categoría configurada.
    if (selected !== '*' && !catalog.categories.some(function (c) { return c.value === selected; })) {
      var previous = Array.from(select.children).find(function (option) { return option.value === selected; });
      catalog.categories.push({ value: selected, label: previous ? previous.textContent : categoryTitle(selected) });
    }
    select.replaceChildren();
    var all = element('option', '', 'Todas'); all.value = '*'; select.appendChild(all);
    catalog.categories.forEach(function (category) {
      var option = element('option', '', category.label); option.value = category.value; select.appendChild(option);
    });
    select.value = selected;
    if (selected !== '*') catalog = buildCatalog(products, { category: selected, categories: categories });
    var day = limaDay();
    date.textContent = day.split('-').reverse().join('/') + ' · Lima';
    status.textContent = '';
    if (!catalog.rows.length) {
      content.appendChild(element('p', 'cdp-empty', 'No hay productos para mostrar en esta categoría.'));
      return true;
    }
    var table = element('table', 'cdp-table');
    table.appendChild(element('caption', 'cdp-sr-only', 'Catálogo de productos y precios de venta'));
    var head = element('thead'), header = element('tr');
    ['Producto', 'Presentación', 'Precio de venta'].forEach(function (label) {
      var cell = element('th', '', label); cell.scope = 'col'; header.appendChild(cell);
    });
    head.appendChild(header); table.appendChild(head);
    var body = element('tbody');
    catalog.rows.forEach(function (row) {
      var line = element('tr'), name = element('th', '', row.name); name.scope = 'row'; line.appendChild(name);
      var presentation = element('td', '', row.presentation || '—'); presentation.setAttribute('data-label', 'Presentación'); line.appendChild(presentation);
      var price = element('td', 'cdp-price', row.price == null ? '—' : money(row.price)); price.setAttribute('data-label', 'Precio de venta'); line.appendChild(price);
      body.appendChild(line);
    });
    table.appendChild(body); content.appendChild(table);
    return true;
  }
  function printCatalog() {
    var page = root.document && root.document.getElementById(PAGE_ID);
    if (!page || !page.classList.contains('active') || !ownerAllowed() || !render()) return false;
    root.print();
    return true;
  }
  function init() {
    var page = root.document.getElementById(PAGE_ID);
    if (!page || page.__naCatalogoDesdePosBound) return;
    page.__naCatalogoDesdePosBound = true;
    function update() { if (page.classList.contains('active')) render(); }
    page.querySelector('[data-cdp-category]').addEventListener('change', update);
    page.querySelector('[data-cdp-print]').addEventListener('click', printCatalog);
    if (typeof root.MutationObserver === 'function') new root.MutationObserver(update).observe(page, { attributes: true, attributeFilter: ['class'] });
    root.addEventListener('na:role', function () { if (!ownerAllowed()) render(); else update(); });
    ['na:canonical-updated', 'focus', 'beforeprint'].forEach(function (event) { root.addEventListener(event, update); });
    update();
  }
  root.NA_CATALOGO_DESDE_POS = Object.freeze({ buildCatalog: buildCatalog, limaDay: limaDay, money: money,
    ownerAllowed: ownerAllowed, render: render, print: printCatalog, init: init });
  if (root.document) {
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})(globalThis);
