import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync('POS/js/modules/proximamente.js', 'utf8');
const context = vm.createContext({ module: { exports: {} } });
vm.runInContext(source, context);
const registry = context.NA_PROXIMAMENTE;
const ids = ['creditos-vencimiento', 'gastos', 'reportes', 'cotizaciones', 'cuentas-pagar', 'compartir-pdf-whatsapp', 'filtro-fechas-export'];
test('registry has seven ordered, frozen, disabled features and lookup helpers', () => {
  assert.deepEqual(Array.from(registry.FEATURES, f => f.id), ids);
  assert.equal(new Set(registry.FEATURES.map(f => f.id)).size, 7);
  assert.ok(Object.isFrozen(registry.FEATURES));
  assert.equal(context.module.exports, registry);
  assert.equal(registry.list(), registry.FEATURES);
  for (const feature of registry.list()) {
    assert.ok(Object.isFrozen(feature));
    assert.equal(feature.enabled, false);
    assert.equal(registry.get(feature.id), feature);
    assert.equal(registry.isEnabled(feature.id), false);
    assert.ok(['form', 'table'].includes(feature.preview.type));
    assert.ok(!feature.description.includes('\n'));
  }
  assert.equal(registry.get('missing'), undefined);
  assert.equal(registry.isEnabled('missing'), false);
});
test('Próximamente is explicitly owner-only and registry has no network APIs', () => {
  vm.runInContext(readFileSync('POS/js/config/pos-permissions.js', 'utf8'), context);
  const p = context.NA_PERMISSIONS;
  assert.deepEqual(Array.from(p.SCREENS.pageProximamente), ['owner']);
  assert.equal(p.canAccessScreen('owner', 'pageProximamente'), true);
  assert.equal(p.canAccessScreen('empleado', 'pageProximamente'), false);
  assert.doesNotMatch(source, /fetch|XMLHttpRequest|sendBeacon/);
});
