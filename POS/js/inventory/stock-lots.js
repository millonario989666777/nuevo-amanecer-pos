(function (root) {
  'use strict';
  // Pure stock-unit arithmetic shared by the canonical Worker and browser.
  function fail(code) { throw new Error(code); }
  function round(n) { return Math.round(n * 1e9) / 1e9; }
  function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s; }
  function text(s, max) { return typeof s === 'string' && s.trim().length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s); }
  function businessDate(timestamp) {
    var t = timestamp === undefined ? Date.now() : Date.parse(timestamp);
    if (!Number.isFinite(t)) fail('INVALID_LOT_DATE');
    return new Date(t - 5 * 3600000).toISOString().slice(0, 10);
  }
  function normalizeReceipts(rows, quantity) {
    if (!Array.isArray(rows) || rows.length > 100) fail('INVALID_LOTS');
    var total = 0, codes = new Set();
    var out = rows.map(function (r) {
      if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(function (k) { return ['lot_code','expiry_date','quantity'].indexOf(k) < 0; }) ||
          !text(r.lot_code, 120) || !validDate(r.expiry_date)) fail('INVALID_LOT');
      if (typeof r.quantity !== 'number' || !Number.isFinite(r.quantity) || r.quantity <= 0 || r.quantity > 1e9 || round(r.quantity) !== r.quantity) fail('INVALID_LOT_QUANTITY');
      var code = r.lot_code.trim();
      if (codes.has(code)) fail('DUPLICATE_LOT_CODE');
      codes.add(code);
      total = round(total + r.quantity);
      return { lot_code:r.lot_code.trim(), expiry_date:r.expiry_date, quantity:r.quantity };
    });
    if (!Number.isFinite(quantity) || total > quantity + 1e-9) fail('INVALID_LOT_QUANTITY');
    return out;
  }
  function validateReceiptEntry(product, rows, quantity, day) {
    var receipts = normalizeReceipts(rows, quantity), today = day || businessDate();
    var existing = new Set(lots(product || {}).map(function (r) { return r.lot_code.trim(); }));
    receipts.forEach(function (r) {
      if (r.expiry_date < today) fail('EXPIRED_LOT_RECEIPT');
      if (existing.has(r.lot_code)) fail('DUPLICATE_LOT_CODE');
    });
    return receipts;
  }
  function displayDate(day) { return validDate(day) ? day.split('-').reverse().join('/') : ''; }
  function lots(product) {
    if (Array.isArray(product.lots)) return product.lots;
    if (product.lots_json !== undefined) {
      var rows; try { rows = JSON.parse(product.lots_json); } catch (_) { fail('INVALID_LOTS'); }
      if (!Array.isArray(rows)) fail('INVALID_LOTS');
      return rows;
    }
    return [];
  }
  function compare(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
  function order(a, b) { return compare(a.expiry_date,b.expiry_date) || compare(Date.parse(a.received_at),Date.parse(b.received_at)) || compare(a.lot_id,b.lot_id); }
  function plan(stock, rows, requested, day, allowExpired) {
    if (!Number.isFinite(stock) || stock < 0 || !Number.isFinite(requested) || requested <= 0 || !validDate(day)) fail('INVALID_LOT_STOCK');
    if (requested > stock + 1e-9) fail('INSUFFICIENT_PROJECTED_STOCK');
    if (!Array.isArray(rows)) fail('INVALID_LOTS');
    var seen = new Set(), sum = 0;
    rows.forEach(function (r) {
      if (!r || !text(r.lot_id, 240) || seen.has(r.lot_id) || !text(r.lot_code,120) || !validDate(r.expiry_date) ||
          typeof r.received_at !== 'string' || !Number.isFinite(Date.parse(r.received_at)) ||
          typeof r.quantity !== 'number' || !Number.isFinite(r.quantity) || r.quantity < 0) fail('INVALID_LOT');
      seen.add(r.lot_id); sum = round(sum + r.quantity);
    });
    if (sum > stock + 1e-9) fail('LOT_STOCK_INCOHERENT');
    var unbatched = Math.max(0, round(stock - sum)), left = requested, allocations = [], expiredQuantity = 0;
    function take(id, q, expired) {
      var used = Math.min(left, q);
      if (used > 1e-9) { allocations.push({lot_id:id,quantity:round(used)}); left = round(left-used); if (expired) expiredQuantity=round(expiredQuantity+used); }
    }
    rows.filter(function (r) { return r.expiry_date >= day; }).sort(order).forEach(function (r) { take(r.lot_id,r.quantity,false); });
    take('',unbatched,false);
    if (left > 1e-9 && allowExpired !== true) fail('EXPIRED_LOTS_CONFIRMATION_REQUIRED');
    rows.filter(function (r) { return r.expiry_date < day; }).sort(order).forEach(function (r) { take(r.lot_id,r.quantity,true); });
    if (left > 1e-9) fail('INSUFFICIENT_PROJECTED_STOCK');
    return {allocations:allocations,expired_quantity:expiredQuantity,unbatched_quantity:unbatched};
  }
  function report(products, filter, day) {
    day = day || businessDate();
    if (!validDate(day) || [30,60,90,'expired'].indexOf(filter) < 0) fail('INVALID_LOT_FILTER');
    var out = [], start = Date.parse(day);
    products.forEach(function (p) {
      lots(p).forEach(function (r) {
        if (!validDate(r.expiry_date) || !(r.quantity > 0)) return;
        var days = Math.round((Date.parse(r.expiry_date)-start)/86400000);
        if (filter === 'expired' ? days < 0 : days >= 0 && days <= filter) out.push({product_id:p.product_id || p.id,name:p.name || p.nombre || '',unit:p.unit || p.unidad || 'unidad',lot_id:r.lot_id,lot_code:r.lot_code,expiry_date:r.expiry_date,quantity:r.quantity,days:days});
      });
    });
    return out.sort(function (a,b) { return compare(a.expiry_date,b.expiry_date) || compare(String(a.product_id),String(b.product_id)) || compare(a.lot_id,b.lot_id); });
  }
  var api = Object.freeze({normalizeReceipts:normalizeReceipts,validateReceiptEntry:validateReceiptEntry,displayDate:displayDate,plan:plan,report:report,lots:lots,businessDate:businessDate,validDate:validDate,round:round});
  root.NA_STOCK_LOTS = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
