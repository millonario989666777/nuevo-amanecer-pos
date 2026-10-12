// P0-1 auditoría 2026-10-12: identidad de factura por RUC + serie-número + total.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readFileSync(path.join(ROOT, 'POS/js/ocr/ocr-purchase-integration.js'), 'utf8');
function load() { const sb = { console }; sb.globalThis = sb; vm.createContext(sb); vm.runInContext(SOURCE, sb); return sb._NA_OCR_PURCHASE_INTEGRATION; }

const PHOTO1 = 'DISTRIBUIDORA AUDITORIA SAC\nRUC 20999999991\nFACTURA ELECTRONICA F001-000123\nFecha: 12/10/2026\n6 Chocolate 22.90 137.40\nTOTAL S/ 627.00\n';
const PHOTO2 = 'DISTRIBUIDORA AUDITORIA SAC\nR.U.C.: 20999999991\nFACTURA ELECTRONICA FOO1 - 123\n6 Chocolate 22.9O 137.40\nSUBTOTAL 531.36\nTOTAL S/ 627,00\n';

test('dos fotos de la misma factura producen la misma identidad', () => {
  const api = load();
  const a = api.documentIdentity(PHOTO1), b = api.documentIdentity(PHOTO2);
  assert.equal(a.ok, true); assert.equal(a.series, 'F001-123'); assert.equal(a.ruc, '20999999991'); assert.equal(a.total, '627.00');
  assert.equal(b.ok, true); assert.equal(a.operationId, b.operationId);
  assert.match(a.operationId, /^OCR-DOC-[0-9a-f]{16}$/);
});

test('otra factura (otro número o total) tiene otra identidad', () => {
  const api = load();
  const a = api.documentIdentity(PHOTO1);
  assert.notEqual(a.operationId, api.documentIdentity(PHOTO1.replace('000123', '000124')).operationId);
  assert.notEqual(a.operationId, api.documentIdentity(PHOTO1.replace('627.00', '628.00')).operationId);
});

test('sin RUC, serie o total no hay identidad (se usa el hash del archivo)', () => {
  const api = load();
  assert.equal(api.documentIdentity('6 Chocolate 22.90 137.40\nTOTAL 137.40').ok, false);
  assert.equal(api.documentIdentity(PHOTO1.replace(/TOTAL.*\n/, '')).ok, false);
});

// Seguimiento Etapa 1: la factura repetida se confirma SOLO con el botón rojo
// «Sí, es otra compra»; un segundo toque en «Aplicar compra» no la registra.
function fakeEl(tag = 'div') {
  const el = { tag, listeners: {}, children: [], style: {}, dataset: {}, classList: { add() {}, remove() {} }, textContent: '', hidden: false, disabled: false, parentNode: null,
    addEventListener(t, f) { this.listeners[t] = f; }, removeEventListener() {}, setAttribute() {},
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    insertBefore(c) { c.parentNode = this; this.children.push(c); return c; } };
  return el;
}
test('factura ya ingresada: «Aplicar compra» repetido no duplica; solo «Sí, es otra compra» la registra como nueva', async () => {
  const sb = { console, Uint8Array, Math, Date }; sb.globalThis = sb; vm.createContext(sb); vm.runInContext(SOURCE, sb);
  const api = sb._NA_OCR_PURCHASE_INTEGRATION;
  const id = api.documentIdentity(PHOTO1);
  const footer = fakeEl();
  const elements = { status: fakeEl(), reviewStatus: fakeEl(), modal: fakeEl(), rawText: fakeEl(), review: fakeEl(), apply: fakeEl('button'), start: fakeEl('button') };
  footer.appendChild(elements.apply); footer.appendChild(elements.reviewStatus);
  const movements = [{ referenceId: id.operationId + ':0', date: '2026-10-01' }];
  const applied = [];
  const integration = api.createPurchaseOcrIntegration({
    elements, document: { createElement: (t) => fakeEl(t), getElementById: () => null },
    dependencies: {
      extract: async () => ({ ok: true, rawText: PHOTO1 }),
      process: () => ({ ok: true, proposals: [{ sourceIndex: 0 }] }),
      createReview: () => ({ getReviewedPurchaseProposals: () => [{ sourceIndex: 0, productId: 'P1', quantity: 6, decision: 'CONFIRMED' }], destroy() {} }),
      apply: async (rows, o) => { applied.push(o.operationId); return { ok: true, applied: rows, skipped: [] }; },
    },
    getProducts: () => [], getMovements: () => movements, refreshInventory() {},
  });
  integration.selectImage({ name: 'foto2.jpg', type: 'image/jpeg', size: 3, async arrayBuffer() { return new Uint8Array([9, 9, 9]).buffer; } });
  await integration.processSelectedImage();
  for (let i = 0; i < 3; i++) {
    const r = await integration.applyReviewed();
    assert.equal(r.errors[0].code, 'DOCUMENT_ALREADY_APPLIED');
  }
  assert.equal(applied.length, 0, 'tres toques en «Aplicar compra» no registran nada');
  assert.match(elements.status.textContent, /ya fue ingresada el 2026-10-01/);
  const button = footer.children.find((c) => c.id === 'ocrPurchaseDuplicateConfirm');
  assert.ok(button, 'aparece el botón propio');
  assert.equal(button.textContent, 'Sí, es otra compra');
  assert.match(button.style.cssText, /#b91c1c/);
  assert.equal(elements.reviewStatus.style.background, '#fee2e2', 'aviso en rojo');
  assert.equal(button.hidden, false);
  const r = await button.listeners.click();
  assert.equal(r.ok, true);
  assert.equal(applied.length, 1);
  assert.match(applied[0], new RegExp('^' + id.operationId + '-R'), 'compra nueva con identificador distinto');
  assert.equal(button.hidden, true);
});
