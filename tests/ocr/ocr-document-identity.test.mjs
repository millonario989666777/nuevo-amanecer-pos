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
