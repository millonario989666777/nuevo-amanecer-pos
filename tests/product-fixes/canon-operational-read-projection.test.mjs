import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const inline03=readFileSync('POS/js/legacy-inline/inline-03.js','utf8');
const inline10=readFileSync('POS/js/legacy-inline/inline-10.js','utf8');
const adapter=readFileSync('POS/js/adapters/canonical-ui-adapter.js','utf8');

test('CANON replaces every operational legacy array from one canonical snapshot',()=>{
  assert.match(inline03,/ventas=canonical\.sales/);
  assert.match(inline03,/cajMovs=canonical\.cashMovements/);
  assert.match(inline03,/inventoryMovements=canonical\.inventoryMovements/);
  assert.match(inline03,/cajEstado=canonical\.cashState/);
  assert.match(inline03,/ventas=\[\];gastos=\[\];cajMovs=\[\];inventoryMovements=\[\]/);
});

test('confirmed canonical sale history cannot invoke legacy annul or admin-note actions',()=>{
  // Etapa 2 (G4): una venta CANON solo se anula por el servidor (NA_ANNUL, PIN del dueño, solo con internet).
  assert.match(inline10,/!sale\.anulada&&\(!sale\.canonicalReadOnly\|\|window\.NA_ANNUL\?\.canAnnul\(sale\)\)/);
  assert.match(inline10,/CANON · solo lectura/);
  assert.match(inline10,/if\(!sale\.canonicalReadOnly\)actions\.appendChild\(_naSecButton\('f10-btn primary'/);
});

test('operational adapter does not project expenses without an explicit canonical source',()=>{
  // Los gastos ya tienen fuente canónica (0013): solo se proyectan desde data.expenses, nunca desde datos locales.
  assert.doesNotMatch(adapter,/gastos\s*:/);
  assert.match(adapter,/Array\.isArray\(data\.expenses\) \? data\.expenses : \[\]/);
  assert.doesNotMatch(adapter,/\bexpenses:(?!\s*expenses\b)/);
});
