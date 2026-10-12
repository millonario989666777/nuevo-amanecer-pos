/*
 * CANON — carga diferida de recursos que no pintan Inicio ni sirven para vender.
 *
 * - Grupo "ocr": tesseract + catálogo de referencia (≈780 KB de JS) + 8 scripts OCR.
 *   Se cargan, en el mismo orden del documento, solo cuando el usuario toca la
 *   entrada de compras por OCR (botón "OCR compras", su selector o sus inputs).
 * - Grupo "sheetjs": SheetJS (CDN) solo al exportar o importar Excel.
 *
 * Los <script type="text/x-na-lazy" data-na-lazy="…" src="…"> de index.html son el
 * manifiesto: el navegador no los descarga ni ejecuta (tipo no JavaScript); este
 * archivo crea los <script> reales con el mismo src cuando hacen falta. Mismo
 * código compartido, otro momento de carga. No toca negocio, storage ni red CANON.
 */
(function (root) {
  'use strict';
  var doc = root && root.document;
  if (!doc || root.NuevoAmanecerLazyAssets) return;

  var SHEETJS_TIMEOUT_MS = 15000;
  var groups = {};

  function lazyTags(group) {
    return Array.prototype.slice.call(doc.querySelectorAll('script[type="text/x-na-lazy"][data-na-lazy="' + group + '"]'));
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = doc.createElement('script');
      script.src = src;
      // Scripts insertados con async=false se ejecutan en orden de inserción y se descargan en paralelo.
      script.async = false;
      script.onload = function () { resolve(src); };
      script.onerror = function () { reject(new Error('LAZY_SCRIPT_FAILED')); };
      (doc.body || doc.documentElement).appendChild(script);
    });
  }

  function mark(tags, state) {
    tags.forEach(function (tag) { try { tag.setAttribute('data-na-lazy-state', state); } catch (_) {} });
  }

  function load(group) {
    if (groups[group]) return groups[group];
    var tags = lazyTags(group);
    if (!tags.length) return Promise.resolve(false);
    mark(tags, 'loading');
    var pending = Promise.all(tags.map(function (tag) { return loadScript(tag.getAttribute('src')); }))
      .then(function () { mark(tags, 'loaded'); return true; });
    groups[group] = pending;
    pending.catch(function () {
      // Un fallo de red no deja el grupo envenenado: el siguiente intento vuelve a pedirlo.
      mark(tags, 'error');
      if (groups[group] === pending) delete groups[group];
    });
    return pending;
  }

  function loaded(group) {
    var tags = lazyTags(group);
    return tags.length > 0 && tags.every(function (tag) { return tag.getAttribute('data-na-lazy-state') === 'loaded'; });
  }

  // ---------- OCR de compras ----------
  var OCR_TRIGGER = '#pageInventario .ocr-purchase-actions, #mOcrPurchaseSource, #mOcrPurchaseReview, #ocrPurchaseStart';
  var OCR_INPUTS = { ocrPurchaseCamera: true, ocrPurchaseFile: true, ocrPurchaseDocument: true };

  function setOcrStatus(state, text) {
    var status = doc.getElementById('ocrPurchaseStatus');
    if (!status) return;
    status.dataset.state = state;
    status.textContent = text;
  }

  function onOcrIntent(event) {
    var target = event && event.target;
    if (!target || typeof target.closest !== 'function' || loaded('ocr')) return;
    if (target.closest(OCR_TRIGGER)) load('ocr').catch(function () {});
  }

  // Si el archivo llega antes que el lector, se conserva en el input y se entrega en cuanto carga.
  function onOcrInputChange(event) {
    var input = event && event.target;
    if (!input || !OCR_INPUTS[input.id] || loaded('ocr')) return;
    event.stopImmediatePropagation();
    setOcrStatus('idle', 'Preparando el lector de compras…');
    load('ocr').then(function () {
      try { input.dispatchEvent(new root.Event('change', { bubbles: true })); } catch (_) {}
    }, function () {
      setOcrStatus('error', 'No se pudo cargar el lector de compras. Revisa internet y vuelve a intentar.');
    });
  }

  doc.addEventListener('pointerdown', onOcrIntent, true);
  doc.addEventListener('click', onOcrIntent, true);
  doc.addEventListener('focusin', onOcrIntent, true);
  doc.addEventListener('change', onOcrInputChange, true);

  // ---------- SheetJS (Excel) ----------
  function ensureSheetJs() {
    if (typeof root.XLSX !== 'undefined') return Promise.resolve(true);
    return new Promise(function (resolve, reject) {
      var timer = root.setTimeout(function () { reject(new Error('SHEETJS_TIMEOUT')); }, SHEETJS_TIMEOUT_MS);
      load('sheetjs').then(function (ok) { root.clearTimeout(timer); resolve(ok); }, function (error) { root.clearTimeout(timer); reject(error); });
    });
  }

  // Las exportaciones ya tienen una salida sin SheetJS (CSV); si la librería no llega, se usa esa.
  function wrapExport(name) {
    var original = root[name];
    if (typeof original !== 'function' || original.__naLazySheetJs) return;
    var wrapped = function () {
      var self = this, args = arguments;
      if (typeof root.XLSX !== 'undefined') return original.apply(self, args);
      if (typeof root.toast === 'function') { try { root.toast('Preparando Excel…'); } catch (_) {} }
      return ensureSheetJs().then(function () { return original.apply(self, args); }, function () { return original.apply(self, args); });
    };
    wrapped.__naLazySheetJs = true;
    root[name] = wrapped;
  }

  function wrapImportReader(name) {
    var original = root[name];
    if (typeof original !== 'function' || original.__naLazySheetJs) return;
    var wrapped = async function (file) {
      var ext = file && typeof file.name === 'string' ? file.name.split('.').pop().toLowerCase() : '';
      if ((ext === 'xlsx' || ext === 'xls') && typeof root.XLSX === 'undefined') {
        try { await ensureSheetJs(); } catch (_) {}
      }
      return original.apply(this, arguments);
    };
    wrapped.__naLazySheetJs = true;
    root[name] = wrapped;
  }

  function wrapSheetJsEntryPoints() {
    ['_naF8ExportReport', '_naF9Export', 'exportProductsExcel', 'downloadProductTemplate'].forEach(wrapExport);
    wrapImportReader('_naReadProductImportFile');
  }

  // Este archivo va después de todos los scripts legacy: las funciones ya tienen su versión final
  // (incluidos los permisos de inline-07), así que el envoltorio queda por fuera de ellos.
  wrapSheetJsEntryPoints();

  root.NuevoAmanecerLazyAssets = Object.freeze({
    load: load,
    loaded: loaded,
    ensureSheetJs: ensureSheetJs,
    rewrap: wrapSheetJsEntryPoints,
  });
})(typeof window !== 'undefined' ? window : globalThis);
